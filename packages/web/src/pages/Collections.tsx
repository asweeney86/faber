import { useRef, useState } from "react";
import type { Collection, CollectionDetail, CollectionExport, CollectionInput, CollectionQuery, DocType } from "@faber/shared";
import { isCollectionFormat } from "@faber/shared";
import { api, DOC_TYPE_LABELS, emitChange, navigate, plural, relativeTime, slugify, useAsync } from "../lib";
import { IconDownload, IconEye, IconEyeOff, IconLayers, IconPlus, IconPushpin, IconTrash, IconUpload, IconX } from "../components/icons";
import { DocRow, EmptyState, ErrorBanner, LoadError, Modal, PageHeader, Spinner } from "../components/ui";

export function CollectionsPage() {
  const list = useAsync(() => api.collections(), []);
  const [creating, setCreating] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<Error | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onImport = async (file: File) => {
    setImportErr(null);
    setImportMsg(null);
    try {
      let parsed: CollectionExport;
      try {
        parsed = JSON.parse(await file.text()) as CollectionExport;
      } catch {
        throw new Error("That file isn’t a Faber collection export (it isn’t valid JSON).");
      }
      if (!isCollectionFormat(parsed.format)) throw new Error("That file isn’t a Faber collection export.");
      const r = await api.importCollection(parsed);
      setImportMsg(`Imported “${parsed.name}”: ${plural(r.items, "item")}, ${plural(r.created_docs, "new doc")}.`);
      emitChange();
    } catch (e) {
      setImportErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Collections"
        subtitle="Group docs by project or topic. A doc can live in as many collections as it belongs to."
        actions={
          <>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden data-testid="import-file" onChange={(e) => e.target.files?.[0] && void onImport(e.target.files[0])} />
            <button className="btn" onClick={() => fileRef.current?.click()} data-testid="import-collection">
              <IconUpload /> Import
            </button>
            <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-collection">
              <IconPlus /> New collection
            </button>
          </>
        }
      />
      {importMsg && (
        <div className="banner banner-success" data-testid="import-result">
          {importMsg}
        </div>
      )}
      {importErr && <ErrorBanner error={importErr} />}
      {list.error && <ErrorBanner error={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Spinner />}
      {list.data && list.data.length === 0 && (
        <EmptyState title="No collections yet" icon={<IconLayers size={22} />} testId="collections-empty">
          Make one per project. Pin docs into it by hand, or give it a saved search so matching docs join automatically.
        </EmptyState>
      )}
      {list.data && list.data.length > 0 && (
        <div className="collection-grid" data-testid="collection-list">
          {list.data.map((c) => (
            <CollectionCard key={c.id} c={c} />
          ))}
        </div>
      )}
      {creating && (
        <CollectionForm
          title="New collection"
          onClose={() => setCreating(false)}
          onSave={async (input) => {
            const c = await api.createCollection(input);
            emitChange();
            navigate(`/collections/${c.id}`);
          }}
        />
      )}
    </div>
  );
}

function CollectionCard({ c }: { c: Collection }) {
  return (
    <a className="card collection-card" href={`#/collections/${c.id}`} data-testid="collection-card">
      <div className="collection-card-head">
        <IconLayers size={16} />
        <h2>{c.name}</h2>
        {c.query && (
          <span className="badge badge-soft" title={`Docs matching ${describeQuery(c.query)} join automatically`}>
            Smart
          </span>
        )}
      </div>
      {c.description && <p className="muted collection-card-desc">{c.description}</p>}
      <div className="collection-card-meta">
        {c.pin_count > 0 ? `${c.pin_count} added` : c.query ? "Auto-filled" : "Empty"} · Updated {relativeTime(c.updated_at)}
      </div>
    </a>
  );
}

export const EXPORT_NOTE = "Shares links, titles, your notes and your own tags — never document text or AI summaries.";

export function describeQuery(q: CollectionQuery | null | undefined): string {
  if (!q) return "";
  const parts: string[] = [];
  if (q.q) parts.push(`“${q.q}”`);
  const f = q.filters ?? {};
  if (f.doc_type?.length) parts.push(f.doc_type.map((t) => DOC_TYPE_LABELS[t]).join(" or "));
  if (f.tag?.length) parts.push(f.tag.map((t) => `#${t}`).join(" "));
  if (f.project?.length) parts.push(`project ${f.project.join(", ")}`);
  if (f.person?.length) parts.push(`with ${f.person.join(", ")}`);
  return parts.join(" · ") || "all docs";
}

export function CollectionPage({ id }: { id: string }) {
  const c = useAsync(() => api.collection(id), [id]);
  const [editing, setEditing] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);

  if (c.error && !c.data)
    return (
      <div className="page">
        <a className="back-link" href="#/collections">
          ← Collections
        </a>
        <LoadError error={c.error} onRetry={c.reload} what="Collection" backHref="#/collections" backLabel="All collections" />
      </div>
    );
  if (!c.data)
    return (
      <div className="page">
        <Spinner />
      </div>
    );
  const col = c.data;
  // Pins that arrived with someone else's note came from an imported collection.
  const shared = col.items.filter((i) => i.state === "pin" && i.shared_note);
  const pins = col.items.filter((i) => i.state === "pin" && !i.shared_note);
  const matched = col.items.filter((i) => i.state === "query");

  const doExport = async () => {
    const data = await api.exportCollection(col.id);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(col.name)}.faber.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const doDelete = async () => {
    if (!confirm(`Delete the collection “${col.name}”? The docs themselves stay.`)) return;
    await api.deleteCollection(col.id);
    emitChange();
    navigate("/collections");
  };

  return (
    <div className="page">
      <a className="back-link" href="#/collections">
        ← Collections
      </a>
      <PageHeader
        title={<span data-testid="collection-title">{col.name}</span>}
        subtitle={col.description}
        actions={
          <>
            <button className="btn" onClick={() => setEditing(true)} data-testid="edit-collection">
              Edit
            </button>
            <button className="btn" onClick={() => void doExport()} data-testid="export-collection" title={EXPORT_NOTE}>
              <IconDownload /> Export
            </button>
            <button className="btn btn-ghost btn-danger" onClick={() => void doDelete()} data-testid="delete-collection" aria-label="Delete collection">
              <IconTrash />
            </button>
          </>
        }
      />
      {col.query && (
        <p className="smart-query" data-testid="smart-query">
          <span className="badge badge-soft">Smart</span> Docs matching <strong>{describeQuery(col.query)}</strong> join automatically.
        </p>
      )}

      <p className="export-note muted small" data-testid="export-note">
        Export {EXPORT_NOTE.charAt(0).toLowerCase() + EXPORT_NOTE.slice(1)}
      </p>

      {col.items.length === 0 && (
        <EmptyState title="This collection is empty" testId="collection-empty">
          Open any doc and use <em>Add to collection</em>, or edit this collection to give it a saved search.
        </EmptyState>
      )}

      {shared.length > 0 && (
        <section className="card list-section" data-testid="collection-shared">
          <header className="section-header">
            <h2>Shared</h2>
            <span className="section-hint">From an imported collection · {shared.length}</span>
          </header>
          <ItemList detail={col} items={shared} />
        </section>
      )}
      {pins.length > 0 && (
        <section className="card list-section" data-testid="collection-pins">
          <header className="section-header">
            <h2>Added by you</h2>
            <span className="section-hint">{pins.length}</span>
          </header>
          <ItemList detail={col} items={pins} />
        </section>
      )}
      {matched.length > 0 && (
        <section className="card list-section" data-testid="collection-matched">
          <header className="section-header">
            <h2>Matched by search</h2>
            <span className="section-hint">{matched.length}</span>
          </header>
          <ItemList detail={col} items={matched} />
        </section>
      )}
      {col.excluded.length > 0 && (
        <section className="list-section">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowExcluded(!showExcluded)} data-testid="toggle-excluded">
            {showExcluded ? "Hide" : "Show"} {plural(col.excluded.length, "excluded doc")}
          </button>
          {showExcluded && (
            <div className="doc-list excluded-list">
              {col.excluded.map((d) => (
                <DocRow
                  key={d.id}
                  doc={d}
                  actions={
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        await api.removeCollectionDoc(col.id, d.id);
                        emitChange();
                      }}
                    >
                      <IconEye /> <span className="btn-label">Restore</span>
                    </button>
                  }
                />
              ))}
            </div>
          )}
        </section>
      )}

      {editing && (
        <CollectionForm
          title="Edit collection"
          initial={col}
          onClose={() => setEditing(false)}
          onSave={async (input) => {
            await api.updateCollection(col.id, input);
            emitChange();
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function ItemList({ detail, items }: { detail: CollectionDetail; items: CollectionDetail["items"] }) {
  return (
    <div className="doc-list">
      {items.map((it) => (
        <div key={it.doc.id} className="collection-item" data-testid="collection-item" data-state={it.state}>
          <DocRow
            doc={it.doc}
            actions={
              it.state === "pin" ? (
                <button
                  className="btn btn-ghost btn-sm"
                  title="Remove from collection"
                  data-testid="unpin-item"
                  onClick={async () => {
                    await api.removeCollectionDoc(detail.id, it.doc.id);
                    emitChange();
                  }}
                >
                  <IconX /> <span className="btn-label">Remove</span>
                </button>
              ) : (
                <>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Keep this doc in the collection even if it stops matching"
                    aria-label="Keep in collection"
                    data-testid="keep-item"
                    onClick={async () => {
                      await api.setCollectionDoc(detail.id, it.doc.id, "pin");
                      emitChange();
                    }}
                  >
                    <IconPushpin size={13} /> <span className="btn-label">Keep</span>
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Hide from this collection"
                    data-testid="exclude-item"
                    onClick={async () => {
                      await api.setCollectionDoc(detail.id, it.doc.id, "exclude");
                      emitChange();
                    }}
                  >
                    <IconEyeOff /> <span className="btn-label">Exclude</span>
                  </button>
                </>
              )
            }
          />
          {it.shared_note && <blockquote className="shared-note">{it.shared_note}</blockquote>}
        </div>
      ))}
    </div>
  );
}

const QUERY_TYPES: DocType[] = ["prd", "design_doc", "meeting_notes", "postmortem", "okrs", "roadmap", "deck", "spreadsheet", "runbook", "research", "status_update"];

function CollectionForm({ title, initial, onClose, onSave }: { title: string; initial?: Collection; onClose: () => void; onSave: (c: CollectionInput) => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [smart, setSmart] = useState(!!initial?.query);
  const [q, setQ] = useState(initial?.query?.q ?? "");
  const [types, setTypes] = useState<DocType[]>(initial?.query?.filters?.doc_type ?? []);
  const [tags, setTags] = useState((initial?.query?.filters?.tag ?? []).join(", "));
  const [projects, setProjects] = useState((initial?.query?.filters?.project ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const buildQuery = (): CollectionQuery | null => {
    if (!smart) return null;
    const filters: CollectionQuery["filters"] = {};
    if (types.length) filters.doc_type = types;
    if (split(tags).length) filters.tag = split(tags).map((t) => t.replace(/^#/, "").toLowerCase());
    if (split(projects).length) filters.project = split(projects);
    const query: CollectionQuery = {};
    if (q.trim()) query.q = q.trim();
    if (Object.keys(filters).length) query.filters = filters;
    return Object.keys(query).length ? query : null;
  };

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      await onSave({ name: name.trim(), description: description.trim() || null, query: buildQuery() });
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      testId="collection-form"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || saving} onClick={() => void submit()} data-testid="save-collection">
            {saving ? <Spinner size={12} /> : null} Save
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {err && <ErrorBanner error={err} />}
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Q4 launch" data-testid="collection-name" />
        </label>
        <label className="field">
          <span>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" data-testid="collection-description" />
        </label>
        <label className="check">
          <input type="checkbox" checked={smart} onChange={(e) => setSmart(e.target.checked)} data-testid="collection-smart" />
          <span>
            <strong>Smart collection</strong>
            <span className="muted"> — docs matching a saved search join automatically</span>
          </span>
        </label>
        {smart && (
          <div className="smart-fields">
            <label className="field">
              <span>Search words</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="atlas billing" data-testid="collection-q" />
            </label>
            <div className="field">
              <span>Doc types</span>
              <div className="chip-row">
                {QUERY_TYPES.map((t) => (
                  <button type="button" key={t} className={`fchip${types.includes(t) ? " is-on" : ""}`} aria-pressed={types.includes(t)} onClick={() => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t])}>
                    {DOC_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Tags</span>
                <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="pricing, rate-limiting" />
              </label>
              <label className="field">
                <span>Projects</span>
                <input value={projects} onChange={(e) => setProjects(e.target.value)} placeholder="Atlas" />
              </label>
            </div>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
