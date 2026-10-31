/** Keep a selection index inside [0, length-1] (0 for an empty list). */
export function clampIndex(i: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, i));
}

/**
 * Fire-and-forget request that survives the popup closing (fetch keepalive),
 * used to flush unsaved edits on pagehide.
 */
export function sendKeepalive(baseUrl: string, method: string, path: string, body: unknown): void {
  try {
    void fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    /* nothing useful to do while closing */
  }
}
