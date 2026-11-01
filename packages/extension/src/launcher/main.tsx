import type { PbClient } from "@faber/shared";
import { daemonClient } from "../lib/client";
import { IS_MAC, Launcher, type LauncherHost } from "@faber/ui";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { appearance } from "../lib/appearance"; // also paints the cached theme before the first render
import { isOpenableUrl } from "../lib/format";
import { LAUNCHER_CLOSE } from "../lib/messages";
import { redeemLauncherTicket } from "../lib/launcher";
import { isPairingRequired } from "../lib/queue";
import { launcherShortcut } from "../lib/shortcut";
import { getItem, type ExtConfig } from "../lib/storage";

/**
 * The launcher, as an extension page. Two ways in (see background.ts):
 *   ?mode=overlay&tab=<id>  an iframe the worker injected over the current page
 *   ?mode=window            a small popup window, where pages can't be injected
 */
const params = new URLSearchParams(location.search);
const overlay = params.get("mode") !== "window";
/** The tab to navigate, from the redeemed ticket (never from the URL). */
let tabId: number | null = null;

function close() {
  if (overlay) window.parent.postMessage({ type: LAUNCHER_CLOSE }, "*");
  else window.close();
}

async function openTab(url: string, newTab: boolean) {
  if (!isOpenableUrl(url)) return;
  if (overlay && tabId && !newTab) await chrome.tabs.update(tabId, { url });
  else {
    // From the window fallback, open in the browser window the user came from.
    const win = overlay ? undefined : await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
    await chrome.tabs.create({ url, active: true, windowId: win?.id });
  }
  close();
}

function App() {
  const [cfg, setCfg] = useState<ExtConfig | null>(null);
  const [problem, setProblem] = useState<"offline" | "pairing" | null>(null);
  // The shortcut that opened this, as Chrome has it (the user may have changed it).
  const [shortcut, setShortcut] = useState<string | undefined>(IS_MAC ? "⌘⇧K" : "Ctrl+Shift+K");
  useEffect(() => {
    launcherShortcut().then((s) => setShortcut(s ?? undefined), () => {});
  }, []);
  useEffect(() => {
    // Only a launch the service worker started gets data (see redeemLauncherTicket).
    void redeemLauncherTicket(chrome.storage.session, params.get("t"), overlay ? "overlay" : "window").then((ticket) => {
      if (!ticket) return close();
      tabId = ticket.tabId ?? null;
      void getItem("config").then(setCfg);
    });
  }, []);
  const client = useMemo(() => (cfg ? daemonClient(cfg.daemonUrl) : null), [cfg]);
  useEffect(() => {
    if (!client) return;
    client.settings().then(
      (s) => appearance.set(s.appearance),
      (e: unknown) => setProblem(isPairingRequired(e) ? "pairing" : "offline"),
    );
  }, [client]);

  const host = useMemo<LauncherHost | null>(
    () =>
      client && cfg
        ? {
            client,
            shortcut,
            close,
            openUrl: (url, { newTab }) => void openTab(url, newTab),
            openApp: (route) => void openTab(`${cfg.daemonUrl}/#${route}`, true),
          }
        : null,
    [client, cfg, shortcut],
  );

  const body = !host ? null : problem ? (
    <div className="fl-panel fl-problem" role="dialog" aria-label="Faber" data-testid="launcher-problem">
      <h2>{problem === "pairing" ? "Approve this extension in Faber" : "Faber isn’t running"}</h2>
      <p>
        {problem === "pairing" ? (
          <>Open the app’s Settings → Capture & Sources and approve the extension.</>
        ) : (
          <>
            Couldn’t reach <code>{cfg?.daemonUrl}</code>. Start it with <code>bun faber serve</code>.
          </>
        )}
      </p>
      <div>
        {problem === "pairing" && (
          <button className="fl-button" onClick={() => void openTab(`${cfg!.daemonUrl}/#/settings/capture`, true)}>
            Open settings
          </button>
        )}
        <button className="fl-button fl-button-quiet" onClick={close}>
          Close
        </button>
      </div>
    </div>
  ) : (
    <Launcher host={host} initialQuery={params.get("q") ?? ""} />
  );

  return overlay ? (
    <div className="fl-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      {body}
    </div>
  ) : (
    <div className="fl-window">{body}</div>
  );
}

// Escape closes even before React mounts, or if focus lands outside the panel.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector(".fl-panel input")) close();
});
createRoot(document.getElementById("root")!).render(<App />);
