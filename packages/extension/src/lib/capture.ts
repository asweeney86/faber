import { matchWatchRule, parseGoogleUrl, type WatchRule } from "@faber/shared";

/**
 * Pure capture decisions. The background script feeds tab events in; these
 * functions decide whether, when and how a page should be recorded.
 */

/** Identity used to de-duplicate captures: Google docs collapse to their canonical URL, other pages drop the fragment. */
export function captureKey(rawUrl: string): string {
  const g = parseGoogleUrl(rawUrl);
  if (g) return g.canonicalUrl;
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/** True when the URL belongs to the daemon itself (its web UI), which must never be captured. */
export function isDaemonUrl(rawUrl: string, daemonUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === new URL(daemonUrl).origin;
  } catch {
    return false;
  }
}

/** The watch rule a navigation should be captured under, or null to ignore it. */
export function ruleForNavigation(rawUrl: string | undefined, rules: readonly WatchRule[], daemonUrl: string): WatchRule | null {
  if (!rawUrl || !/^https?:/i.test(rawUrl)) return null;
  if (isDaemonUrl(rawUrl, daemonUrl)) return null;
  const rule = matchWatchRule(rawUrl, rules);
  if (!rule) return null;
  // Calendar is watched only to link docs to meetings; calendar pages themselves are not documents.
  if (rule.extractor === "gcal") return null;
  // Google rules only capture real documents, not Drive home pages or "create new" screens.
  if (rule.extractor !== "generic" && !parseGoogleUrl(rawUrl)) return null;
  return rule;
}

/**
 * The referrer to report for a visit: only when it is itself a page the user
 * chose to watch, so unrelated browsing (search results, chat, mail) never
 * reaches the daemon.
 */
export function referrerFor(openerUrl: string | undefined, rules: readonly WatchRule[], daemonUrl: string): string | undefined {
  if (!openerUrl || !/^https?:/i.test(openerUrl) || isDaemonUrl(openerUrl, daemonUrl)) return undefined;
  return matchWatchRule(openerUrl, rules) ? openerUrl : undefined;
}

// ---------- calendar linking ----------

/** How long after the calendar tab last navigated a doc opened from it still counts as "from that event". */
export const CALENDAR_LINK_WINDOW_MS = 30_000;

export function isCalendarUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    return new URL(rawUrl).hostname === "calendar.google.com";
  } catch {
    return false;
  }
}

/** Full event pages: /r/eventedit/<id> or /event?eid=… */
export function looksLikeCalendarEvent(rawUrl: string | undefined): boolean {
  if (!isCalendarUrl(rawUrl)) return false;
  const u = new URL(rawUrl!);
  return /\/r\/eventedit\//.test(u.pathname) || /\/event$/.test(u.pathname) || u.searchParams.has("eid");
}

export interface MeetingEligibility {
  openerUrl: string | undefined;
  /** When the calendar tab last navigated, if known. */
  openerNavAt: number | null;
  now: number;
  /** The calendar page currently shows an event detail dialog. */
  eventDialogOpen: boolean;
}

/**
 * Should a doc opened from this calendar tab be linked to the event it shows?
 * Yes while an event dialog is open, or shortly after the tab navigated to a
 * full event page. A doc opened minutes later from a week view is not linked.
 */
export function meetingEligible(e: MeetingEligibility): boolean {
  if (!isCalendarUrl(e.openerUrl)) return false;
  if (e.eventDialogOpen) return true;
  return looksLikeCalendarEvent(e.openerUrl) && e.openerNavAt !== null && e.now - e.openerNavAt <= CALENDAR_LINK_WINDOW_MS;
}

/** Page text is only trusted if the tab was still on the page we meant to read when the script ran. */
export function extractMatches(expectedUrl: string, actualHref: string | undefined): boolean {
  return !!actualHref && captureKey(actualHref) === captureKey(expectedUrl);
}
