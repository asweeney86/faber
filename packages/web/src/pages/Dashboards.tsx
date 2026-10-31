import { useState, type ReactNode } from "react";
import type { SavedView, SearchFilters, ViewSpec, ViewWidget } from "@faber/shared";
import { api, emitChange, navigate, plural, toError, useAsync } from "../lib";
import { IconArrowDown, IconArrowUp, IconFolder, IconGrid, IconLayers, IconPlus, IconTrash } from "../components/icons";
import { DocList, EmptyState, ErrorBanner, LoadError, Modal, PageHeader, Spinner } from "../components/ui";
import { projectHref, projectTree } from "./Projects";

/**
 * Dashboards (PRD 2.6) and saved views (P2): named sets of widgets. "My Work",
 * "Planning" and "Recent Project Activity" are built in; anything else is yours,
 * made here or from a search ("Save as view").
 */

const DAY = 86_400_000;

/** Negative seen_after in a saved spec means "this many days ago". */
function resolveFilters(f: SearchFilters | undefined): SearchFilters | undefined {
  if (!f) return f;
  const out = { ...f };
  if (typeof out.seen_after === "number" && out.seen_after < 0) out.seen_after = Date.now() + out.seen_after * DAY;
  return out;
}

export function DashboardsPage({ id }: { id?: string }) {
  const views = useAsync(() => api.views(), []);
  const [creating, setCreating] = useState<{ spec: ViewSpec; name: string } | null>(null);
  const list = views.data ?? [];
  const current = list.find((v) => v.id === (id ?? "my-work"));

  return (
    <div className="page page-wide" data-testid="dashboards">
      <PageHeader
        title="Dashboards"
        subtitle="The views you come back to, without searching again."
        actions={
          <button className="btn btn-primary" onClick={() => setCreating({ spec: { widgets: [{ kind: "recent" }] }, name: "" })} data-testid="new-dashboard">
            <IconPlus size={14} /> New dashboard
          </button>
        }
      />
      {views.error && <LoadError error={views.error} onRetry={views.reload} what="Dashboards" backHref="#/" backLabel="Go home" />}
      <div className="dash-layout">
        <nav className="dash-nav" aria-label="Dashboards">
          {list.map((v) => (
            <a
              key={v.id}
              href={`#/dashboards/${encodeURIComponent(v.id)}`}
              className={`settings-nav-item${current?.id === v.id ? " is-active" : ""}`}
              aria-current={current?.id === v.id ? "page" : undefined}
              data-testid={`dashboard-tab-${v.id}`}
            >
              <span className="settings-nav-icon">
                <IconGrid size={16} />
              </span>
              <span className="settings-nav-text">
                <span>{v.name}</span>
                <span className="settings-nav-hint">{v.builtin ? "Built in" : plural(v.spec.widgets.length, "widget")}</span>
              </span>
            </a>
          ))}
        </nav>
        <div className="dash-main">
          {!views.data && !views.error && <Spinner />}
          {views.data && !current && (
            <EmptyState title="Dashboard not found" testId="not-found">
              <a href="#/dashboards">All dashboards</a>
            </EmptyState>
          )}
          {current && <Dashboard key={current.id} view={current} onChanged={views.reload} onDuplicate={() => setCreating({ spec: current.spec, name: `${current.name} (copy)` })} />}
        </div>
      </div>
      {creating && (
        <ViewNameModal
          title={creating.name ? "Duplicate dashboard" : "New dashboard"}
          initial={creating.name}
          onClose={() => setCreating(null)}
          onSubmit={async (name) => {
            const v = await api.createView(name, creating.spec);
            emitChange();
            setCreating(null);
            views.reload();
            navigate(`/dashboards/${v.id}`);
          }}
        />
      )}
    </div>
  );
}

