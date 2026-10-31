import type { DocSource, DocType } from "@faber/shared";

const DOC_TYPE_LABELS: Record<DocType, string> = {
  prd: "PRD",
  design_doc: "Design doc",
  meeting_notes: "Meeting notes",
  postmortem: "Postmortem",
  okrs: "OKRs",
  roadmap: "Roadmap",
  deck: "Deck",
  spreadsheet: "Sheet",
  runbook: "Runbook",
  policy: "Policy",
  research: "Research",
  status_update: "Status update",
  other: "Doc",
};

export const docTypeLabel = (t: DocType) => DOC_TYPE_LABELS[t] ?? "Doc";

export const SOURCE_LABELS: Record<DocSource, string> = {
  gdoc: "Docs",
  gslides: "Slides",
  gsheets: "Sheets",
  url: "Web",
};

/** "just now", "5m ago", "3h ago", "2d ago", "4w ago", "Mar 2025". */
export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (d < 60) return `${w}w ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** Escape text for chrome.omnibox suggestion descriptions, which are parsed as XML. */
export function escapeOmnibox(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Split an FTS snippet "a [b] c" into plain/highlight parts. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[1]!, hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

/**
 * How many tags fit on a one-line meta row after the badge and time, so the
 * rest collapse into "+n" instead of being clipped. Budget is in characters
 * (a tag costs its text plus "#" and padding).
 */
export function fitTags(tags: readonly string[], budgetChars: number): number {
  let used = 0;
  let n = 0;
  for (const t of tags) {
    const cost = t.length + 4;
    const reserve = n + 1 < tags.length ? 4 : 0; // room for "+n"
    if (used + cost + reserve > budgetChars) break;
    used += cost;
    n++;
  }
  return n;
}

/** Only http(s) links may be opened from the popup (older databases can hold other schemes). */
export { isOpenableUrl } from "@faber/shared";
