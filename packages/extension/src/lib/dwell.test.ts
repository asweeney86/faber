import { describe, expect, test } from "bun:test";
import {
  RECENT_WINDOW_MS,
  claimRecent,
  elapsedMs,
  emptyDwell,
  forgetRecent,
  leave,
  navigate,
  nextDueIn,
  noteCalendarNav,
  setForeground,
  takeDue,
  type DwellState,
} from "./dwell";

const DWELL = 4000;
const A = "https://wiki.example.com/a";
const B = "https://wiki.example.com/b";

/** Survives a JSON round trip, like chrome.storage.session. */
const persist = (s: DwellState): DwellState => JSON.parse(JSON.stringify(s));

describe("dwell accrual", () => {
  test("a foreground tab becomes due after the dwell time", () => {
    let s = setForeground(emptyDwell(), 1, 0);
    s = navigate(s, 1, A, A, 0);
    expect(takeDue(s, 3999, DWELL).due).toHaveLength(0);
    const r = takeDue(s, 4000, DWELL);
    expect(r.due.map((d) => d.entry.url)).toEqual([A]);
    // Marked captured: not due again, and same-page navigations don't re-arm it.
    expect(takeDue(r.state, 9000, DWELL).due).toHaveLength(0);
    expect(navigate(r.state, 1, `${A}#x`, A, 9000)).toBe(r.state);
  });

  test("time in a background tab does not count", () => {
    let s = setForeground(emptyDwell(), 2, 0);
    s = navigate(s, 1, A, A, 0); // tab 1 opened in the background
    expect(s.tabs[1]!.activeSince).toBeNull();
    expect(takeDue(s, 60_000, DWELL).due).toHaveLength(0);
    expect(nextDueIn(s, 60_000, DWELL)).toBeNull();
  });

  test("switching away pauses and switching back resumes", () => {
    let s = setForeground(emptyDwell(), 1, 0);
    s = navigate(s, 1, A, A, 0);
    s = setForeground(s, 2, 3000); // 3s accrued
    expect(elapsedMs(s.tabs[1]!, 50_000)).toBe(3000);
    s = setForeground(s, 1, 50_000);
    expect(takeDue(s, 50_999, DWELL).due).toHaveLength(0);
    expect(takeDue(s, 51_000, DWELL).due).toHaveLength(1);
  });

  test("Chrome losing focus pauses everything", () => {
    let s = setForeground(emptyDwell(), 1, 0);
    s = navigate(s, 1, A, A, 0);
    s = setForeground(s, null, 1000);
    expect(takeDue(s, 100_000, DWELL).due).toHaveLength(0);
  });

  test("navigating to a different page restarts the timer and replaces metadata", () => {
    let s = setForeground(emptyDwell(), 1, 0);
    s = navigate(s, 1, A, A, 0, { referrer: "https://ref.example" });
    s = navigate(s, 1, B, B, 3000);
    expect(s.tabs[1]!.referrer).toBeUndefined();
    expect(takeDue(s, 6000, DWELL).due).toHaveLength(0);
    expect(takeDue(s, 7000, DWELL).due[0]!.entry.url).toBe(B);
  });

  test("metadata captured at first arrival is kept until capture", () => {
    let s = setForeground(emptyDwell(), 1, 0);
    s = navigate(s, 1, A, A, 0, { meeting: { title: "Billing sync" } });
    s = navigate(s, 1, `${A}#later`, A, 1000, { meeting: { title: "Other" } });
    expect(takeDue(s, 5000, DWELL).due[0]!.entry.meeting).toEqual({ title: "Billing sync" });
  });

  test("leaving cancels", () => {
    let s = setForeground(emptyDwell(), 1, 0);
    s = navigate(s, 1, A, A, 0);
    s = leave(s, 1);
    expect(takeDue(s, 10_000, DWELL).due).toHaveLength(0);
  });

  test("state survives a JSON round trip (worker suspension)", () => {
    let s = setForeground(emptyDwell(), 1, 0);
    s = navigate(s, 1, A, A, 0);
    s = persist(s);
    expect(takeDue(s, 4000, DWELL).due).toHaveLength(1);
  });

  test("nextDueIn reports the soonest active entry", () => {
    let s = setForeground(emptyDwell(), 1, 0);
    s = navigate(s, 1, A, A, 0);
    expect(nextDueIn(s, 1500, DWELL)).toBe(2500);
    expect(nextDueIn(s, 9000, DWELL)).toBe(0);
    expect(nextDueIn(emptyDwell(), 0, DWELL)).toBeNull();
  });

  test("does not mutate its input", () => {
    const s0 = setForeground(emptyDwell(), 1, 0);
    const before = JSON.stringify(s0);
    navigate(s0, 1, A, A, 0);
    setForeground(s0, 2, 10);
    expect(JSON.stringify(s0)).toBe(before);
  });
});

describe("recent captures", () => {
  test("suppresses repeats inside the window and allows them after", () => {
    let s = emptyDwell();
    let r = claimRecent(s, "k", 0);
    expect(r.ok).toBe(true);
    s = persist(r.state);
    expect(claimRecent(s, "k", 1000).ok).toBe(false);
    expect(claimRecent(s, "other", 1000).ok).toBe(true);
    r = claimRecent(s, "k", RECENT_WINDOW_MS + 1);
    expect(r.ok).toBe(true);
  });

  test("forget allows an immediate retry", () => {
    const s = forgetRecent(claimRecent(emptyDwell(), "k", 0).state, "k");
    expect(claimRecent(s, "k", 1).ok).toBe(true);
  });

  test("expired keys are pruned", () => {
    const s = claimRecent(claimRecent(emptyDwell(), "old", 0).state, "new", RECENT_WINDOW_MS + 5).state;
    expect(Object.keys(s.recent)).toEqual(["new"]);
  });
});

describe("calendar navigation", () => {
  test("is remembered per tab and cleared when the tab goes", () => {
    let s = noteCalendarNav(emptyDwell(), 7, 123);
    expect(s.calendarNav[7]).toBe(123);
    s = leave(s, 7);
    expect(s.calendarNav[7]).toBeUndefined();
  });
});
