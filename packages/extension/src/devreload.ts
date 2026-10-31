/**
 * Dev-only: keep a WebSocket open to `bun run dev:extension` and reload the
 * extension when it reports a new build. Normal builds compile this out
 * (__FABER_DEV_RELOAD_PORT__ is 0, so the call in background.ts is dead code).
 */

/** Reload when the server's current build differs from the one we are running. */
export function isStale(serverBuildId: string, myBuildId: string): boolean {
  return serverBuildId !== "" && serverBuildId !== myBuildId;
}

export function startDevReload(port: number, myBuildId: string) {
  let retry = 500;
  const connect = () => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      setTimeout(connect, retry);
      return;
    }
    // A message every 20s keeps the MV3 service worker alive while the dev server runs (Chrome ≥ 116).
    let ping: ReturnType<typeof setInterval> | undefined;
    ws.onopen = () => {
      retry = 500;
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 20_000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { build_id?: string };
      if (msg.build_id && isStale(msg.build_id, myBuildId)) {
        console.info("[faber dev] new build, reloading extension");
        chrome.runtime.reload();
      }
    };
    ws.onclose = () => {
      clearInterval(ping);
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 5000);
    };
  };
  connect();
}
