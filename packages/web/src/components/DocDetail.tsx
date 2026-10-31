import { useEffect, useRef, useState } from "react";
import type { DocDetail as DocDetailT } from "@faber/shared";
import { api, docTitle, emitChange, formatWritten, fullDate, hostOf, navigate, plural, relativeTime, toError, useAsync } from "../lib";
import { IconCalendar, IconExternal, IconPin, IconPlus, IconPushpin, IconRefresh, IconTrash, IconX, SourceIcon } from "./icons";
import { ContentState, ErrorBanner, LoadError, Spinner, TypeBadge, useDrawer } from "./ui";

export function DocDetailView({ id, onForget }: { id: string; onForget?: () => void }) {
  const doc = useAsync(() => api.doc(id), [id]);
  if (doc.error && !doc.data) return <LoadError error={doc.error} onRetry={doc.reload} what="Document" backHref="#/search" backLabel="Back to search" />;
  if (!doc.data)
    return (
      <div className="detail-loading">
        <Spinner size={18} />
      </div>
    );
  return <DocDetailBody doc={doc.data} onForget={onForget} />;
}

function DocDetailBody({ doc, onForget }: { doc: DocDetailT; onForget?: () => void }) {
  const e = doc.enrichment;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      emitChange();
    } catch (x) {
      setErr(x instanceof Error ? x : new Error(String(x)));
    } finally {
      setBusy(null);
    }
  };

  const forget = () => {
    if (!confirm(`Forget "${docTitle(doc)}"? Its visits, text, tags and note are deleted from Faber. The Google doc itself is untouched.`)) return;
    void act("forget", async () => {
      await api.deleteDoc(doc.id);
      onForget?.();
    });
  };

  return (
    <article className="detail" data-testid="doc-detail" data-doc-id={doc.id}>
      <header className="detail-header">
        <div className="detail-title-row">
          <SourceIcon source={doc.source} size={20} />
          <h2 className="detail-title" data-testid="detail-title">
            {docTitle(doc)}
          </h2>
        </div>
        <div className="detail-actions">
          <a className="btn btn-primary btn-sm" href={doc.canonical_url} target="_blank" rel="noreferrer" data-testid="detail-open">
            Open <IconExternal size={13} />
          </a>
          <button
            className={`btn btn-sm ${doc.pinned ? "btn-pinned" : ""}`}
            aria-pressed={doc.pinned}
            data-testid="detail-pin"
            disabled={busy === "pin"}
            onClick={() => act("pin", () => api.setPinned(doc.id, !doc.pinned))}
          >
            <IconPin size={13} filled={doc.pinned} /> {doc.pinned ? "Pinned" : "Pin"}
          </button>
        </div>
      </header>

      {err && <ErrorBanner error={err} />}

      {e ? (
        <p className="detail-summary" data-testid="detail-summary">
          {e.summary}
        </p>
      ) : (
        <ContentState doc={doc} />
      )}
      {e && doc.content_error && <ContentState doc={doc} />}

      <dl className="facts">
        {e && (
          <>
            <dt>Type</dt>
            <dd>
              <TypeBadge type={e.doc_type} />
            </dd>
          </>
        )}
        {e?.written_at && (
          <>
            <dt>Written</dt>
            <dd>~{formatWritten(e.written_at)}</dd>
          </>
        )}
        <dt>Opened</dt>
        <dd title={fullDate(doc.last_seen_at)}>
          {relativeTime(doc.last_seen_at)} · {doc.visit_count}× since {new Date(doc.first_seen_at).toLocaleDateString(undefined, { month: "short", year: "numeric" })}
        </dd>
        {doc.people.length > 0 && (
          <>
            <dt>People</dt>
            <dd className="chip-row">
              {doc.people.map((p) => (
                <a key={p.id} className="chip chip-person" href={`#/people/${p.id}`}>
                  {p.name}
                </a>
              ))}
            </dd>
          </>
        )}
        {e && e.teams.length > 0 && (
          <>
            <dt>Teams</dt>
            <dd className="chip-row">
              {e.teams.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>

      <section className="detail-section">
        <h3>Tags</h3>
        <TagEditor doc={doc} />
      </section>

      <section className="detail-section">
        <h3>Your note</h3>
        <NoteEditor doc={doc} />
      </section>

      <section className="detail-section">
        <h3>Projects</h3>
        <ProjectsEditor docId={doc.id} />
      </section>

      <section className="detail-section">
        <h3>Collections</h3>
        <CollectionsEditor doc={doc} />
      </section>

      {doc.meetings.length > 0 && (
        <section className="detail-section">
          <h3>Meetings</h3>
          <div className="link-list">
            {doc.meetings.map((m) => (
              <a key={m.id} href={`#/meetings/${m.id}`} className="link-row">
                <IconCalendar size={14} />
                <span>{m.title}</span>
                <span className="muted">{plural(m.doc_count, "doc")}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3>Related</h3>
        <RelatedDocs id={doc.id} />
      </section>

      {doc.recent_visits.length > 0 && (
        <section className="detail-section">
          <h3>Recent visits</h3>
          <ul className="visits" data-testid="recent-visits">
            {doc.recent_visits.slice(0, 6).map((v, i) => (
              <li key={`${v.ts}-${i}`}>
                <span title={fullDate(v.ts)}>{relativeTime(v.ts)}</span>
                {v.referrer && <span className="muted">from {hostOf(v.referrer) ?? v.referrer}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="detail-footer">
        <div className="provenance" data-testid="provenance">
          {e ? (
            <>
              Enriched by <code>{e.provider}/{e.model}</code> {relativeTime(e.created_at)} · prompt v{e.prompt_version}
              {e.confidence < 0.5 && <span className="muted"> · low confidence</span>}
            </>
          ) : (
            <span className="muted">Not enriched yet</span>
          )}
        </div>
        <div className="detail-footer-actions">
          <button className="btn btn-sm btn-ghost" disabled={!doc.has_content || busy === "enrich"} onClick={() => act("enrich", () => api.reenrich(doc.id))} data-testid="detail-reenrich" title={doc.has_content ? "Run enrichment again" : "No text yet"}>
            {busy === "enrich" ? <Spinner size={12} /> : <IconRefresh size={13} />} Re-enrich
          </button>
          <button className="btn btn-sm btn-ghost btn-danger" onClick={forget} data-testid="detail-forget">
            <IconTrash size={13} /> Forget
          </button>
        </div>
      </footer>
    </article>
  );
}

function TagEditor({ doc }: { doc: DocDetailT }) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const t = value.trim();
    if (!t) return;
    if (t.length > TAG_MAX) {
      setError(`Tags can be at most ${TAG_MAX} characters.`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.addTag(doc.id, t);
      setValue("");
      emitChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="tag-editor">
      {doc.tags.map((t) => (
        <span key={t.tag} className={`tag tag-${t.source}`} data-testid="tag" data-tag={t.tag} title={t.source === "auto" ? "Added by the model" : "Added by you"}>
          #{t.tag}
          <button
            className="tag-remove"
            aria-label={`Remove tag ${t.tag}`}
            onClick={async () => {
              await api.removeTag(doc.id, t.tag);
              emitChange();
            }}
          >
            <IconX size={10} />
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        placeholder={doc.tags.length ? "Add tag…" : "Add a tag…"}
        value={value}
        disabled={pending}
        maxLength={TAG_MAX}
        aria-invalid={!!error}
        aria-describedby={error ? "tag-error" : undefined}
        data-testid="tag-input"
        aria-label="Add tag"
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void add();
          }
        }}
      />
      {error && (
        <span className="field-error" id="tag-error" role="alert" data-testid="tag-error">
          {error}
        </span>
      )}
    </div>
  );
}

const TAG_MAX = 60;

function NoteEditor({ doc }: { doc: DocDetailT }) {
  const [value, setValue] = useState(doc.note ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const saved = useRef(doc.note ?? "");

  useEffect(() => {
    // Only adopt server changes when the user is not mid-edit.
    if (value === saved.current) setValue(doc.note ?? "");
    saved.current = doc.note ?? "";
    // Intentionally not re-run when the omitted dependencies change.
  }, [doc.note]);

  const save = async () => {
    const next = value.trim();
    if (next === (saved.current ?? "").trim()) return;
    setStatus("saving");
    try {
      await api.setNote(doc.id, next || null);
      saved.current = next;
      setStatus("saved");
      emitChange();
      setTimeout(() => setStatus("idle"), 1500);
    } catch {
      setStatus("idle");
    }
  };

  return (
    <div className="note-editor">
      <textarea
        value={value}
        rows={2}
        maxLength={500}
        placeholder="Why this matters, or where you use it. One line is plenty."
        data-testid="note-input"
        aria-label="Your note"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="note-status" aria-live="polite" data-testid="note-status">
        {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : value !== saved.current ? "⌘↵ to save" : ""}
      </div>
    </div>
  );
}

/** The projects this doc is in (inferred or set by hand); add it to another, or take it out. */
function ProjectsEditor({ docId }: { docId: string }) {
  const mine = useAsync(() => api.docProjects(docId), [docId]);
  const all = useAsync(() => api.projects(), []);
  const [value, setValue] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  const set = async (project: string, inProject: boolean) => {
    setErr(null);
    try {
      await api.setDocProject(docId, project, inProject);
      emitChange();
      mine.reload();
    } catch (e) {
      setErr(toError(e));
    }
  };
  const memberIds = new Set((mine.data ?? []).map((p) => p.id));
  return (
    <div className="doc-projects" data-testid="doc-projects">
      <div className="chip-row">
        {(mine.data ?? []).map((p) => (
          <span key={p.id} className="chip chip-project" data-testid="doc-project">
            <a href={`#/projects/${encodeURIComponent(p.id)}`}>{p.name}</a>
            <button className="chip-x" aria-label={`Not part of ${p.name}`} title="Not part of this project" onClick={() => void set(p.id, false)}>
              ×
            </button>
          </span>
        ))}
        {mine.data?.length === 0 && <span className="muted small">Not in a project.</span>}
      </div>
      <form
        className="inline-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void set(value.trim(), true).then(() => setValue(""));
        }}
      >
        <input
          className="input input-sm"
          list={`projects-${docId}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Add to a project (or name a new one)…"
          aria-label="Add to project"
          data-testid="doc-project-input"
        />
        <datalist id={`projects-${docId}`}>
          {(all.data ?? [])
            .filter((p) => !memberIds.has(p.id))
            .map((p) => (
              <option key={p.id} value={p.name} />
            ))}
        </datalist>
      </form>
      {err && <p className="field-error">{err.message}</p>}
    </div>
  );
}

function CollectionsEditor({ doc }: { doc: DocDetailT }) {
  const all = useAsync(() => api.collections(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const memberIds = new Set(doc.collections.map((c) => c.id));
  const available = (all.data ?? []).filter((c) => !memberIds.has(c.id));
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      emitChange();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="collection-refs" data-testid="doc-collections">
      {doc.collections.length > 0 && (
        <ul className="collection-ref-list">
          {doc.collections.map((c) => (
            <li key={c.id} className={`collection-ref is-${c.state}`} data-testid="doc-collection" data-state={c.state} data-collection-id={c.id}>
              <a href={`#/collections/${c.id}`} className="collection-ref-name">
                {c.name}
              </a>
              <span className={`ref-state ref-${c.state}`}>{c.state === "pin" ? "Added" : c.state === "query" ? "Matches query" : "Excluded"}</span>
              <span className="collection-ref-actions">
                {c.state === "pin" && (
                  <button className="btn btn-ghost btn-sm" disabled={busy === c.id} onClick={() => run(c.id, () => api.removeCollectionDoc(c.id, doc.id))} aria-label={`Remove from ${c.name}`}>
                    Remove
                  </button>
                )}
                {c.state === "query" && (
                  <>
                    <button className="btn btn-ghost btn-sm" disabled={busy === c.id} onClick={() => run(c.id, () => api.setCollectionDoc(c.id, doc.id, "pin"))} data-testid="ref-pin" title="Keep it in this collection even if it stops matching">
                      <IconPushpin size={13} /> Keep
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={busy === c.id} onClick={() => run(c.id, () => api.setCollectionDoc(c.id, doc.id, "exclude"))} data-testid="ref-exclude" title="Hide it from this collection">
                      Exclude
                    </button>
                  </>
                )}
                {c.state === "exclude" && (
                  <button className="btn btn-ghost btn-sm" disabled={busy === c.id} onClick={() => run(c.id, () => api.removeCollectionDoc(c.id, doc.id))} data-testid="ref-include" title="Let the saved search include it again">
                    Include again
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 ? (
        <label className="select-inline">
          <IconPlus size={12} />
          <select
            value=""
            data-testid="add-to-collection"
            aria-label="Add to collection"
            onChange={(e) => {
              const id = e.target.value;
              if (id) void run(id, () => api.setCollectionDoc(id, doc.id, "pin"));
            }}
          >
            <option value="">Add to collection…</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        doc.collections.length === 0 &&
        all.data && (
          <a className="muted small" href="#/collections">
            No collections yet — create one
          </a>
        )
      )}
    </div>
  );
}

function RelatedDocs({ id }: { id: string }) {
  const related = useAsync(() => api.related(id), [id]);
  const drawer = useDrawer();
  if (related.loading && !related.data) return <Spinner />;
  if (related.error) return <p className="muted small">Couldn’t load related docs.</p>;
  const items = related.data ?? [];
  if (items.length === 0) return <p className="muted small">Nothing related yet. Related docs appear as more of your docs are enriched.</p>;
  return (
    <div className="related" data-testid="related">
      {items.slice(0, 6).map((r) => (
        <button key={r.doc.id} className="related-item" onClick={() => drawer.openDoc(r.doc.id)}>
          <SourceIcon source={r.doc.source} size={14} />
          <span className="related-title">{docTitle(r.doc)}</span>
          <span className="related-reasons">{r.reasons.join(" · ")}</span>
        </button>
      ))}
    </div>
  );
}

/** Full-page variant at #/doc/:id. */
export function DocPage({ id }: { id: string }) {
  return (
    <div className="page page-narrow">
      <a className="back-link" href="#/search">
        ← Search
      </a>
      <div className="card card-pad">
        <DocDetailView id={id} onForget={() => navigate("/")} />
      </div>
    </div>
  );
}

