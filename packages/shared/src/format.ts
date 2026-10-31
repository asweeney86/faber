import type { DocType } from "./api";

/** Display labels shared by the app, the launcher and the extension. */
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  prd: "PRD",
  design_doc: "Design doc",
  meeting_notes: "Meeting notes",
  postmortem: "Postmortem",
  okrs: "OKRs",
  roadmap: "Roadmap",
  deck: "Deck",
  spreadsheet: "Spreadsheet",
  runbook: "Runbook",
  policy: "Policy",
  research: "Research",
  status_update: "Status update",
  other: "Other",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function relativeTime(ms: number, nowMs = Date.now()): string {
  const s = Math.round((nowMs - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  if (d < 35) return `${Math.round(d / 7)}w ago`;
  const date = new Date(ms);
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "2026-04" → "Apr 2026", "2026-04-14" → "Apr 14, 2026". */
export function formatWritten(w: string | null | undefined): string | null {
  if (!w) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(w);
  if (!m) return w;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return m[3] ? `${month} ${Number(m[3])}, ${m[1]}` : `${month} ${m[1]}`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`;
}

/** Only http(s) links are ever opened from stored data (never javascript:, data:, file:…). */
export function isOpenableUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
