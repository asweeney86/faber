import { Launcher, type LauncherHost, type LauncherMode } from "@faber/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, navigate } from "./lib";
import { useDrawer } from "./components/ui";

const EVENT = "faber:launcher";

/** Open the launcher from anywhere in the app (⌘K, the home search box, buttons). */
export function openLauncher(query = "", mode: LauncherMode = "search") {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { query, mode } }));
}

/** Mounted once by the app shell; renders the launcher as a modal overlay. */
export function LauncherHostView() {
  const drawer = useDrawer();
  const [open, setOpen] = useState<{ query: string; mode: LauncherMode; n: number } | null>(null);

  // Give focus back to whatever had it when the launcher opened.
  const previous = useRef<HTMLElement | null>(null);
  const close = () => {
    setOpen(null);
    const el = previous.current;
    previous.current = null;
    setTimeout(() => el?.isConnected && el.focus(), 0);
  };

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ query: string; mode: LauncherMode }>).detail;
      if (!previous.current) previous.current = document.activeElement as HTMLElement | null;
      setOpen((o) => ({ query: d.query, mode: d.mode, n: (o?.n ?? 0) + 1 }));
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  const host = useMemo<LauncherHost>(
    () => ({
      client: api,
      shortcut: "⌘K",
      close,
      // In the app, originals always open in a new tab: Faber stays where it is.
      openUrl: (url) => {
        window.open(url, "_blank", "noopener");
        close();
      },
      openApp: (route, { newTab }) => {
        if (newTab) {
          window.open(`${location.origin}/#${route}`, "_blank", "noopener");
          return close();
        }
        setOpen(null);
        previous.current = null;
        const doc = /^\/doc\/([^/]+)$/.exec(route);
        if (doc) drawer.openDoc(doc[1]!);
        else navigate(route);
      },
    }),
    [drawer],
  );

  if (!open) return null;
  return (
    <div className="fl-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()} data-testid="launcher-overlay">
      <Launcher key={open.n} host={host} initialQuery={open.query} initialMode={open.mode} />
    </div>
  );
}
