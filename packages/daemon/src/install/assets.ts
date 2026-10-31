/**
 * Keep the installed copies of the extension and the launcher app in step with the
 * running version. The daemon calls this at startup, so after `brew upgrade` the next
 * start (which the upgrade triggers, see upgrade-watch.ts) brings both along.
 *
 * Each copy is replaced atomically: the new one is written next to it and renamed into
 * place, so a crash mid-update leaves the previous version working, never half of each.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

export type SyncResult = "installed" | "updated" | "current" | "absent" | "unavailable";

const STAMP = ".faber-install.json";

interface Stamp {
  version: string | null;
  hash: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === STAMP) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Content hash of a directory tree: same files, same bytes, same hash. */
export function treeHash(dir: string): string {
  const h = createHash("sha256");
  for (const file of walk(dir)) {
    h.update(relative(dir, file));
    h.update("\0");
    h.update(new Uint8Array(readFileSync(file)));
    h.update("\0");
  }
  return h.digest("hex");
}

function readStamp(dir: string): Stamp | null {
  try {
    return JSON.parse(readFileSync(join(dir, STAMP), "utf8")) as Stamp;
  } catch {
    return null;
  }
}

export function extensionVersion(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export function appVersion(app: string): string | null {
  try {
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

function copyTree(src: string, dest: string) {
  if (process.platform === "darwin") {
    // ditto keeps everything a signed app bundle needs (modes, symlinks, extended attributes).
    execFileSync("ditto", [src, dest]);
  } else {
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  }
}

/** Put a copy of `src` at `dest`, swapping it in with renames. */
function replaceTree(src: string, dest: string, stamp: Stamp) {
  mkdirSync(dirname(dest), { recursive: true });
  const tag = `${process.pid}-${Date.now()}`;
  const next = `${dest}.new-${tag}`;
  const old = `${dest}.old-${tag}`;
  rmSync(next, { recursive: true, force: true });
  copyTree(src, next);
  writeFileSync(join(next, STAMP), JSON.stringify(stamp));
  const had = existsSync(dest);
  if (had) renameSync(dest, old);
  try {
    renameSync(next, dest);
  } catch (err) {
    if (had) renameSync(old, dest);
    rmSync(next, { recursive: true, force: true });
    throw err;
  }
  if (had) rmSync(old, { recursive: true, force: true });
}

/**
 * Undo what a crash mid-swap left behind: if `dest` is missing but the copy it was
 * renamed to is still there, put it back; then drop leftover temp copies.
 */
export function recoverInterruptedSwap(dest: string) {
  const dir = dirname(dest);
  if (!existsSync(dir)) return;
  const base = basename(dest);
  const siblings = readdirSync(dir).filter((n) => n.startsWith(`${base}.old-`) || n.startsWith(`${base}.new-`));
  if (!existsSync(dest)) {
    const old = siblings.filter((n) => n.startsWith(`${base}.old-`)).sort().pop();
    if (old) renameSync(join(dir, old), dest);
  }
  for (const n of siblings) if (existsSync(join(dir, n))) rmSync(join(dir, n), { recursive: true, force: true });
}

/**
 * Make `dest` a copy of `src`.
 *  - `install: false` only updates a copy that is already there (the daemon at startup);
 *  - `install: true` also creates it (faber setup).
 */
export function syncTree(src: string | null, dest: string, opts: { install: boolean; version: (dir: string) => string | null }): SyncResult {
  recoverInterruptedSwap(dest);
  if (!src) return "unavailable";
  const had = existsSync(dest);
  if (!had && !opts.install) return "absent";
  const hash = treeHash(src);
  const current = had ? readStamp(dest) : null;
  if (current?.hash === hash) return "current";
  replaceTree(src, dest, { version: opts.version(src), hash });
  return had ? "updated" : "installed";
}

export function syncExtension(src: string | null, dest: string, install = false): SyncResult {
  return syncTree(src, dest, { install, version: extensionVersion });
}

export function syncLauncher(src: string | null, dest: string, install = false): SyncResult {
  if (process.platform !== "darwin") return "unavailable";
  // Only ever replace our own app.
  if (existsSync(dest) && !isOurApp(dest)) return "unavailable";
  return syncTree(src, dest, { install, version: appVersion });
}

function isOurApp(app: string): boolean {
  try {
    return readFileSync(join(app, "Contents", "Info.plist"), "utf8").includes("<string>dev.faber.launcher</string>");
  } catch {
    return false;
  }
}
