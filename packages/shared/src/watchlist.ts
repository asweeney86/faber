import type { ExtractorKind, WatchRule } from "./api";

/** Built-in rules. All start disabled: nothing is captured until the user opts in. */
export const BUILTIN_RULES: readonly WatchRule[] = [
  { id: "gdocs", label: "Google Docs", pattern: "docs.google.com/document", extractor: "gdocs", enabled: false, builtin: true },
  { id: "gslides", label: "Google Slides", pattern: "docs.google.com/presentation", extractor: "gslides", enabled: false, builtin: true },
  { id: "gsheets", label: "Google Sheets", pattern: "docs.google.com/spreadsheets", extractor: "gsheets", enabled: false, builtin: true },
  { id: "gcal", label: "Google Calendar (link docs to meetings)", pattern: "calendar.google.com", extractor: "gcal", enabled: false, builtin: true },
];

export interface ParsedPattern {
  host: string;
  /** True for "*.example.com": matches example.com and any subdomain. */
  wildcard: boolean;
  pathPrefix: string;
}

/** Parse "host[/path]" or "*.host[/path]". Returns null for anything that is not a plausible host pattern. */
export function parsePattern(pattern: string): ParsedPattern | null {
  let p = pattern.trim().toLowerCase();
  p = p.replace(/^[a-z]+:\/\//, "");
  if (!p) return null;
  const slash = p.indexOf("/");
  let host = slash === -1 ? p : p.slice(0, slash);
  let pathPrefix = slash === -1 ? "" : p.slice(slash);
  pathPrefix = pathPrefix.replace(/\/+$/, "");
  let wildcard = false;
  if (host.startsWith("*.")) {
    wildcard = true;
    host = host.slice(2);
  }
  host = host.replace(/:\d+$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return null;
  // Refuse rules that would watch a whole top-level domain ("com", "*.co"); allow localhost and IPs.
  const labels = host.split(".");
  const isIp = /^\d+(\.\d+){3}$/.test(host);
  if (!isIp && host !== "localhost" && (labels.length < 2 || (wildcard && labels.length < 2))) return null;
  return { host, wildcard, pathPrefix };
}

/** Canonical text form of a pattern, for de-duplicating rules ("HTTPS://Wiki.example.com/" → "wiki.example.com"). */
export function normalisePattern(pattern: string): string | null {
  const pp = parsePattern(pattern);
  if (!pp) return null;
  return `${pp.wildcard ? "*." : ""}${pp.host}${pp.pathPrefix}`;
}

export function patternMatches(pattern: string, rawUrl: string): boolean {
  const pp = parsePattern(pattern);
  if (!pp) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  const hostOk = pp.wildcard ? host === pp.host || host.endsWith(`.${pp.host}`) : host === pp.host;
  if (!hostOk) return false;
  if (!pp.pathPrefix) return true;
  const path = url.pathname.toLowerCase();
  // Google URLs may carry a /u/1/ account segment before the real path.
  const normalised = path.replace(/^\/u\/\d+(?=\/)/, "");
  return [path, normalised].some((p) => p === pp.pathPrefix || p.startsWith(`${pp.pathPrefix}/`));
}

/** The first enabled rule matching the URL. Built-ins are checked first so a broad custom rule cannot steal Google docs. */
export function matchWatchRule(rawUrl: string, rules: readonly WatchRule[]): WatchRule | null {
  const ordered = [...rules.filter((r) => r.builtin), ...rules.filter((r) => !r.builtin)];
  return ordered.find((r) => r.enabled && patternMatches(r.pattern, rawUrl)) ?? null;
}

/** Chrome match pattern(s) needed to access a rule's pages, for chrome.permissions.request. */
export function originPatternsFor(pattern: string): string[] {
  const pp = parsePattern(pattern);
  if (!pp) return [];
  const host = pp.wildcard ? `*.${pp.host}` : pp.host;
  return [`https://${host}/*`, `http://${host}/*`];
}

/** Merge stored rules over the built-ins: keeps the user's enabled flags, always includes every built-in. */
export function normaliseWatchlist(stored: readonly WatchRule[] | null | undefined): WatchRule[] {
  const byId = new Map((stored ?? []).map((r) => [r.id, r]));
  const builtins = BUILTIN_RULES.map((b) => ({ ...b, enabled: byId.get(b.id)?.enabled ?? b.enabled }));
  const seen = new Set<string>();
  const custom = (stored ?? [])
    .filter((r) => !BUILTIN_RULES.some((b) => b.id === r.id))
    .flatMap((r) => {
      const pattern = normalisePattern(r.pattern);
      if (!pattern || seen.has(pattern)) return [];
      seen.add(pattern);
      return [{ ...r, pattern, builtin: false, extractor: "generic" as ExtractorKind }];
    });
  return [...builtins, ...custom];
}

/**
 * Common work tools, offered as one-click custom sites (PRD P2: more capture
 * sources). They use the generic page extractor; Chrome asks for permission per
 * site when the extension first needs it. "*.atlassian.net" covers Confluence and Jira.
 */
export const SUGGESTED_SOURCES: readonly { label: string; pattern: string }[] = [
  { label: "Notion", pattern: "*.notion.so" },
  { label: "Confluence & Jira", pattern: "*.atlassian.net" },
  { label: "GitHub", pattern: "github.com" },
  { label: "Linear", pattern: "linear.app" },
  { label: "Google Drive files", pattern: "drive.google.com/file" },
  { label: "Figma", pattern: "www.figma.com/file" },
];
