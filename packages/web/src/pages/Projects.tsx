import { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, type ProjectDetail, type ProjectSummary } from "@faber/shared";
import { api, DOC_TYPE_LABELS, emitChange, navigate, plural, relativeTime, toError, useAsync } from "../lib";
import { IconFolder, IconPlus, IconRefresh, IconSearch, IconSparkle, IconX } from "../components/icons";
import { DocList, EmptyState, ErrorBanner, LoadError, Modal, PageHeader, Spinner, TypeBadge } from "../components/ui";

export { projectTint } from "@faber/ui";
import { projectTint } from "@faber/ui";

const searchInProject = (name: string, q = "") => `#/search?${new URLSearchParams({ ...(q ? { q } : {}), project: name }).toString()}`;
export const projectHref = (id: string) => `#/projects/${encodeURIComponent(id)}`;

/** Projects grouped under their parents: [top-level project, its descendants (depth-first)]. */
export function projectTree(list: ProjectSummary[]): { project: ProjectSummary; depth: number }[] {
  const byParent = new Map<string | null, ProjectSummary[]>();
  const ids = new Set(list.map((p) => p.id));
  for (const p of list) {
    const parent = p.parent_id && ids.has(p.parent_id) ? p.parent_id : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), p]);
  }
  const out: { project: ProjectSummary; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const p of byParent.get(parent) ?? []) {
      out.push({ project: p, depth });
      if (depth < 8) walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function ProjectsPage() {
  const projects = useAsync(() => api.projects(), []);
  const [creating, setCreating] = useState(false);
  const tree = useMemo(() => projectTree(projects.data ?? []), [projects.data]);
  const top = tree.filter((t) => t.depth === 0).map((t) => t.project);
  const childrenOf = (id: string) => (projects.data ?? []).filter((p) => p.parent_id === id);
  return (
    <div className="page">
      <PageHeader
        title="Projects"
        subtitle="Inferred from your documents as Faber reads them. Rename, merge or regroup anything; your corrections stick."
        actions={
          <>
            <a className="btn" href="#/inbox" data-testid="projects-review">
              Review suggestions
            </a>
            <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-project">
              <IconPlus size={14} /> New project
            </button>
          </>
        }
      />
      {projects.error && <LoadError error={projects.error} onRetry={projects.reload} what="Projects" backHref="#/" backLabel="Go home" />}
      {!projects.data && !projects.error && (
        <div className="center-pad">
          <Spinner size={18} />
        </div>
      )}
      {projects.data?.length === 0 && (
        <EmptyState title="No projects yet" icon={<IconFolder size={22} />} testId="projects-empty">
          Projects appear here once enriched documents mention them, such as a codename or an initiative. You can also make one by hand.
        </EmptyState>
      )}
      {top.length > 0 && (
        <div className="project-grid" data-testid="project-grid">
          {top.map((p) => (
            <ProjectCard key={p.id} project={p} tint={projectTint(p.id)} detailed subprojects={childrenOf(p.id)} />
          ))}
        </div>
      )}
      {creating && <NewProjectModal projects={projects.data ?? []} onClose={() => setCreating(false)} />}
    </div>
  );
}

export function ProjectCard({
  project: p,
  tint,
  detailed,
  selected,
  subprojects = [],
}: {
  project: ProjectSummary;
  tint: string;
  detailed?: boolean;
  selected?: boolean;
  subprojects?: ProjectSummary[];
}) {
  return (
    <div className={`project-card${selected ? " is-selected" : ""}`} data-testid="project-card" data-tint={tint}>
      <a className="project-card-link" href={projectHref(p.id)}>
        <span className="project-folder">
          <IconFolder size={20} />
        </span>
        <span className="project-name">{p.name}</span>
        <span className="project-meta">
          {plural(p.doc_count, "doc")}
          {p.doc_count > 0 && (p.active ? " · Active" : ` · ${relativeTime(p.last_seen_at)}`)}
        </span>
        {detailed && p.top_people.length > 0 && <span className="project-people">{p.top_people.join(", ")}</span>}
      </a>
      {detailed && subprojects.length > 0 && (
        <ul className="subproject-list" aria-label={`Subprojects of ${p.name}`}>
          {subprojects.map((c) => (
            <li key={c.id}>
              <a href={projectHref(c.id)}>
                <IconFolder size={13} /> {c.name} <span className="faint">{c.doc_count}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const typeNoun = (label: string, count: number) => {
  // Keep acronyms ("PRD", "OKRs") as written; lower-case the rest.
  const noun = /^[A-Z]{2,}/.test(label) ? label : label.toLowerCase();
  if (count > 1) return `${count} ${noun.endsWith("s") ? noun : `${noun}s`}`;
  // Plural-form labels ("meeting notes", "OKRs") take no article.
  if (noun.endsWith("s")) return noun;
  return `${/^[aeiouAEIOU]/.test(noun) || /^[FHLMNRSX][A-Z]/.test(noun) ? "an" : "a"} ${noun}`;
};

const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

/** A plain-language overview built from the project's documents (shown until the AI overview exists). */
function factsLine(p: ProjectDetail): string {
  const parts: string[] = [];
  const types = p.doc_types.filter((t) => t.doc_type !== "other").slice(0, 3);
  if (types.length) parts.push(`Includes ${list(types.map((t) => typeNoun(DOC_TYPE_LABELS[t.doc_type], t.count)))}.`);
  const people = p.people.slice(0, 3).map((x) => x.name);
  if (people.length) parts.push(`${list(people)} ${people.length > 1 ? "appear" : "appears"} most often.`);
  if (p.doc_count) parts.push(p.active ? `Active: last opened ${relativeTime(p.last_seen_at)}.` : `Quiet since ${relativeTime(p.last_seen_at)}.`);
  return parts.join(" ") || "No documents yet. Add some from a document’s details, or from the browser extension.";
}

type Dialog = "rename" | "move" | "merge" | "subproject" | null;

export function ProjectPage({ id }: { id: string }) {
  // Tagged with the id it was fetched for, so a redirect never acts on the previous page's data.
  const project = useAsync(async () => ({ forId: id, project: await api.project(id) }), [id]);
  // Never show (or act on) the previous project's data while this one loads.
  const p = project.data?.forId === id ? project.data.project : undefined;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [err, setErr] = useState<Error | null>(null);

  // A merged project's old id resolves to where it went: show the canonical URL.
  useEffect(() => {
    if (p && p.id !== id) navigate(`/projects/${encodeURIComponent(p.id)}`, { replace: true });
  }, [project.data, p, id]);

  const act = async (fn: () => Promise<unknown>, then?: () => void) => {
    setErr(null);
    try {
      await fn();
      emitChange();
      then?.();
    } catch (e) {
      setErr(toError(e));
    }
  };

  if (project.error)
    return (
      <div className="page">
        <LoadError error={project.error} onRetry={project.reload} what="Project" backHref="#/projects" backLabel="All projects" />
      </div>
    );
  if (!p)
    return (
      <div className="page">
        <div className="center-pad">
          <Spinner size={18} />
        </div>
      </div>
    );
  const recent = p.docs.filter((d) => d.last_seen_at >= Date.now() - 14 * 86_400_000);
  const own = new Set(p.own_doc_ids);
  return (
    <div className="page" data-testid="project-page">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <a href="#/projects">Projects</a>
        {p.ancestors.map((a) => (
          <span key={a.id}>
            <span aria-hidden="true">/</span> <a href={projectHref(a.id)}>{a.name}</a>
          </span>
        ))}
        <span aria-hidden="true">/</span> <span>{p.name}</span>
      </nav>
      <PageHeader
        title={
          <span className="title-with-icon">
            <span className="project-folder" data-tint={projectTint(p.id)}>
              <IconFolder size={20} />
            </span>
            {p.name}
          </span>
        }
        subtitle={
          <>
            {plural(p.doc_count, "doc")} · {plural(p.people.length, "person", "people")}
            {p.active ? " · Active" : ""}
            {p.aliases.length > 0 && <span className="faint"> · also called {p.aliases.slice(0, 3).join(", ")}</span>}
          </>
        }
        actions={
          <>
            <a className="btn" href={searchInProject(p.id)} data-testid="project-search">
              <IconSearch size={14} /> Search in project
            </a>
            <a className="btn btn-primary" href={`#/ask?project=${encodeURIComponent(p.id)}`} data-testid="project-ask">
              <IconSparkle size={14} /> Ask about it
            </a>
          </>
        }
      />
      <div className="organize-bar" role="toolbar" aria-label="Organize this project" data-testid="organize-bar">
        <button className="btn btn-sm btn-ghost" onClick={() => setDialog("rename")} data-testid="project-rename">
          Rename
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setDialog("subproject")} data-testid="project-add-sub">
          Add subproject
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setDialog("move")} data-testid="project-move">
          Move…
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setDialog("merge")} data-testid="project-merge">
          Merge into…
        </button>
        <button
          className="btn btn-sm btn-ghost btn-danger"
          data-testid="project-hide"
          onClick={() =>
            confirm(`Treat “${p.name}” as not a project? It disappears from lists; its documents stay. You can undo this in Settings → Organization.`) &&
            void act(() => api.updateProject(p.id, { hidden: true }), () => navigate("/projects"))
          }
        >
          Not a project
        </button>
        {p.manual && <span className="pill pill-muted">Made by hand</span>}
      </div>
      {err && <ErrorBanner error={err} />}

      <AiOverview project={p} onWritten={project.reload} />
      <section className="card project-overview" data-testid="project-overview">
        <p>{factsLine(p)}</p>
        <div className="chip-row">
          {p.doc_types.map((t) => (
            <span key={t.doc_type} className="chip-count">
              <TypeBadge type={t.doc_type} /> {t.count}
            </span>
          ))}
        </div>
      </section>

      <div className="two-col">
        <div className="stack">
          {p.children.length > 0 && (
            <Section title="Subprojects" testId="project-children">
              <ul className="plain-list">
                {p.children.map((c) => (
                  <li key={c.id}>
                    <a href={projectHref(c.id)}>
                      <IconFolder size={13} /> {c.name}
                    </a>{" "}
                    <span className="faint">{plural(c.doc_count, "doc")}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {p.decisions.length > 0 && (
            <Section title="Decisions" hint="Found in its documents" testId="project-decisions">
              <ul className="decision-list">
                {p.decisions.map((d, i) => (
                  <li key={`${d.doc_id}-${i}`}>
                    <span>{d.text}</span>
                    <a className="faint small" href={`#/doc/${d.doc_id}`}>
                      {d.doc_title} · {relativeTime(d.at)}
                    </a>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {p.key_docs.length > 0 && (
            <Section title="Key documents" hint="Pinned, then most opened" testId="project-key-docs">
              <DocList docs={p.key_docs} extra={(d) => `${d.visit_count}×`} />
            </Section>
          )}
          {recent.length > 0 && (
            <Section title="Recent activity" hint="Last 14 days" testId="project-recent">
              <DocList docs={recent.slice(0, 8)} />
            </Section>
          )}
          {p.doc_count > 0 && (
          <Section title="All documents" hint={plural(p.doc_count, "doc")} testId="project-docs">
            <DocList
              docs={p.docs}
              actions={(d) =>
                own.has(d.id) ? (
                  <button
                    className="icon-btn"
                    title={`Not part of ${p.name}`}
                    aria-label={`Remove ${d.title} from ${p.name}`}
                    data-testid="remove-from-project"
                    onClick={() => void act(() => api.setDocProject(d.id, p.id, false), project.reload)}
                  >
                    <IconX size={13} />
                  </button>
                ) : null
              }
            />
          </Section>
          )}
        </div>
        <div className="stack">
          {p.people.length > 0 && (
            <Section title="People" testId="project-people">
              <ul className="plain-list">
                {p.people.map((x) => (
                  <li key={x.id}>
                    <a href={`#/people/${x.id}`}>{x.name}</a> <span className="faint">{plural(x.count, "doc")}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {p.meetings.length > 0 && (
            <Section title="Meetings" testId="project-meetings">
              <DocList docs={p.meetings} />
            </Section>
          )}
          {p.topics.length > 0 && (
            <Section title="Topics" hint="Shared across its docs" testId="project-topics">
              <div className="chip-row">
                {p.topics.map((t) => (
                  <a key={t.tag} className="chip" href={`#/search?${new URLSearchParams({ tag: t.tag, project: p.id }).toString()}`}>
                    #{t.tag} <span className="faint">{t.count}</span>
                  </a>
                ))}
              </div>
            </Section>
          )}
          {p.related_projects.length > 0 && (
            <Section title="Related projects" testId="project-related">
              <ul className="plain-list">
                {p.related_projects.map((r) => (
                  <li key={r.id}>
                    <a href={projectHref(r.id)}>{r.name}</a> <span className="faint">{plural(r.shared, "shared doc")}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>

      {dialog === "rename" && (
        <NameModal
          title="Rename project"
          initial={p.name}
          submit="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(name) => api.updateProject(p.id, { name }).then(() => (emitChange(), project.reload(), setDialog(null)))}
        />
      )}
      {dialog === "subproject" && (
        <NameModal
          title={`New subproject of ${p.name}`}
          initial=""
          submit="Create"
          onClose={() => setDialog(null)}
          onSubmit={(name) => api.createProject(name, p.id).then((c) => (emitChange(), setDialog(null), navigate(`/projects/${encodeURIComponent(c.id)}`)))}
        />
      )}
      {(dialog === "move" || dialog === "merge") && <MoveMergeModal mode={dialog} project={p} onClose={() => setDialog(null)} onDone={project.reload} />}
    </div>
  );
}

/** The AI overview: written on first visit when a model is available, refreshed on demand or when stale. */
function AiOverview({ project: p, onWritten }: { project: ProjectDetail; onWritten: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const tried = useRef<string | null>(null);
  const enriched = p.docs.some((d) => d.enrichment);
  const write = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.writeProjectSummary(p.id);
      onWritten();
    } catch (e) {
      setErr(toError(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!p.summary && enriched && tried.current !== p.id) {
      tried.current = p.id;
      void write();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, p.summary, enriched]);
  if (!enriched) return null;
  return (
    <section className="card ai-overview" data-testid="project-ai-overview" aria-busy={busy}>
      <header className="section-header">
        <span className="section-icon">
          <IconSparkle size={16} />
        </span>
        <h2>Overview</h2>
        {p.summary?.stale && !busy && <span className="pill pill-warn">Documents changed since</span>}
        <button className="btn btn-sm btn-ghost ai-refresh" onClick={() => void write()} disabled={busy} data-testid="project-ai-refresh">
          {busy ? <Spinner size={12} /> : <IconRefresh size={13} />} {p.summary ? "Rewrite" : "Write"}
        </button>
      </header>
      {err && !(err instanceof ApiRequestError && err.status === 409) && <p className="muted small">The overview couldn’t be written: {err.message}</p>}
      {p.summary ? (
        <>
          <p className="ai-text">{p.summary.text}</p>
          <p className="faint small">
            {p.summary.model} · {relativeTime(p.summary.created_at)} · from the documents’ summaries
          </p>
        </>
      ) : (
        busy && <p className="muted">Reading the project’s documents…</p>
      )}
    </section>
  );
}

function NameModal({ title, initial, submit, onClose, onSubmit }: { title: string; initial: string; submit: string; onClose: () => void; onSubmit: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} testId="name-modal">
      <form
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          onSubmit(name.trim()).catch((x: unknown) => (setErr(toError(x)), setBusy(false)));
        }}
      >
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" data-testid="name-input" maxLength={120} />
        {err && <ErrorBanner error={err} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} data-testid="name-submit">
            {submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function NewProjectModal({ projects, onClose, parentId = "" }: { projects: ProjectSummary[]; onClose: () => void; parentId?: string }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState(parentId);
  const [err, setErr] = useState<Error | null>(null);
  return (
    <Modal title="New project" onClose={onClose} testId="new-project-modal">
      <form
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          api.createProject(name.trim(), parent || null).then(
            (c) => {
              emitChange();
              onClose();
              navigate(`/projects/${encodeURIComponent(c.id)}`);
            },
            (x: unknown) => setErr(toError(x)),
          );
        }}
      >
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="new-project-name" maxLength={120} />
        </label>
        <label className="field">
          <span>Inside</span>
          <select className="input" value={parent} onChange={(e) => setParent(e.target.value)} data-testid="new-project-parent">
            <option value="">— Top level —</option>
            {projectTree(projects).map(({ project: x, depth }) => (
              <option key={x.id} value={x.id}>
                {"  ".repeat(depth)}
                {x.name}
              </option>
            ))}
          </select>
        </label>
        {err && <ErrorBanner error={err} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim()} data-testid="new-project-submit">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MoveMergeModal({ mode, project: p, onClose, onDone }: { mode: "move" | "merge"; project: ProjectDetail; onClose: () => void; onDone: () => void }) {
  const all = useAsync(() => api.projects(), []);
  const [target, setTarget] = useState(mode === "move" ? (p.parent_id ?? "") : "");
  const [err, setErr] = useState<Error | null>(null);
  // Not itself, and for a move not one of its own subprojects.
  const descendants = useMemo(() => {
    const out = new Set([p.id]);
    const list = all.data ?? [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of list) if (x.parent_id && out.has(x.parent_id) && !out.has(x.id)) (out.add(x.id), (grew = true));
    }
    return out;
  }, [all.data, p.id]);
  // Neither can go into itself or its own subprojects.
  const options = projectTree(all.data ?? []).filter(({ project: x }) => !descendants.has(x.id));
  const submit = async () => {
    setErr(null);
    try {
      if (mode === "merge") {
        const merged = await api.mergeProject(p.id, target);
        emitChange();
        onClose();
        navigate(`/projects/${encodeURIComponent(merged.id)}`);
      } else {
        await api.updateProject(p.id, { parent_id: target });
        emitChange();
        onClose();
        onDone();
      }
    } catch (e) {
      setErr(toError(e));
    }
  };
  return (
    <Modal title={mode === "merge" ? `Merge “${p.name}” into…` : `Move “${p.name}”`} onClose={onClose} testId="move-merge-modal">
      <div className="stack-form">
        <p className="muted small">
          {mode === "merge"
            ? "Use this when two names are the same project. Its documents, subprojects and other spellings move to the one you pick."
            : "Choose the project this belongs inside, or the top level."}
        </p>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="target-project" aria-label="Project">
          {mode === "move" ? <option value="">— Top level —</option> : <option value="">Choose a project…</option>}
          {options.map(({ project: x, depth }) => (
            <option key={x.id} value={x.id}>
              {"  ".repeat(depth)}
              {x.name}
            </option>
          ))}
        </select>
        {err && <ErrorBanner error={err} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={mode === "merge" && !target} onClick={() => void submit()} data-testid="move-merge-submit">
            {mode === "merge" ? "Merge" : "Move"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Section({ title, hint, children, testId }: { title: string; hint?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="card" data-testid={testId}>
      <header className="section-header">
        <h2>{title}</h2>
        {hint && <span className="section-hint">{hint}</span>}
      </header>
      {children}
    </section>
  );
}
