import { DEFAULT_DAEMON_URL, normaliseWatchlist, type WatchRule } from "@faber/shared";
import { emptyDwell, type DwellState } from "./dwell";
import type { QueuedCapture } from "./queue";

/** Thin typed wrappers over chrome.storage. Durable state in `local`; worker scratch state in `session`. */

export interface ExtConfig {
  daemonUrl: string;
  dwellSeconds: number;
}

export interface SyncState {
  at: number;
  ok: boolean;
  error?: string;
  /** The daemon is up but has not approved this extension yet. */
  pairing?: boolean;
}

export interface BackfillState {
  at: number;
  fetched: number;
  failed: number;
}

interface LocalShape {
  config: ExtConfig;
  watchlist: WatchRule[];
  queue: QueuedCapture[];
  lastSync: SyncState | null;
  lastBackfill: BackfillState | null;
  /** Backfill is paused until this time after Google rate-limited us. */
  backfillCooldownUntil: number;
  /** Daemon version we last reloaded for, after it updated our files (lib/selfupdate.ts). */
  reloadedFor: string | null;
}

interface SessionShape {
  dwell: DwellState;
}

export const DEFAULT_CONFIG: ExtConfig = { daemonUrl: DEFAULT_DAEMON_URL, dwellSeconds: 4 };
export const MAX_DWELL_SECONDS = 60;

const LOCAL_DEFAULTS: LocalShape = {
  config: DEFAULT_CONFIG,
  watchlist: normaliseWatchlist([]),
  queue: [],
  lastSync: null,
  lastBackfill: null,
  backfillCooldownUntil: 0,
  reloadedFor: null,
};

export async function getItem<K extends keyof LocalShape>(key: K): Promise<LocalShape[K]> {
  const res = await chrome.storage.local.get(key);
  const v = res[key] as LocalShape[K] | undefined;
  if (v === undefined) return LOCAL_DEFAULTS[key];
  if (key === "config") return { ...DEFAULT_CONFIG, ...(v as ExtConfig) } as LocalShape[K];
  if (key === "queue") return migrateQueue(v) as unknown as LocalShape[K];
  return v;
}

/** Queues written by older versions held bare CaptureRequests; wrap them. */
export function migrateQueue(v: unknown): QueuedCapture[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): QueuedCapture[] => {
    if (!x || typeof x !== "object") return [];
    if ("req" in x && "id" in x) return [x as QueuedCapture];
    if ("url" in x) return [{ id: crypto.randomUUID(), req: x as QueuedCapture["req"], attempts: 0 }];
    return [];
  });
}

export async function setItem<K extends keyof LocalShape>(key: K, value: LocalShape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSession<K extends keyof SessionShape>(key: K): Promise<SessionShape[K]> {
  const res = await chrome.storage.session.get(key);
  return (res[key] as SessionShape[K] | undefined) ?? emptyDwell();
}

export async function setSession<K extends keyof SessionShape>(key: K, value: SessionShape[K]): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export function clampDwell(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_CONFIG.dwellSeconds;
  return Math.min(MAX_DWELL_SECONDS, Math.max(0, Math.round(seconds)));
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Normalise a user-typed daemon address: add http://, drop any path. Only
 * loopback hosts are accepted: page text must never leave this machine.
 */
export function normaliseDaemonUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!LOOPBACK.has(u.hostname.toLowerCase())) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
