import { useCallback, useEffect, useRef, useState } from "react";
import { PbClient, type Doc, type DocSource, type DocType, type SearchFilters, type SearchSort } from "@faber/shared";
export { DOC_TYPE_LABELS, formatWritten, plural, relativeTime } from "@faber/shared";
export { useDebounced } from "@faber/ui";

export const api = new PbClient("");

/** Count an open from Faber toward the doc's frecency (fire and forget). */
export function noteOpened(docId: string) {
  void api.opened(docId).catch(() => {});
}

/** Props for an <a> that opens a doc's original: clicks and middle-clicks count as opens. */
export function openLinkProps(doc: { id: string; canonical_url: string }) {
  return {
    href: doc.canonical_url,
    target: "_blank",
    rel: "noreferrer",
    onClick: () => noteOpened(doc.id),
    onAuxClick: (e: { button: number }) => {
      if (e.button === 1) noteOpened(doc.id);
    },
  };
}

// ---------- Change bus ----------
// Any mutation calls emitChange(); data hooks listening to the bus refetch, so a pin
// in the drawer shows up in search results and the digest without manual wiring.

const CHANGE_EVENT = "faber:changed";

export function emitChange() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useChangeBus(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const on = () => ref.current();
    window.addEventListener(CHANGE_EVENT, on);
    return () => window.removeEventListener(CHANGE_EVENT, on);
  }, []);
}

/** The daemon isn't reachable (fetch itself failed), as opposed to an API error response. */
export class OfflineError extends Error {
  constructor() {
    super("Can’t reach Faber — run `bun faber serve`");
    this.name = "OfflineError";
  }
}

/** Map browser network failures (TypeError from fetch) to OfflineError; pass everything else through. */
export const OFFLINE_EVENT = "faber:offline";

export function toError(e: unknown): Error {
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) {
    // Let the shell re-check status now rather than on its next 5s tick, so the sidebar agrees with the page.
    window.dispatchEvent(new Event(OFFLINE_EVENT));
    return new OfflineError();
  }
  return e instanceof Error ? e : new Error(String(e));
}

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch on mount and whenever deps change; refetch silently on the change bus.
 * Stale responses (deps changed mid-flight) are dropped.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { live?: boolean } = {}): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback((quiet: boolean) => {
    const id = ++seq.current;
    if (!quiet) setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (id !== seq.current) return;
        setData(d);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (id !== seq.current) return;
        setError(toError(e));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, []);

  // Intentionally not re-run when the omitted dependencies change.
  useEffect(() => run(false), deps);
  useChangeBus(() => {
    if (opts.live !== false) run(true);
  });
  return { data, error, loading, reload: () => run(true) };
}

// ---------- Routing ----------

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const qi = raw.indexOf("?");
  const path = (qi === -1 ? raw : raw.slice(0, qi)) || "/";
  const query = new URLSearchParams(qi === -1 ? "" : raw.slice(qi + 1));
  return { path, segments: path.split("/").filter(Boolean).map(decodeURIComponent), query };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const hash = to.startsWith("#") ? to : `#${to}`;
  if (opts.replace) {
    if (location.hash === hash) return;
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = hash;
  }
}

// ---------- Formatting ----------

export const SOURCE_LABELS: Record<DocSource, string> = {
  gdoc: "Docs",
  gslides: "Slides",
  gsheets: "Sheets",
  url: "Web",
};

export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** A doc's title, or its site when it has none (a link saved without a title). */
export function docTitle(d: Pick<Doc, "title"> & { canonical_url?: string }): string {
  return d.title.trim() || hostOf(d.canonical_url) || "Untitled document";
}

// ---------- Search URL state ----------

export type TimeRange = "7d" | "30d" | "90d" | "all";
export const TIME_RANGES: { id: TimeRange; label: string; days: number | null }[] = [
  { id: "all", label: "Any time", days: null },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
];

export interface SearchState {
  q: string;
  types: DocType[];
  sources: DocSource[];
  tags: string[];
  people: string[];
  projects: string[];
  pinned: boolean;
  time: TimeRange;
  /** Order without a query. */
  sort: SearchSort;
}

export function searchStateFromQuery(p: URLSearchParams): SearchState {
  const time = p.get("time") as TimeRange | null;
  return {
    q: p.get("q") ?? "",
    types: p.getAll("type") as DocType[],
    sources: p.getAll("source") as DocSource[],
    tags: p.getAll("tag"),
    people: p.getAll("person"),
    projects: p.getAll("project"),
    pinned: p.get("pinned") === "1",
    time: time && TIME_RANGES.some((t) => t.id === time) ? time : "all",
    sort: p.get("sort") === "recent" ? "recent" : "frequent",
  };
}

export function searchStateToHash(s: SearchState): string {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  s.types.forEach((v) => p.append("type", v));
  s.sources.forEach((v) => p.append("source", v));
  s.tags.forEach((v) => p.append("tag", v));
  s.people.forEach((v) => p.append("person", v));
  s.projects.forEach((v) => p.append("project", v));
  if (s.pinned) p.set("pinned", "1");
  if (s.time !== "all") p.set("time", s.time);
  if (s.sort === "recent") p.set("sort", "recent");
  const qs = p.toString();
  return `#/search${qs ? `?${qs}` : ""}`;
}

export function filtersFromState(s: SearchState, nowMs = Date.now()): SearchFilters {
  const f: SearchFilters = {};
  if (s.types.length) f.doc_type = s.types;
  if (s.sources.length) f.source = s.sources;
  if (s.tags.length) f.tag = s.tags;
  if (s.people.length) f.person = s.people;
  if (s.projects.length) f.project = s.projects;
  if (s.pinned) f.pinned = true;
  const days = TIME_RANGES.find((t) => t.id === s.time)?.days;
  if (days) f.seen_after = nowMs - days * 86_400_000;
  return f;
}

export function toggle<T>(xs: T[], x: T): T[] {
  return xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x];
}

/** Split an FTS snippet with [match] markers into text/mark parts. */
export function snippetParts(snippet: string): { text: string; mark: boolean }[] {
  const clean = snippet.replace(/\s+/g, " ").trim();
  const parts: { text: string; mark: boolean }[] = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    if (m.index > last) parts.push({ text: clean.slice(last, m.index), mark: false });
    if (m[1]) parts.push({ text: m[1], mark: true });
    last = m.index + m[0].length;
  }
  if (last < clean.length) parts.push({ text: clean.slice(last), mark: false });
  // Merge adjacent marks separated only by spaces so "[the] [Frankfurt]" reads as one highlight.
  const merged: { text: string; mark: boolean }[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    const prev2 = merged[merged.length - 2];
    if (p.mark && prev && !prev.mark && /^\s+$/.test(prev.text) && prev2?.mark) {
      prev2.text += prev.text + p.text;
      merged.pop();
    } else {
      merged.push({ ...p });
    }
  }
  return merged;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "collection";
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}
