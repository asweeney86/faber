
/** URL of the launcher page for a given way of showing it, carrying its one-time ticket. */
export function launcherUrl(base: string, opts: { mode: "overlay" | "window"; ticket: string; query?: string }): string {
  const p = new URLSearchParams({ mode: opts.mode, t: opts.ticket });
  if (opts.query) p.set("q", opts.query);
  return `${base}?${p.toString()}`;
}

/**
 * One-time tickets for the launcher page. launcher.html is web-accessible (it has to be,
 * to show over pages), so any site could frame it; without a ticket the page shows and
 * fetches nothing. The service worker issues a ticket per launch; the page redeems it
 * once, within a minute, and takes the target tab from it (never from the URL).
 */
export interface LauncherTicket {
  mode: "overlay" | "window";
  tabId?: number;
  at: number;
}

const TICKETS = "launcherTickets";
export const TICKET_TTL_MS = 60_000;

interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

async function readTickets(area: SessionArea, at: number): Promise<Record<string, LauncherTicket>> {
  const all = ((await area.get(TICKETS))[TICKETS] ?? {}) as Record<string, LauncherTicket>;
  // Drop expired tickets as we go.
  return Object.fromEntries(Object.entries(all).filter(([, t]) => at - t.at < TICKET_TTL_MS));
}

export async function issueLauncherTicket(area: SessionArea, ticket: Omit<LauncherTicket, "at">, at = Date.now(), id = crypto.randomUUID()): Promise<string> {
  const tickets = await readTickets(area, at);
  tickets[id] = { ...ticket, at };
  await area.set({ [TICKETS]: tickets });
  return id;
}

/** The ticket, if it exists, is unexpired and matches the mode; it can't be used again. */
export async function redeemLauncherTicket(area: SessionArea, id: string | null, mode: "overlay" | "window", at = Date.now()): Promise<LauncherTicket | null> {
  if (!id) return null;
  const tickets = await readTickets(area, at);
  const ticket = tickets[id];
  delete tickets[id];
  await area.set({ [TICKETS]: tickets });
  return ticket && ticket.mode === mode ? ticket : null;
}

/**
 * Injected into the page (chrome.scripting, so it must be self-contained): show the
 * launcher iframe over the page, or remove it if it is already open (the shortcut toggles).
 * The iframe asks to be removed with a postMessage from the extension's origin.
 */
export function mountLauncherFrame(src: string, closeType: string): "opened" | "closed" {
  const ID = "faber-launcher-frame";
  type Frame = HTMLIFrameElement & { __faberClose?: () => void };
  const existing = document.getElementById(ID) as Frame | null;
  if (existing) {
    // The shortcut toggles: close through the same path as Esc, so the listener goes too.
    if (existing.__faberClose) existing.__faberClose();
    else existing.remove();
    return "closed";
  }
  const frame: Frame = document.createElement("iframe");
  frame.id = ID;
  frame.src = src;
  frame.title = "Faber launcher";
  frame.allow = "clipboard-write";
  frame.setAttribute(
    "style",
    "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;border:0!important;margin:0!important;padding:0!important;z-index:2147483647!important;background:transparent!important;color-scheme:normal!important;display:block!important",
  );
  const origin = new URL(src).origin;
  const previous = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // Hide and give up the id now (so the shortcut can open a fresh one straight away), but
    // remove the frame a moment later: removing an out-of-process frame inside the very
    // keydown (Esc) that closes it can leave Chrome waiting on that key's events.
    frame.removeAttribute("id");
    frame.style.setProperty("display", "none", "important");
    window.removeEventListener("message", onMessage);
    previous?.focus?.();
    setTimeout(() => frame.remove(), 100);
  };
  // Only the launcher frame itself (our extension's origin, this exact window) can close it.
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== origin || e.source !== frame.contentWindow || (e.data as { type?: string } | null)?.type !== closeType) return;
    close();
  };
  frame.__faberClose = close;
  window.addEventListener("message", onMessage);
  frame.addEventListener("load", () => frame.focus());
  (document.body ?? document.documentElement).appendChild(frame);
  return "opened";
}

