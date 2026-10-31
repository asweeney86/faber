/** Messages the popup and options page send to the background service worker. */
export type BgMessage =
  | { type: "save-tab"; tabId: number; url: string }
  | { type: "refresh-watchlist" }
  | { type: "flush-queue" }
  | { type: "run-backfill" }
  /** The popup changed or viewed this tab's doc: refresh its toolbar icon. */
  | { type: "refresh-tab"; tabId: number; url?: string }
  /** Open the launcher over the active tab (falls back to a window). */
  | { type: "open-launcher"; query?: string };

export type SaveTabResult =
  | { ok: true; doc_id: string; content: "included" | "fetched" | "failed" | "none"; error?: string }
  | { ok: false; error: string; needsPermission?: boolean; queued?: boolean; pairing?: boolean };

export function sendToBackground<T = unknown>(msg: BgMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/** postMessage type the launcher iframe sends its parent page to be removed. */
export const LAUNCHER_CLOSE = "faber:launcher-close";