function Dashboard({ view, onChanged, onDuplicate }: { view: SavedView; onChanged: () => void; onDuplicate: () => void }) {
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async (spec: ViewSpec) => {
    setErr(null);
    try {
      await api.updateView(view.id, { spec });
      onChanged();
    } catch (e) {
      setErr(toError(e));
    }
  };
  const widgets = view.spec.widgets;
  return (
    <>
      <header className="dash-header">
        <h2 data-testid="dashboard-title">{view.name}</h2>
        <div className="page-actions">
          {view.builtin ? (
            <button className="btn btn-sm" onClick={onDuplicate} data-testid="duplicate-dashboard">
              Duplicate to customize
            </button>
          ) : (
            <>
              <button className="btn btn-sm" onClick={() => setEditing((x) => !x)} aria-pressed={editing} data-testid="edit-dashboard">
                {editing ? "Done" : "Edit"}
              </button>
              <button
                className="btn btn-sm btn-ghost btn-danger"
                data-testid="delete-dashboard"
                onClick={() =>
                  confirm(`Delete the “${view.name}” dashboard?`) &&
                  void api.deleteView(view.id).then(() => (emitChange(), onChanged(), navigate("/dashboards")), (e: unknown) => setErr(toError(e)))
                }
              >
                <IconTrash size={13} /> Delete
              </button>
            </>
          )}
        </div>
      </header>
      {err && <ErrorBanner error={err} />}
      {editing && <AddWidget onAdd={(w) => void save({ widgets: [...widgets, w] })} />}
      {widgets.length === 0 && <EmptyState title="No widgets yet">Use Edit to add searches, projects, collections and lists.</EmptyState>}
      <div className="dash-grid">
        {widgets.map((w, i) => (
          <div key={`${i}:${JSON.stringify(w)}`} className="dash-cell" data-testid="dashboard-widget">
            <Widget widget={w} />
            {editing && (
              <div className="widget-tools">
                <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => void save({ widgets: swap(widgets, i, i - 1) })}>
                  <IconArrowUp />
                </button>
                <button className="icon-btn" aria-label="Move down" disabled={i === widgets.length - 1} onClick={() => void save({ widgets: swap(widgets, i, i + 1) })}>
                  <IconArrowDown />
                </button>
                <button className="icon-btn" aria-label="Remove widget" onClick={() => void save({ widgets: widgets.filter((_, j) => j !== i) })} data-testid="remove-widget">
                  <IconTrash size={13} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

const swap = <T,>(xs: T[], i: number, j: number) => {
  const out = [...xs];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
};

function WidgetCard({ title, href, children, testId }: { title: ReactNode; href?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="card digest-section" data-testid={testId}>
      <header className="section-header">
        <h2>{href ? <a href={href}>{title}</a> : title}</h2>
      </header>
      {children}
    </section>
  );
}

function Widget({ widget: w }: { widget: ViewWidget }) {
  switch (w.kind) {
    case "search":
      return <SearchWidget widget={w} />;
    case "project":
      return <ProjectWidget id={w.project_id} />;
    case "collection":
      return <CollectionWidget id={w.collection_id} />;
    case "project_activity":
      return <ActivityWidget />;
    default:
      return <DigestWidget kind={w.kind} />;
  }
}

function SearchWidget({ widget: w }: { widget: Extract<ViewWidget, { kind: "search" }> }) {
  const res = useAsync(() => api.search({ q: w.q, filters: resolveFilters(w.filters), limit: w.limit ?? 8 }), [JSON.stringify(w)]);
  // "Open in search" carries every filter the widget uses.
  const f = w.filters ?? {};
  const qs = new URLSearchParams();
  if (w.q) qs.set("q", w.q);
  for (const t of f.doc_type ?? []) qs.append("type", t);
  for (const v of f.source ?? []) qs.append("source", v);
  for (const v of f.tag ?? []) qs.append("tag", v);
  for (const v of f.person ?? []) qs.append("person", v);
  for (const v of f.project ?? []) qs.append("project", v);
  if (f.pinned) qs.set("pinned", "1");
  if (typeof f.seen_after === "number" && f.seen_after < 0) {
    const days = -f.seen_after;
    qs.set("time", days <= 7 ? "7d" : days <= 30 ? "30d" : "90d");
  }
  return (
    <WidgetCard title={w.title} href={`#/search?${qs.toString()}`}>
      {res.error ? <ErrorBanner error={res.error} /> : !res.data ? <Spinner /> : <DocList docs={res.data.hits.map((h) => h.doc)} empty={<p className="section-empty">Nothing matches yet.</p>} />}
    </WidgetCard>
  );
}

function ProjectWidget({ id }: { id: string }) {
  const p = useAsync(() => api.project(id), [id]);
  if (p.error) return <WidgetCard title="Project">{<p className="section-empty">That project no longer exists.</p>}</WidgetCard>;
  return (
    <WidgetCard
      title={
        <>
          <IconFolder size={15} /> {p.data?.name ?? "Project"}
        </>
      }
      href={projectHref(id)}
    >
      {!p.data ? <Spinner /> : <DocList docs={p.data.docs.slice(0, 6)} empty={<p className="section-empty">No documents yet.</p>} />}
    </WidgetCard>
  );
}

function CollectionWidget({ id }: { id: string }) {
  const c = useAsync(() => api.collection(id), [id]);
  if (c.error) return <WidgetCard title="Collection">{<p className="section-empty">That collection no longer exists.</p>}</WidgetCard>;
  return (
    <WidgetCard
      title={
        <>
          <IconLayers size={15} /> {c.data?.name ?? "Collection"}
        </>
      }
      href={`#/collections/${id}`}
    >
      {!c.data ? <Spinner /> : <DocList docs={c.data.items.slice(0, 6).map((i) => i.doc)} empty={<p className="section-empty">Empty.</p>} />}
    </WidgetCard>
  );
}

const DIGEST_TITLES = { recent: "Recent", pinned: "Pinned", frequent: "Most opened" } as const;

function DigestWidget({ kind }: { kind: "recent" | "pinned" | "frequent" }) {
  const d = useAsync(() => api.digest(), []);
  return (
    <WidgetCard title={DIGEST_TITLES[kind]} testId={`widget-${kind}`}>
      {!d.data ? <Spinner /> : <DocList docs={d.data[kind].slice(0, 6)} empty={<p className="section-empty">Nothing here yet.</p>} />}
    </WidgetCard>
  );
}

function ActivityWidget() {
  const a = useAsync(() => api.projectActivity(), []);
  return (
    <WidgetCard title="Recent project activity" testId="widget-project-activity">
      {!a.data ? (
        <Spinner />
      ) : a.data.length === 0 ? (
        <p className="section-empty">No project documents opened in the last two weeks.</p>
      ) : (
        <div className="activity-groups">
          {a.data.map(({ project, docs }) => (
            <div key={project.id} className="activity-group">
              <a className="activity-group-title" href={projectHref(project.id)}>
                <IconFolder size={14} /> {project.name}
              </a>
              <DocList docs={docs} />
            </div>
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

function AddWidget({ onAdd }: { onAdd: (w: ViewWidget) => void }) {
  const projects = useAsync(() => api.projects(), []);
  const collections = useAsync(() => api.collections(), []);
  const [kind, setKind] = useState<ViewWidget["kind"]>("search");
  const [q, setQ] = useState("");
  const [target, setTarget] = useState("");
  const add = () => {
    if (kind === "search") onAdd({ kind, title: q.trim() || "Search", q: q.trim() });
    else if (kind === "project" && target) onAdd({ kind, project_id: target });
    else if (kind === "collection" && target) onAdd({ kind, collection_id: target });
    else if (kind !== "project" && kind !== "collection") onAdd({ kind } as ViewWidget);
    setQ("");
    setTarget("");
  };
  return (
    <div className="card add-widget" data-testid="add-widget">
      <select className="input" value={kind} onChange={(e) => (setKind(e.target.value as ViewWidget["kind"]), setTarget(""))} aria-label="Widget" data-testid="widget-kind">
        <option value="search">Search results</option>
        <option value="project">A project</option>
        <option value="collection">A collection</option>
        <option value="recent">Recent</option>
        <option value="pinned">Pinned</option>
        <option value="frequent">Most opened</option>
        <option value="project_activity">Recent project activity</option>
      </select>
      {kind === "search" && <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for… (empty = newest)" aria-label="Search" data-testid="widget-query" />}
      {kind === "project" && (
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Project" data-testid="widget-project">
          <option value="">Choose a project…</option>
          {projectTree(projects.data ?? []).map(({ project: p, depth }) => (
            <option key={p.id} value={p.id}>
              {"  ".repeat(depth)}
              {p.name}
            </option>
          ))}
        </select>
      )}
      {kind === "collection" && (
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Collection" data-testid="widget-collection">
          <option value="">Choose a collection…</option>
          {(collections.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <button className="btn btn-primary" onClick={add} disabled={(kind === "project" || kind === "collection") && !target} data-testid="add-widget-submit">
        <IconPlus size={14} /> Add
      </button>
    </div>
  );
}

export function ViewNameModal({ title, onClose, onSubmit, initial = "" }: { title: string; onClose: () => void; onSubmit: (name: string) => Promise<void>; initial?: string }) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState<Error | null>(null);
  return (
    <Modal title={title} onClose={onClose} testId="view-name-modal">
      <form
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(name.trim()).catch((x: unknown) => setErr(toError(x)));
        }}
      >
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" data-testid="view-name" maxLength={80} />
        {err && <ErrorBanner error={err} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim()} data-testid="view-name-submit">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
