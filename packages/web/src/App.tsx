import { useCallback, useEffect, useMemo, useState } from "react";
import { FaberIcon, FaberWordmark, projectTint } from "@faber/ui";
import type { ExtensionAccess, ProjectSummary, StatusResponse } from "@faber/shared";
import { api, isTypingTarget, navigate, OFFLINE_EVENT, plural, useAsync, useChangeBus, useRoute } from "./lib";
import { IconChevron, IconFolder, IconGrid, IconHome, IconInbox, IconLayers, IconPanel, IconPlus, IconSearch, IconSettings, IconSparkle, IconUsers, IconX } from "./components/icons";
import { DrawerContext, EmptyState, IssuesBar, LiveContext, Modal, type LiveStatus } from "./components/ui";
import { AddDocContext, AddDocForm, useOpenAddDoc, addResultToast, ToastContext, Toasts, type AddPrefill, type Toast } from "./components/AddDoc";
import { AddPage } from "./pages/Add";
import { LauncherHostView, openLauncher } from "./launcher";
import { appearance } from "./appearance";
import { DocDetailView, DocPage } from "./components/DocDetail";
import { HomePage } from "./pages/Home";
import { SearchPage } from "./pages/Search";
import { CollectionPage, CollectionsPage } from "./pages/Collections";
import { MeetingPage, PeoplePage, PersonPage } from "./pages/People";
import { AskPage } from "./pages/Ask";
import { ProjectPage, ProjectsPage } from "./pages/Projects";
import { InboxPage } from "./pages/Inbox";
import { DashboardsPage } from "./pages/Dashboards";
import { SettingsPage } from "./pages/Settings";

