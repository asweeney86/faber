/**
 * The launcher on its own page (/launcher), for the native macOS launcher
 * (packages/macos), which shows it in a floating panel on a system-wide hotkey.
 *
 * The page talks to the native app through a WebKit message handler named
 * "faber": { type: "open", url } opens a link in the default browser, and
 * { type: "close" } hides the panel. In a plain browser tab the same page works
 * with window.open / window.close instead. The native app calls
 * window.__faberShow() each time it shows the panel, to start fresh.
 *
 * Hotkey changes (Settings → Shortcuts) reach the app through this page too: on every
 * settings check it sends { type: "hotkey", value } with the saved hotkey, and the app
 * answers through window.__faberHotkeyResult with what it actually registered, which is
 * saved back so Settings can show it.
 */
import { appearanceController, isOpenableUrl, type Settings } from "@faber/shared";
import { IS_MAC, Launcher, type LauncherHost } from "@faber/ui";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./lib";

type NativeMessage = { type: "open"; url: string } | { type: "close" } | { type: "hotkey"; value: string | null };
interface HotkeyResult {
  label: string;
  spec: string;
  ok: boolean;
}

/** How often the page re-reads settings while the app is running, so a new hotkey applies within seconds. */
const SETTINGS_POLL_MS = 5000;
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

/** The last settings seen, so a hotkey report is only saved when it changes something. */
let latest: Settings | null = null;

function applySettings(s: Settings) {
  latest = s;
  appearance.set(s.appearance);
  if (bridge()) post({ type: "hotkey", value: s.shortcuts.launcher });
}

const refresh = () => api.settings().then(applySettings, () => {});

function App() {
  // Bumped by the native app each time it shows the panel: a fresh launcher, focused.
  const [session, setSession] = useState(0);
  const [hotkey, setHotkey] = useState(shortcutLabel);
  useEffect(() => {
    const w = window as unknown as { __faberShow?: () => void; __faberHotkeyResult?: (r: HotkeyResult) => void };
    w.__faberShow = () => {
      setSession((n) => n + 1);
      void refresh();
    };
    w.__faberHotkeyResult = (r) => {
      setHotkey(r.label);
      const was = latest?.shortcuts.launcher_active;
      if (was && was.label === r.label && was.ok === r.ok) return;
      api.saveSettings({ shortcuts: { launcher_active: { label: r.label, ok: r.ok, at: Date.now() } } }).then(applySettings, () => {});
    };
    void refresh();
    const poll = bridge() ? setInterval(refresh, SETTINGS_POLL_MS) : undefined;
    return () => clearInterval(poll);
  }, []);

  const host = useMemo<LauncherHost>(
    () => ({
      client: api,
      shortcut: bridge() ? hotkey : undefined,
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
    [hotkey],
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
