import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseGoogleUrl } from "@faber/shared";
import { recordVisit } from "../docs";
import { enqueueEnrichment } from "../enrich/queue";

export interface ChromeProfile {
  dir: string;
  name: string;
  account: string;
  historyPath: string;
  lastUsed: number;
}

export function chromeUserDataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/Google/Chrome");
  if (process.platform === "linux") return join(homedir(), ".config/google-chrome");
  return join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/User Data");
}

export function listChromeProfiles(userDataDir = chromeUserDataDir()): ChromeProfile[] {
  const localState = join(userDataDir, "Local State");
  if (!existsSync(localState)) return [];
  const state = JSON.parse(readFileSync(localState, "utf8")) as {
    profile?: { info_cache?: Record<string, { name?: string; user_name?: string; gaia_name?: string }> };
  };
  const out: ChromeProfile[] = [];
  for (const [dir, info] of Object.entries(state.profile?.info_cache ?? {})) {
    const historyPath = join(userDataDir, dir, "History");
    if (!existsSync(historyPath)) continue;
    out.push({
      dir,
      name: info.name ?? dir,
      account: info.user_name ?? info.gaia_name ?? "",
      historyPath,
      lastUsed: statSync(historyPath).mtimeMs,
    });
  }
  return out.sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Match by directory name or display name (case-insensitive); most recently used wins. */
export function resolveProfile(query: string | undefined, profiles = listChromeProfiles()): ChromeProfile {
  if (profiles.length === 0) throw new Error("No Chrome profiles found");
  if (!query) return profiles[0]!;
  const q = query.toLowerCase();
  const byDir = profiles.find((p) => p.dir.toLowerCase() === q);
  if (byDir) return byDir;
  let matches = profiles.filter((p) => p.name.toLowerCase() === q || p.account.toLowerCase() === q);
  if (matches.length === 0) matches = profiles.filter((p) => p.name.toLowerCase().includes(q) || p.account.toLowerCase().includes(q));
  if (matches.length > 1) {
    throw new Error(
      `"${query}" matches several Chrome profiles; pass the directory instead: ${matches.map((p) => `--profile "${p.dir}" (${p.name}${p.account ? `, ${p.account}` : ""})`).join(", ")}`,
    );
  }
  const hit = matches[0];
  if (!hit) {
    throw new Error(`No Chrome profile matches "${query}". Available: ${profiles.map((p) => `${p.dir} (${p.name})`).join(", ")}`);
  }
  return hit;
}

export interface ChromeVisit {
  url: string;
  title: string;
  ts: number;
}

/** Chrome stores microseconds since 1601-01-01. */
const chromeTimeToMs = (t: number) => Math.round(t / 1000 - 11_644_473_600_000);

/**
 * Read docs.google.com visits from a Chrome History file. Chrome holds a lock on
 * it, so we copy it (plus its write-ahead log, which holds recent visits) into a
 * private temp dir and delete the copy afterwards: it is your whole browsing history.
 */
export function readGoogleDocVisits(historyPath: string): ChromeVisit[] {
  const dir = mkdtempSync(join(tmpdir(), "faber-history-"));
  const tmp = join(dir, "History");
  copyFileSync(historyPath, tmp);
  for (const suffix of ["-wal", "-journal"]) {
    if (existsSync(historyPath + suffix)) copyFileSync(historyPath + suffix, tmp + suffix);
  }
  const hdb = new Database(tmp, { readonly: true });
  try {
    const rows = hdb
      .query<{ url: string; title: string; visit_time: number }, []>(
        `SELECT u.url, u.title, v.visit_time FROM visits v JOIN urls u ON u.id = v.url
         WHERE u.url LIKE 'https://docs.google.com/%' ORDER BY v.visit_time`,
      )
      .all();
    return rows
      .filter((r) => parseGoogleUrl(r.url) !== null)
      .map((r) => ({ url: r.url, title: r.title, ts: chromeTimeToMs(r.visit_time) }));
  } finally {
    hdb.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ImportResult {
  visits: number;
  docs_created: number;
  docs_total: number;
}

export function importChromeHistory(db: Database, historyPath: string, opts: { dryRun?: boolean } = {}): ImportResult {
  const visits = readGoogleDocVisits(historyPath);
  if (opts.dryRun) {
    const uniq = new Set(visits.map((v) => parseGoogleUrl(v.url)!.canonicalUrl));
    return { visits: visits.length, docs_created: uniq.size, docs_total: uniq.size };
  }
  let created = 0;
  const touched = new Set<string>();
  db.transaction(() => {
    for (const v of visits) {
      const r = recordVisit(db, { url: v.url, title: v.title, ts: v.ts, origin: "chrome-history" });
      if (r.created) created++;
      touched.add(r.row.id);
    }
    for (const id of touched) enqueueEnrichment(db, id);
  })();
  return { visits: visits.length, docs_created: created, docs_total: touched.size };
}