export function App() {
  const route = useRoute();
  const live = useStatus();
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddPrefill | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((xs) => [...xs.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.detail ? 9000 : 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((xs) => xs.filter((x) => x.id !== id)), []);
  const openAdd = useCallback((prefill?: AddPrefill) => setAdding(prefill ?? {}), []);
  const drawer = useMemo(() => ({ openDoc: (id: string) => setDrawerId(id), close: () => setDrawerId(null), docId: drawerId }), [drawerId]);

  // The daemon's appearance is the source of truth (another Faber tab may have changed it):
  // apply it at start and whenever the window regains focus.
  useEffect(() => {
    const sync = () =>
      api
        .settings()
        .then((st) => {
          if (JSON.stringify(st.appearance) !== JSON.stringify(appearance.get())) appearance.set(st.appearance);
        })
        .catch(() => {});
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  // Close the drawer on navigation.
  useEffect(() => setDrawerId(null), [route.path]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") {
        e.preventDefault();
        if (!document.querySelector(".fl-overlay")) openLauncher();
      } else if (e.key === "/" && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        focusSearch();
      } else if (k === "a" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target) && !document.querySelector(".modal, .fl-overlay")) {
        e.preventDefault();
        setAdding({});
      } else if (e.key === "Escape" && drawerId) {
        setDrawerId(null);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [drawerId]);

  return (
    <DrawerContext.Provider value={drawer}>
      <LiveContext.Provider value={live}>
      <ToastContext.Provider value={toast}>
      <AddDocContext.Provider value={openAdd}>
      <div className="shell">
        <Sidebar path={route.path} live={live} />
        <main className="main" id="main">
          {!live.offline && <IssuesBar issues={live.status?.issues ?? []} />}
          <Page />
        </main>
        {drawerId && <Drawer id={drawerId} onClose={() => setDrawerId(null)} />}
        {adding && (
          <Modal title="Add a bookmark" onClose={() => setAdding(null)} testId="add-modal" wide>
            <AddDocForm
              prefill={adding}
              onCancel={() => setAdding(null)}
              onDone={(r) => {
                setAdding(null);
                toast(addResultToast(r, (id) => setDrawerId(id)));
              }}
            />
          </Modal>
        )}
        <Toasts toasts={toasts} onDismiss={dismissToast} />
        <LauncherHostView />
      </div>
      </AddDocContext.Provider>
      </ToastContext.Provider>
      </LiveContext.Provider>
    </DrawerContext.Provider>
  );
}

function focusSearch() {
  const el = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
  if (el && location.hash.startsWith("#/search")) {
    el.focus();
    el.select();
  } else {
    navigate("/search");
  }
}

function Page() {
  const route = useRoute();
  const [a, b] = route.segments;
  switch (a) {
    case undefined:
      return <HomePage />;
    case "search":
      return <SearchPage route={route} />;
    case "doc":
      return b ? <DocPage id={b} /> : <NotFound />;
    case "collections":
      return b ? <CollectionPage id={b} /> : <CollectionsPage />;
    case "inbox":
      return <InboxPage />;
    case "dashboards":
      return <DashboardsPage id={b} />;
    case "projects":
      return b ? <ProjectPage id={b} /> : <ProjectsPage />;
    case "people":
      return b ? <PersonPage id={b} /> : <PeoplePage />;
    case "meetings":
      return b ? <MeetingPage id={b} /> : <NotFound />;
    case "ask":
      return <AskPage />;
    case "settings":
      return <SettingsPage section={b} />;
    case "add":
      return <AddPage route={route} />;
    default:
      return <NotFound />;
  }
}

function NotFound() {
  return (
    <div className="page">
      <EmptyState title="Page not found">
        <a href="#/">Go home</a>
      </EmptyState>
    </div>
  );
}

/** Daemon status plus pending extension pairing requests, polled every 5s and on any change. */
function useStatus(): LiveStatus {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [pendingExtensions, setPending] = useState<ExtensionAccess[]>([]);
  const poll = useCallback(() => {
    api
      .status()
      .then((s) => {
        setStatus(s);
        setOffline(false);
      })
      .catch(() => setOffline(true));
    api
      .extensions()
      .then((xs) => {
        const pending = xs.filter((x) => x.state === "pending");
        // Keep the same array when nothing changed so consumers don't re-render every poll.
        setPending((prev) => (prev.map((x) => x.id).join() === pending.map((x) => x.id).join() ? prev : pending));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [poll]);
  useChangeBus(poll);
  useEffect(() => {
    window.addEventListener(OFFLINE_EVENT, poll);
    return () => window.removeEventListener(OFFLINE_EVENT, poll);
  }, [poll]);
  return useMemo(() => ({ status, offline, pendingExtensions }), [status, offline, pendingExtensions]);
}

const EXPANDED_KEY = "faber:nav-expanded";

function useExpanded(): [Record<string, boolean>, (id: string) => void] {
  const [state, setState] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "") as Record<string, boolean>;
    } catch {
      return { projects: true };
    }
  });
  const toggle = (id: string) =>
    setState((s) => {
      const next = { ...s, [id]: !s[id] };
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  return [state, toggle];
}

interface NavLinkProps {
  id: string;
  href: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  count?: number;
  hint?: string;
  attention?: number;
  expandable?: { open: boolean; toggle: () => void };
}

function NavLink({ id, href, label, icon, active, count, hint, attention, expandable }: NavLinkProps) {
  return (
    <div className={`nav-item${active ? " is-active" : ""}`}>
      <a href={href} className="nav-link" aria-current={active ? "page" : undefined} data-testid={`nav-${id || "home"}`}>
        <span className="nav-icon">{icon}</span>
        <span className="nav-label">{label}</span>
        {count !== undefined && count > 0 && <span className="nav-count">{count.toLocaleString()}</span>}
        {hint && <kbd className="nav-kbd">{hint}</kbd>}
        {!!attention && (
          <span className="nav-attention" data-testid="settings-attention" title={`${attention} extension ${attention === 1 ? "request" : "requests"} waiting`}>
            {attention}
          </span>
        )}
      </a>
      {expandable && (
        <button
          className={`nav-expand${expandable.open ? " is-open" : ""}`}
          onClick={expandable.toggle}
          aria-expanded={expandable.open}
          aria-label={`${expandable.open ? "Collapse" : "Expand"} ${label}`}
          data-testid={`nav-expand-${id}`}
        >
          <IconChevron size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * Projects as a folder tree: every project, subprojects under their parents behind a
 * disclosure triangle (remembered per project). The open project's parents are opened for it.
 */
function ProjectNavTree({
  projects,
  activeId,
  expanded,
  toggle,
}: {
  projects: ProjectSummary[];
  activeId: string | undefined;
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
}) {
  const { children, parentOf } = useMemo(() => {
    const ids = new Set(projects.map((p) => p.id));
    const children = new Map<string | null, ProjectSummary[]>();
    const parentOf = new Map<string, string>();
    for (const p of projects) {
      const parent = p.parent_id && ids.has(p.parent_id) && p.parent_id !== p.id ? p.parent_id : null;
      if (parent) parentOf.set(p.id, parent);
      children.set(parent, [...(children.get(parent) ?? []), p]);
    }
    return { children, parentOf };
  }, [projects]);
  // Ancestors of the open project stay open, so it's always visible in the tree.
  const forced = useMemo(() => {
    const out = new Set<string>();
    for (let id = activeId && parentOf.get(activeId); id && !out.has(id); id = parentOf.get(id)) out.add(id);
    return out;
  }, [activeId, parentOf]);
  const isOpen = (id: string) => forced.has(id) || !!expanded[`project:${id}`];
  const branch = (parent: string | null, seen: Set<string>): React.ReactNode => (
    <ul className="nav-sub" role={parent ? "group" : undefined}>
      {(children.get(parent) ?? []).map((p) => {
        if (seen.has(p.id)) return null;
        const kids = (children.get(p.id) ?? []).length;
        const open = kids > 0 && isOpen(p.id);
        return (
          <li key={p.id}>
            <div className="nav-sub-row">
              {kids > 0 ? (
                <button
                  className={`nav-twisty${open ? " is-open" : ""}`}
                  onClick={() => toggle(`project:${p.id}`)}
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${p.name}`}
                  data-testid="nav-project-toggle"
                  disabled={forced.has(p.id)}
                >
                  <IconChevron size={10} />
                </button>
              ) : (
                <span className="nav-twisty-spacer" />
              )}
              <a
                href={`#/projects/${encodeURIComponent(p.id)}`}
                className={`nav-sub-link${activeId === p.id ? " is-active" : ""}`}
                data-tint={projectTint(p.id)}
                title={`${p.name} · ${plural(p.doc_count, "doc")}`}
              >
                <IconFolder size={14} />
                <span className="nav-label">{p.name}</span>
              </a>
              <span className="nav-sub-count" aria-hidden="true">
                {p.doc_count}
              </span>
            </div>
            {open && branch(p.id, new Set([...seen, p.id]))}
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="nav-tree" data-testid="nav-project-list">
      {branch(null, new Set())}
    </div>
  );
}

function Sidebar({ path, live }: { path: string; live: LiveStatus }) {
  const openAdd = useOpenAddDoc();
  const { status, offline, pendingExtensions } = live;
  const collections = useAsync(() => api.collections(), []);
  const projects = useAsync(() => api.projects(), []);
  const review = useAsync(() => api.review(), []);
  const views = useAsync(() => api.views(), []);
  const people = useAsync(() => api.people(), []);
  const [expanded, toggle] = useExpanded();
  const [section, rawSub] = path.split("/").slice(1);
  const sub = (() => {
    try {
      return rawSub === undefined ? undefined : decodeURIComponent(rawSub);
    } catch {
      return rawSub;
    }
  })();
  const at = (id: string) => (section ?? "") === id && !sub;
  const within = (id: string) => (section ?? "") === id;
  return (
    <nav className="sidebar" aria-label="Main">
      <a className="brand" href="#/" aria-label="Faber home">
        <FaberIcon size={26} className="brand-mark" />
        <FaberWordmark height={16} className="brand-name" />
      </a>
      <button className="add-btn" onClick={() => openAdd()} title="Add a bookmark (A)" data-testid="nav-add">
        <IconPlus size={15} /> <span className="nav-label">Add bookmark</span> <kbd className="nav-kbd">A</kbd>
      </button>
      <div className="nav">
        <NavLink id="" href="#/" label="Home" icon={<IconHome />} active={(section ?? "") === ""} />
        <NavLink id="search" href="#/search" label="Search" icon={<IconSearch />} active={within("search") || within("doc")} hint="/" />

        <NavLink id="inbox" href="#/inbox" label="Inbox" icon={<IconInbox />} active={within("inbox")} count={offline ? undefined : review.data?.items.length} />

        <div className="nav-group-label">Organize</div>
        <NavLink
          id="projects"
          href="#/projects"
          label="Projects"
          icon={<IconFolder />}
          active={at("projects")}
          expandable={(projects.data?.length ?? 0) > 0 ? { open: !!expanded.projects, toggle: () => toggle("projects") } : undefined}
        />
        {expanded.projects && (projects.data?.length ?? 0) > 0 && (
          <ProjectNavTree projects={projects.data!} activeId={within("projects") ? sub : undefined} expanded={expanded} toggle={toggle} />
        )}
        <NavLink
          id="collections"
          href="#/collections"
          label="Collections"
          icon={<IconLayers />}
          active={at("collections")}
          count={offline ? undefined : collections.data?.length}
          expandable={(collections.data?.length ?? 0) > 0 ? { open: !!expanded.collections, toggle: () => toggle("collections") } : undefined}
        />
        {expanded.collections && (collections.data?.length ?? 0) > 0 && (
          <ul className="nav-sub" data-testid="nav-collection-list">
            {collections.data!.map((c) => (
              <li key={c.id}>
                <a href={`#/collections/${c.id}`} className={`nav-sub-link nav-sub-collection${within("collections") && sub === c.id ? " is-active" : ""}`}>
                  <IconLayers size={15} />
                  <span className="nav-label">{c.name}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <NavLink id="people" href="#/people" label="People" icon={<IconUsers />} active={within("people") || within("meetings")} count={offline ? undefined : people.data?.length} />
        <NavLink
          id="dashboards"
          href="#/dashboards"
          label="Dashboards"
          icon={<IconGrid />}
          active={at("dashboards")}
          expandable={(views.data?.length ?? 0) > 0 ? { open: !!expanded.dashboards, toggle: () => toggle("dashboards") } : undefined}
        />
        {expanded.dashboards && (views.data?.length ?? 0) > 0 && (
          <ul className="nav-sub" data-testid="nav-dashboard-list">
            {views.data!.map((v) => (
              <li key={v.id}>
                <a href={`#/dashboards/${encodeURIComponent(v.id)}`} className={`nav-sub-link${within("dashboards") && sub === v.id ? " is-active" : ""}`}>
                  <IconGrid size={14} />
                  <span className="nav-label">{v.name}</span>
                </a>
              </li>
            ))}
          </ul>
        )}

        <div className="nav-sep" />
        <NavLink id="ask" href="#/ask" label="Ask" icon={<IconSparkle />} active={within("ask")} />
        <NavLink id="settings" href={pendingExtensions.length ? "#/settings/capture" : "#/settings"} label="Settings" icon={<IconSettings />} active={within("settings")} attention={pendingExtensions.length} />
      </div>
      <div className="sidebar-foot">
        <div className={`status${offline ? " is-offline" : ""}`} data-testid="daemon-status">
          <span className={`status-dot${offline ? " off" : status && status.queue.running > 0 ? " busy" : ""}`} aria-hidden="true" />
          {offline ? (
            <span className="status-text">
              <span>Can’t reach the daemon</span>
              <span className="muted">
                Run <code className="nowrap">bun faber serve</code>
              </span>
            </span>
          ) : status ? (
            <span className="status-text">
              <span>
                {plural(status.docs, "doc")} · {status.enriched.toLocaleString()} enriched
              </span>
              {(status.queue.pending > 0 || status.queue.running > 0) && (
                <span className="muted">
                  {status.queue.running > 0 ? "Enriching · " : ""}
                  {status.queue.pending.toLocaleString()} queued
                </span>
              )}
              {status.queue.error > 0 && <span className="status-err">{status.queue.error} failed</span>}
            </span>
          ) : (
            <span className="muted">Connecting…</span>
          )}
        </div>
      </div>
    </nav>
  );
}

function Drawer({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" aria-label="Document details" data-testid="drawer">
        <div className="drawer-bar">
          <span className="drawer-label">Details</span>
          <a className="icon-btn" href={`#/doc/${id}`} aria-label="Open as page" title="Open as page">
            <IconPanel size={15} />
          </a>
          <button className="icon-btn" onClick={onClose} aria-label="Close details" title="Close (Esc)" data-testid="drawer-close">
            <IconX size={16} />
          </button>
        </div>
        <div className="drawer-body">
          <DocDetailView key={id} id={id} onForget={onClose} />
        </div>
      </aside>
    </>
  );
}
