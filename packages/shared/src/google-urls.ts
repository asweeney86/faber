/**
 * Pure helpers for recognising Google Workspace document URLs.
 * Used by the daemon (history import, canonicalisation) and the extension
 * (deciding what to capture and how to fetch text), so no runtime deps here.
 */

export type GoogleKind = "gdoc" | "gslides" | "gsheets";

export interface GoogleDocRef {
  kind: GoogleKind;
  /** The long opaque id in the URL path. */
  id: string;
  /** Stable URL used as the document's identity. */
  canonicalUrl: string;
  /** URL that returns the document body as plain text (or CSV for sheets), for this URL's Google account. */
  exportUrl: string;
  /**
   * Google account index when the URL names one (/u/1/ or ?authuser=1), else null.
   * People signed into several accounts need it: exports default to account 0.
   */
  authuser: number | null;
}

/** /document/d/ID, with optional Workspace domain (/a/example.com/) and account (/u/1/) segments. */
const PATH_RE = /^(?:\/a\/[^/]+)?\/(document|presentation|spreadsheets)\/(?:u\/(\d+)\/)?d\/([a-zA-Z0-9_-]{20,})/;

const KIND_BY_SEGMENT: Record<string, GoogleKind> = {
  document: "gdoc",
  presentation: "gslides",
  spreadsheets: "gsheets",
};

const SEGMENT_BY_KIND: Record<GoogleKind, string> = {
  gdoc: "document",
  gslides: "presentation",
  gsheets: "spreadsheets",
};

export function parseGoogleUrl(raw: string): GoogleDocRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== "docs.google.com") return null;
  const m = PATH_RE.exec(url.pathname);
  if (!m) return null;
  const kind = KIND_BY_SEGMENT[m[1]!];
  const id = m[3]!;
  if (!kind) return null;
  const segment = SEGMENT_BY_KIND[kind];
  const canonicalUrl = `https://docs.google.com/${segment}/d/${id}/edit`;
  const fromQuery = url.searchParams.get("authuser");
  const index = m[2] ?? (fromQuery && /^\d{1,2}$/.test(fromQuery) ? fromQuery : null);
  const authuser = index === null ? null : Number(index);
  return { kind, id, canonicalUrl, exportUrl: exportUrlFor(kind, id, authuser), authuser };
}

/** Plain-text export URL for a doc, optionally for a specific signed-in Google account. */
export function exportUrlFor(kind: GoogleKind, id: string, authuser: number | null = null): string {
  const base =
    kind === "gslides"
      ? `https://docs.google.com/presentation/d/${id}/export/txt`
      : kind === "gsheets"
        ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`
        : `https://docs.google.com/document/d/${id}/export?format=txt`;
  if (authuser === null || authuser === 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}authuser=${authuser}`;
}

/** Strip Google's " - Google Docs" style suffix from a tab title. */
/**
 * Titles that describe the page state, not the document: error, sign-in and
 * access pages, loading screens and Google's bare app names. They must never
 * replace a document's real title.
 */
const PLACEHOLDER_TITLE =
  /^(?:page not found|not found|404(?:\b.*)?|error(?: \d{3})?(?:\b.*)?|sign[ -]?in(?: - google accounts)?|google accounts|access denied|you need (?:access|permission)|request access|(?:loading|updating)(?:\.\.\.|…)?|google (?:docs|slides|sheets|drive|calendar)|untitled (?:document|presentation|spreadsheet)|sorry[,.]? .*)$/i;

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLE.test(title.trim());
}

/** Strip Google's " - Google Docs" suffix; placeholder titles become "" (no title). */
export function cleanGoogleTitle(title: string | null | undefined): string {
  if (!title) return "";
  const t = title.replace(/\s+-\s+Google\s+(Docs|Slides|Sheets)\s*$/i, "").trim();
  return isPlaceholderTitle(t) ? "" : t;
}
