/**
 * Dwell tracking as a pure state machine over a plain object, so the
 * background worker can persist it in chrome.storage.session and pick up where
 * it left off after Chrome suspends the worker.
 *
 * A page is captured once the user has spent `dwellMs` on it while it was the
 * active tab of the focused window. Time in background tabs doesn't count.
 */

export interface PendingMeta {
  meeting?: { title: string; url?: string };
  referrer?: string;
}

export interface DwellEntry extends PendingMeta {
  key: string;
  url: string;
  /** Foreground time accumulated before `activeSince`. */
  accruedMs: number;
  /** When the tab last came to the foreground, or null while it is in the background. */
  activeSince: number | null;
  /** Already captured: further same-page navigations (e.g. #heading) don't re-arm it. */
  captured: boolean;
}

export interface DwellState {
  tabs: Record<string, DwellEntry>;
  /** captureKey → last capture time, for de-duplicating reloads and revisits. */
  recent: Record<string, number>;
  /** Calendar tab id → last navigation time, for meeting linking. */
  calendarNav: Record<string, number>;
  /** Active tab of the focused window, or null when Chrome is not focused. */
  foreground: number | null;
}

export const RECENT_WINDOW_MS = 10 * 60 * 1000;

export function emptyDwell(): DwellState {
  return { tabs: {}, recent: {}, calendarNav: {}, foreground: null };
}

function clone(s: DwellState): DwellState {
  return { tabs: { ...s.tabs }, recent: { ...s.recent }, calendarNav: { ...s.calendarNav }, foreground: s.foreground };
}

export function elapsedMs(e: DwellEntry, now: number): number {
  return e.accruedMs + (e.activeSince === null ? 0 : Math.max(0, now - e.activeSince));
}

/** A tab arrived at a watched page. Same page as before keeps the existing timer and metadata. */
export function navigate(s: DwellState, tabId: number, url: string, key: string, now: number, meta: PendingMeta = {}): DwellState {
  const cur = s.tabs[tabId];
  if (cur && cur.key === key) return s;
  const next = clone(s);
  next.tabs[tabId] = {
    key,
    url,
    accruedMs: 0,
    activeSince: s.foreground === tabId ? now : null,
    captured: false,
    ...meta,
  };
  return next;
}

/** A tab closed or moved to a page that isn't watched. */
export function leave(s: DwellState, tabId: number): DwellState {
  if (!(tabId in s.tabs) && !(tabId in s.calendarNav)) return s;
  const next = clone(s);
  delete next.tabs[tabId];
  delete next.calendarNav[tabId];
  return next;
}

/** The foreground tab changed (tab switch, window focus change, Chrome lost focus → null). */
export function setForeground(s: DwellState, tabId: number | null, now: number): DwellState {
  const next = clone(s);
  next.foreground = tabId;
  for (const [id, e] of Object.entries(s.tabs)) {
    const isFg = tabId !== null && Number(id) === tabId;
    if (isFg && e.activeSince === null) next.tabs[id] = { ...e, activeSince: now };
    else if (!isFg && e.activeSince !== null) next.tabs[id] = { ...e, accruedMs: elapsedMs(e, now), activeSince: null };
  }
  return next;
}

/** Entries that have reached the dwell threshold; they are marked captured in the returned state. */
export function takeDue(s: DwellState, now: number, dwellMs: number): { state: DwellState; due: { tabId: number; entry: DwellEntry }[] } {
  const due: { tabId: number; entry: DwellEntry }[] = [];
  let next = s;
  for (const [id, e] of Object.entries(s.tabs)) {
    if (e.captured || elapsedMs(e, now) < dwellMs) continue;
    if (next === s) next = clone(s);
    next.tabs[id] = { ...e, captured: true };
    due.push({ tabId: Number(id), entry: e });
  }
  return { state: next, due };
}

/** Milliseconds until the next entry becomes due, or null if nothing is accruing. */
export function nextDueIn(s: DwellState, now: number, dwellMs: number): number | null {
  let best: number | null = null;
  for (const e of Object.values(s.tabs)) {
    if (e.captured || e.activeSince === null) continue;
    const left = Math.max(0, dwellMs - elapsedMs(e, now));
    if (best === null || left < best) best = left;
  }
  return best;
}

/** Record a capture of `key`; returns ok=false if it was already captured within the window. */
export function claimRecent(s: DwellState, key: string, now: number, windowMs = RECENT_WINDOW_MS): { state: DwellState; ok: boolean } {
  const next = clone(s);
  for (const [k, t] of Object.entries(next.recent)) if (now - t > windowMs) delete next.recent[k];
  const last = next.recent[key];
  if (last !== undefined && now - last <= windowMs) return { state: next, ok: false };
  next.recent[key] = now;
  return { state: next, ok: true };
}

export function forgetRecent(s: DwellState, key: string): DwellState {
  if (!(key in s.recent)) return s;
  const next = clone(s);
  delete next.recent[key];
  return next;
}

export function noteCalendarNav(s: DwellState, tabId: number, now: number): DwellState {
  const next = clone(s);
  next.calendarNav[tabId] = now;
  return next;
}
