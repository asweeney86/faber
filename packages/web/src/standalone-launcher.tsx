/**
 * The launcher on its own page (/launcher), for the native macOS launcher
 * (packages/macos), which shows it in a floating panel on a system-wide hotkey.
 *
 * The page talks to the native app through a WebKit message handler named
 * "faber": { type: "open", url } opens a link in the default browser, and
 * { type: "close" } hides the panel. In a plain browser tab the same page works
 * with window.open / window.close instead. The native app calls
 * window.__faberShow() each time it shows the panel, to start fresh.
 */
import { appearanceController, isOpenableUrl } from "@faber/shared";
import { IS_MAC, Launcher, type LauncherHost } from "@faber/ui";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./lib";

type NativeMessage = { type: "open"; url: string } | { type: "close" };
type Bridge = { postMessage(m: NativeMessage): void };

const bridge = (): Bridge | null => (window as unknown as { webkit?: { messageHandlers?: { faber?: Bridge } } }).webkit?.messageHandlers?.faber ?? null;

const appearance = appearanceController({
  root: document.documentElement,
  storage: (() => {
    try {
      return localStorage;
    } catch {
      return null;
    }
  })(),
  media: matchMedia("(prefers-color-scheme: dark)"),
});

function post(m: NativeMessage) {
  const b = bridge();
  if (b) b.postMessage(m);
  else if (m.type === "open") window.open(m.url, "_blank", "noopener");
  else window.close();
}

/** The app passes its real hotkey (`?hotkey=⌘⇧Space`); short and plain text only. */
function shortcutLabel(): string {
  const given = new URLSearchParams(location.search).get("hotkey");
  return given && given.length <= 24 ? given : IS_MAC ? "⌥Space" : "Alt+Space";
}

function App() {
  // Bumped by the native app each time it shows the panel: a fresh launcher, focused.
  const [session, setSession] = useState(0);
  useEffect(() => {
    (window as unknown as { __faberShow?: () => void }).__faberShow = () => {
      setSession((n) => n + 1);
      api.settings().then((s) => appearance.set(s.appearance), () => {});
    };
    api.settings().then((s) => appearance.set(s.appearance), () => {});
  }, []);

  const host = useMemo<LauncherHost>(
    () => ({
      client: api,
      shortcut: bridge() ? shortcutLabel() : undefined,
      close: () => post({ type: "close" }),
      openUrl: (url) => {
        if (isOpenableUrl(url)) post({ type: "open", url });
        post({ type: "close" });
      },
      openApp: (route) => {
        post({ type: "open", url: `${location.origin}/#${route}` });
        post({ type: "close" });
      },
    }),
    [],
  );

  return (
    <div className="fl-window" data-testid="standalone-launcher">
      <Launcher key={session} host={host} />
    </div>
  );
}

// Esc also closes when focus is somewhere the launcher doesn't handle it.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector(".fl-panel input:focus")) post({ type: "close" });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
