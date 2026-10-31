import type { Database } from "bun:sqlite";
import { BUILTIN_RULES, normaliseAppearance, normalisePattern, normaliseWatchlist, type Appearance, type Settings, type SettingsUpdate, type WatchRule } from "@faber/shared";
import { now } from "./db";

function getSetting<T>(db: Database, key: string): T | null {
  const row = db.query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? (JSON.parse(row.value) as T) : null;
}

function putSetting(db: Database, key: string, value: unknown) {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), now()],
  );
}

export function getSettings(db: Database): Settings {
  return {
    watchlist: normaliseWatchlist(getSetting<WatchRule[]>(db, "watchlist")),
    appearance: normaliseAppearance(getSetting<Appearance>(db, "appearance")),
  };
}

export class SettingsValidationError extends Error {}

/**
 * Validate and store any subset of settings. Built-in watch rules keep their
 * definitions; only `enabled` is taken from input. Appearance is normalised
 * (unknown values fall back to defaults).
 */
export function saveSettings(db: Database, input: SettingsUpdate): Settings {
  if (!input || typeof input !== "object" || (input.watchlist === undefined && input.appearance === undefined)) {
    throw new SettingsValidationError("nothing to save: send watchlist and/or appearance");
  }
  // All or nothing: a rejected watchlist must not leave a new appearance behind.
  db.transaction(() => {
    if (input.watchlist !== undefined) saveWatchlist(db, input.watchlist);
    if (input.appearance !== undefined) putSetting(db, "appearance", normaliseAppearance(input.appearance));
  })();
  return getSettings(db);
}

function saveWatchlist(db: Database, watchlist: WatchRule[]) {
  if (!Array.isArray(watchlist)) throw new SettingsValidationError("watchlist must be an array");
  const input = { watchlist };
  const seen = new Set<string>();
  const patterns = new Map<string, string>();
  for (const r of input.watchlist) {
    if (!r || typeof r.id !== "string" || !r.id) throw new SettingsValidationError("every rule needs an id");
    if (seen.has(r.id)) throw new SettingsValidationError(`duplicate rule id ${r.id}`);
    seen.add(r.id);
    if (BUILTIN_RULES.some((b) => b.id === r.id)) continue;
    const norm = normalisePattern(String(r.pattern ?? ""));
    if (!norm) {
      throw new SettingsValidationError(
        `invalid pattern "${r.pattern}" — use a host like "wiki.example.com" or "*.example.com/path" (whole top-level domains aren't allowed)`,
      );
    }
    const dup = patterns.get(norm);
    if (dup) throw new SettingsValidationError(`"${r.pattern}" duplicates the rule "${dup}"`);
    patterns.set(norm, String(r.label || r.pattern));
  }
  const clean = normaliseWatchlist(
    input.watchlist.map((r) => ({
      id: r.id,
      label: String(r.label ?? r.pattern ?? "").slice(0, 80) || String(r.pattern),
      pattern: String(r.pattern ?? "").trim(),
      extractor: r.extractor,
      enabled: Boolean(r.enabled),
      builtin: Boolean(r.builtin),
    })),
  );
  putSetting(db, "watchlist", clean);
}
