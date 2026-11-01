import type { Database } from "bun:sqlite";
import {
  BUILTIN_RULES,
  normaliseAppearance,
  normalisePattern,
  normaliseShortcut,
  normaliseShortcuts,
  normaliseWatchlist,
  type Appearance,
  type Settings,
  type SettingsUpdate,
  type Shortcuts,
  type WatchRule,
} from "@faber/shared";
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
    shortcuts: normaliseShortcuts(getSetting<Shortcuts>(db, "shortcuts")),
  };
}

export class SettingsValidationError extends Error {}

/**
 * Validate and store any subset of settings. Built-in watch rules keep their
 * definitions; only `enabled` is taken from input. Appearance is normalised
 * (unknown values fall back to defaults).
 */
export function saveSettings(db: Database, input: SettingsUpdate): Settings {
  if (!input || typeof input !== "object" || (input.watchlist === undefined && input.appearance === undefined && input.shortcuts === undefined)) {
    throw new SettingsValidationError("nothing to save: send watchlist, appearance and/or shortcuts");
  }
  // All or nothing: a rejected watchlist must not leave a new appearance behind.
  db.transaction(() => {
    if (input.watchlist !== undefined) saveWatchlist(db, input.watchlist);
    if (input.appearance !== undefined) putSetting(db, "appearance", normaliseAppearance(input.appearance));
    if (input.shortcuts !== undefined) saveShortcuts(db, input.shortcuts);
  })();
  return getSettings(db);
}

/** Merge into the stored shortcuts: each field given replaces that field only. */
function saveShortcuts(db: Database, input: Partial<Shortcuts>) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettingsValidationError("shortcuts must be an object");
  if (input.launcher != null && !normaliseShortcut(input.launcher)) {
    throw new SettingsValidationError(`"${String(input.launcher)}" isn't a shortcut Faber can use: hold ⌘, ⌃, ⌥ or ⇧ and press a letter, number, Space, an arrow or an F-key`);
  }
  const current = normaliseShortcuts(getSetting<Shortcuts>(db, "shortcuts"));
  putSetting(db, "shortcuts", normaliseShortcuts({ ...current, ...input }));
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
