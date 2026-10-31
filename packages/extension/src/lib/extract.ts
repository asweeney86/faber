/** Max characters of page text captured for generic (non-Google) pages. */
export const MAX_PAGE_CHARS = 300_000;

/**
 * Normalise text pulled from a page: unify line endings, collapse runs of
 * spaces, drop blank-line runs and whitespace-only lines, cap the length.
 */
export function cleanPageText(raw: string, max = MAX_PAGE_CHARS): string {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim());
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    if (!l) {
      blank++;
      continue;
    }
    if (blank && out.length) out.push("");
    blank = 0;
    out.push(l);
  }
  const text = out.join("\n");
  return text.length > max ? text.slice(0, max) : text;
}

export interface PageExtract {
  title: string;
  text: string;
  /** Where the script actually ran: the tab may have navigated since we decided to read it. */
  href: string;
}

/**
 * Runs inside the page via chrome.scripting.executeScript, so it must be fully
 * self-contained: no imports, no closures, only plain DOM calls.
 */
export function extractPageInPage(): PageExtract {
  const pick = (): HTMLElement => {
    const candidates = ["main", "article", "[role=main]", "#content", ".content"];
    for (const sel of candidates) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && (el.innerText || "").trim().length > 200) return el;
    }
    return document.body;
  };
  const root = pick();
  return { title: document.title || "", text: root ? root.innerText || "" : "", href: location.href };
}

export interface CalendarEventExtract {
  title: string;
  url: string;
  /** An event detail dialog is open right now. */
  eventDialogOpen: boolean;
}

/**
 * Runs inside a Google Calendar tab: the title of the event the user has open,
 * from the event dialog or a full event page. Returns null when no event is
 * open (a plain week view must not name a meeting). Self-contained.
 */
export function extractCalendarEventInPage(): CalendarEventExtract | null {
  const dialog = document.querySelector("[role=dialog][data-eventid], [role=dialog] [data-eventid]");
  const dialogRoot = dialog ? dialog.closest("[role=dialog]") || dialog : null;
  let title = "";
  if (dialogRoot) {
    const h = dialogRoot.querySelector("[role=heading], h1, h2");
    title = h ? (h.textContent || "").trim() : "";
  } else if (/\/r\/eventedit\//.test(location.pathname)) {
    const input = document.querySelector('input[aria-label="Title"], input[aria-label="Add title"]') as HTMLInputElement | null;
    title = input ? input.value.trim() : "";
  }
  if (!title) return null;
  return { title: title.slice(0, 300), url: location.href, eventDialogOpen: !!dialogRoot };
}
