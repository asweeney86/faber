import type { Database } from "bun:sqlite";
import type { ExtensionAccess } from "@faber/shared";
import { now } from "./db";

/**
 * Extension pairing. Any installed Chrome extension can send requests to
 * localhost, so the daemon only serves extensions the user has approved (in
 * the web UI or with `faber extensions approve`). Unknown extensions are recorded
 * as pending so the UI can offer to approve them.
 */

interface Stored {
  approved: { id: string; approved_at: number; last_seen_at: number | null }[];
  pending: { id: string; first_seen_at: number; last_seen_at: number }[];
  /** Requests the user turned down: remembered so they don't come back on every call. */
  dismissed: { id: string; dismissed_at: number }[];
}

const KEY = "extensions";
const MAX_PENDING = 20;
export const EXTENSION_ID_RE = /^[a-p]{32}$|^[a-z0-9]{8,64}$/;

function load(db: Database): Stored {
  const row = db.query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`).get(KEY);
  const s = row ? (JSON.parse(row.value) as Partial<Stored>) : {};
  return { approved: s.approved ?? [], pending: s.pending ?? [], dismissed: s.dismissed ?? [] };
}

function save(db: Database, s: Stored) {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(s), now()],
  );
}

export function isExtensionApproved(db: Database, id: string): boolean {
  return load(db).approved.some((a) => a.id === id);
}

/** Note a request from an unapproved extension so the user can approve it. */
export function recordPendingExtension(db: Database, id: string) {
  if (!EXTENSION_ID_RE.test(id)) return;
  const s = load(db);
  if (s.approved.some((a) => a.id === id) || s.dismissed.some((d) => d.id === id)) return;
  const t = now();
  const p = s.pending.find((x) => x.id === id);
  if (p) {
    // Avoid rewriting settings on every request from a pending extension.
    if (t - p.last_seen_at < 60_000) return;
    p.last_seen_at = t;
  } else {
    s.pending.unshift({ id, first_seen_at: t, last_seen_at: t });
    s.pending = s.pending.slice(0, MAX_PENDING);
  }
  save(db, s);
}

/** Touch last_seen for an approved extension (at most once a minute). */
export function touchExtension(db: Database, id: string) {
  const s = load(db);
  const a = s.approved.find((x) => x.id === id);
  if (!a) return;
  const t = now();
  if (a.last_seen_at !== null && t - a.last_seen_at < 60_000) return;
  a.last_seen_at = t;
  save(db, s);
}

export function approveExtension(db: Database, id: string): boolean {
  if (!EXTENSION_ID_RE.test(id)) return false;
  const s = load(db);
  s.pending = s.pending.filter((p) => p.id !== id);
  s.dismissed = s.dismissed.filter((d) => d.id !== id);
  if (!s.approved.some((a) => a.id === id)) s.approved.push({ id, approved_at: now(), last_seen_at: null });
  save(db, s);
  return true;
}

/** Turn down a request (or revoke access) and remember it: the extension stays refused without asking again. */
export function dismissExtension(db: Database, id: string): boolean {
  if (!EXTENSION_ID_RE.test(id)) return false;
  const s = load(db);
  s.pending = s.pending.filter((p) => p.id !== id);
  s.approved = s.approved.filter((a) => a.id !== id);
  if (!s.dismissed.some((d) => d.id === id)) s.dismissed.unshift({ id, dismissed_at: now() });
  s.dismissed = s.dismissed.slice(0, 50);
  save(db, s);
  return true;
}

/** Forget an extension entirely (approved, pending or dismissed): if it calls again it shows up as a new request. */
export function removeExtension(db: Database, id: string): boolean {
  const s = load(db);
  const before = s.approved.length + s.pending.length + s.dismissed.length;
  s.approved = s.approved.filter((a) => a.id !== id);
  s.pending = s.pending.filter((p) => p.id !== id);
  s.dismissed = s.dismissed.filter((d) => d.id !== id);
  save(db, s);
  return s.approved.length + s.pending.length + s.dismissed.length < before;
}

export function listExtensions(db: Database, fromConfig: string[] = []): ExtensionAccess[] {
  const s = load(db);
  return [
    ...fromConfig.map((id) => ({ id, state: "config" as const, since: null, last_seen_at: null })),
    ...s.approved
      .filter((a) => !fromConfig.includes(a.id))
      .map((a) => ({ id: a.id, state: "approved" as const, since: a.approved_at, last_seen_at: a.last_seen_at })),
    ...s.pending.map((p) => ({ id: p.id, state: "pending" as const, since: p.first_seen_at, last_seen_at: p.last_seen_at })),
    ...s.dismissed.map((d) => ({ id: d.id, state: "dismissed" as const, since: d.dismissed_at, last_seen_at: null })),
  ];
}
