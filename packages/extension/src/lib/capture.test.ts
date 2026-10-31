import { describe, expect, test } from "bun:test";
import { BUILTIN_RULES, normaliseWatchlist, type WatchRule } from "@faber/shared";
import {
  CALENDAR_LINK_WINDOW_MS,
  captureKey,
  extractMatches,
  isDaemonUrl,
  looksLikeCalendarEvent,
  meetingEligible,
  referrerFor,
  ruleForNavigation,
} from "./capture";

const DAEMON = "http://127.0.0.1:7777";
const DOC = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit";

function rules(enabled: string[], custom: Partial<WatchRule>[] = []): WatchRule[] {
  return normaliseWatchlist([
    ...BUILTIN_RULES.map((r) => ({ ...r, enabled: enabled.includes(r.id) })),
    ...custom.map((c, i) => ({ id: `c${i}`, label: "c", pattern: "", extractor: "generic" as const, enabled: true, builtin: false, ...c })),
  ]);
}

describe("captureKey", () => {
  test("collapses Google URL variants to the canonical doc", () => {
    expect(captureKey(`${DOC}#heading=h.123`)).toBe(DOC);
    expect(captureKey(DOC.replace("/edit", "/view?usp=sharing"))).toBe(DOC);
    expect(captureKey(DOC.replace("/document/", "/document/u/1/"))).toBe(DOC);
  });

  test("drops the fragment for other pages but keeps the query", () => {
    expect(captureKey("https://wiki.example.com/page?id=4#section")).toBe("https://wiki.example.com/page?id=4");
  });

  test("returns invalid input unchanged", () => {
    expect(captureKey("not a url")).toBe("not a url");
  });
});

describe("isDaemonUrl", () => {
  test("matches the daemon origin only", () => {
    expect(isDaemonUrl("http://127.0.0.1:7777/#/search", DAEMON)).toBe(true);
    expect(isDaemonUrl("http://127.0.0.1:8080/", DAEMON)).toBe(false);
    expect(isDaemonUrl("garbage", DAEMON)).toBe(false);
  });
});

describe("ruleForNavigation", () => {
  test("nothing is captured by default", () => {
    expect(ruleForNavigation(DOC, normaliseWatchlist([]), DAEMON)).toBeNull();
  });

  test("captures Google docs once their rule is enabled", () => {
    expect(ruleForNavigation(DOC, rules(["gdocs"]), DAEMON)?.id).toBe("gdocs");
    expect(ruleForNavigation(DOC, rules(["gslides"]), DAEMON)).toBeNull();
  });

  test("ignores Google pages that are not documents", () => {
    expect(ruleForNavigation("https://docs.google.com/document/u/0/", rules(["gdocs"]), DAEMON)).toBeNull();
  });

  test("never captures calendar pages themselves", () => {
    expect(ruleForNavigation("https://calendar.google.com/calendar/u/0/r/week", rules(["gcal"]), DAEMON)).toBeNull();
  });

  test("captures custom generic rules", () => {
    const r = rules([], [{ pattern: "wiki.example.com/team" }]);
    expect(ruleForNavigation("https://wiki.example.com/team/page", r, DAEMON)?.extractor).toBe("generic");
    expect(ruleForNavigation("https://wiki.example.com/other", r, DAEMON)).toBeNull();
  });

  test("never captures the daemon UI, non-http pages, or undefined", () => {
    const r = rules([], [{ pattern: "127.0.0.1" }]);
    expect(ruleForNavigation("http://127.0.0.1:7777/", r, DAEMON)).toBeNull();
    expect(ruleForNavigation("http://127.0.0.1:9000/page", r, DAEMON)).not.toBeNull();
    expect(ruleForNavigation("chrome://extensions", r, DAEMON)).toBeNull();
    expect(ruleForNavigation(undefined, r, DAEMON)).toBeNull();
  });
});

describe("referrerFor", () => {
  const r = rules(["gdocs"], [{ pattern: "wiki.example.com" }]);

  test("reports referrers that are themselves watched pages", () => {
    expect(referrerFor("https://wiki.example.com/team", r, DAEMON)).toBe("https://wiki.example.com/team");
    expect(referrerFor(DOC, r, DAEMON)).toBe(DOC);
  });

  test("omits unwatched referrers so unrelated browsing never reaches the daemon", () => {
    expect(referrerFor("https://mail.google.com/mail/u/0/#inbox/abc", r, DAEMON)).toBeUndefined();
    expect(referrerFor("https://www.google.com/search?q=secret", r, DAEMON)).toBeUndefined();
    expect(referrerFor(undefined, r, DAEMON)).toBeUndefined();
    expect(referrerFor("chrome://newtab", r, DAEMON)).toBeUndefined();
  });

  test("never reports the daemon UI as a referrer", () => {
    expect(referrerFor("http://127.0.0.1:7777/#/search", rules([], [{ pattern: "127.0.0.1" }]), DAEMON)).toBeUndefined();
  });
});

describe("calendar linking", () => {
  const EVENT = "https://calendar.google.com/calendar/u/0/r/eventedit/abc123";
  const WEEK = "https://calendar.google.com/calendar/u/0/r/week/2026/10/30";
  const now = 1_000_000;

  test("recognises full event pages", () => {
    expect(looksLikeCalendarEvent(EVENT)).toBe(true);
    expect(looksLikeCalendarEvent("https://calendar.google.com/calendar/event?eid=xyz")).toBe(true);
    expect(looksLikeCalendarEvent(WEEK)).toBe(false);
    expect(looksLikeCalendarEvent("https://example.com/r/eventedit/x")).toBe(false);
  });

  test("links while an event dialog is open", () => {
    expect(meetingEligible({ openerUrl: WEEK, openerNavAt: null, now, eventDialogOpen: true })).toBe(true);
  });

  test("links a doc opened shortly after navigating to an event page", () => {
    expect(meetingEligible({ openerUrl: EVENT, openerNavAt: now - 5_000, now, eventDialogOpen: false })).toBe(true);
  });

  test("does not link docs opened long after, or from a plain week view", () => {
    expect(meetingEligible({ openerUrl: EVENT, openerNavAt: now - CALENDAR_LINK_WINDOW_MS - 1, now, eventDialogOpen: false })).toBe(false);
    expect(meetingEligible({ openerUrl: EVENT, openerNavAt: null, now, eventDialogOpen: false })).toBe(false);
    expect(meetingEligible({ openerUrl: WEEK, openerNavAt: now, now, eventDialogOpen: false })).toBe(false);
  });

  test("only calendar openers count", () => {
    expect(meetingEligible({ openerUrl: "https://example.com/", openerNavAt: now, now, eventDialogOpen: true })).toBe(false);
  });
});

describe("extractMatches", () => {
  test("accepts text from the same page, ignoring the fragment", () => {
    expect(extractMatches("https://wiki.example.com/a", "https://wiki.example.com/a#top")).toBe(true);
  });

  test("rejects text read after the tab navigated elsewhere", () => {
    expect(extractMatches("https://wiki.example.com/a", "https://wiki.example.com/b")).toBe(false);
    expect(extractMatches("https://wiki.example.com/a", undefined)).toBe(false);
  });
});
