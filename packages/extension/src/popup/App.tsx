import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { daemonClient } from "../lib/client";
import { PbClient, type Collection, type Doc, type DocProjectRef, type ProjectSummary, type SearchHit } from "@faber/shared";
import { DocIcon, FaberIcon, IconClientContext, MOD_KEY, isModKey, useDebounced, IconCheckCircle, IconChevron, IconChevronLeft, IconClock, IconLayers, IconOpenApp } from "@faber/ui";
import { docTypeLabel, fitTags, isOpenableUrl, relativeTime, snippetParts } from "../lib/format";
import { appearance } from "../lib/appearance";
import { sendToBackground, type SaveTabResult } from "../lib/messages";
import { isPairingRequired } from "../lib/queue";
import { getItem, type ExtConfig } from "../lib/storage";
import { Icon, TagList, TypeBadge } from "../ui/components";
import { clampIndex, sendKeepalive } from "./util";

const MOD = MOD_KEY;

type Conn = "checking" | "online" | "offline" | "pairing";

interface ActiveTab {
  id: number;
  url: string;
  title: string;
}

function openUrl(url: string, background = false) {
  if (!isOpenableUrl(url)) return;
  void chrome.tabs.create({ url, active: !background });
  if (!background) window.close();
}

type View = "home" | "recent" | "collections";

export function App() {
  const [cfg, setCfg] = useState<ExtConfig | null>(null);
  const [conn, setConn] = useState<Conn>("checking");
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [pageDoc, setPageDoc] = useState<Doc | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<View>("home");
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const dq = useDebounced(q, 140);

  const api = useMemo(() => (cfg ? daemonClient(cfg.daemonUrl) : null), [cfg]);

  // Boot: config and active tab.
  useEffect(() => {
    void getItem("config").then(setCfg);
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      if (t?.id !== undefined && t.url && !t.incognito) setTab({ id: t.id, url: t.url, title: t.title ?? "" });
      // Opening the popup grants activeTab, so the worker can now see this tab's address.
      if (t?.id !== undefined) void sendToBackground({ type: "refresh-tab", tabId: t.id, url: t.url }).catch(() => {});
    });
  }, []);

  const checkConn = useCallback(async () => {
    if (!api) return;
    setConn("checking");
    try {
      // /api/status answers unpaired extensions too; settings() is a real authorised call.
      const s = await api.settings();
      appearance.set(s.appearance);
      setConn("online");
    } catch (e) {
      setConn(isPairingRequired(e) ? "pairing" : "offline");
    }
  }, [api]);

  useEffect(() => {
    void checkConn();
  }, [checkConn]);

  // The search box is disabled while offline; give it focus back once connected.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (conn === "online") searchRef.current?.focus();
  }, [conn]);

  // Look up the current page once we are online.
  useEffect(() => {
    if (!api || conn !== "online" || !tab || !/^https?:/.test(tab.url)) return;
    void api.lookup(tab.url).then(setPageDoc, (e: unknown) => {
      setPageDoc(null);
      if (isPairingRequired(e)) setConn("pairing");
    });
  }, [api, conn, tab]);

  // Search as you type; the Recent view lists recent docs (an empty query).
  // Typing: wait for the debounced query (never search "" for a typed query). Recent: list recent docs.
  const searchQuery = q.trim() ? (dq.trim() ? dq : null) : view === "recent" ? "" : null;
  useEffect(() => {
    if (!api || conn !== "online" || searchQuery === null) {
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    api
      .search({ q: searchQuery, limit: searchQuery.trim() ? 20 : 10 })
      .then(
        (r) => {
          if (cancelled) return;
          setHits(r.hits);
          setSearchError(null);
          setSel(0);
        },
        (e: unknown) => {
          if (cancelled) return;
          if (isPairingRequired(e)) setConn("pairing");
          else setSearchError(e instanceof Error ? e.message : String(e));
        },
      )
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [api, conn, searchQuery]);

  useEffect(() => {
    if (!api || conn !== "online" || view !== "collections" || collections) return;
    void api.collections().then(setCollections, () => setCollections([]));
  }, [api, conn, view, collections]);

  const daemonUrl = cfg?.daemonUrl ?? "";
  const searchingNow = !!q.trim();
  const listed = searchingNow || view === "recent" ? hits : [];
  const selIx = clampIndex(sel, listed.length);
  const activeId = listed[selIx] ? `result-${listed[selIx]!.doc.id}` : undefined;
  // Faber's own app tab isn't a page to save.
  const pageIsWeb = !!tab && /^https?:/.test(tab.url) && !(daemonUrl && tab.url.startsWith(daemonUrl.replace(/\/$/, "") + "/"));

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const openApp = (route = "") => daemonUrl && openUrl(`${daemonUrl}/${route ? `#${route}` : ""}`);
  // Close only after the worker has the request (closing first would drop it).
  const openLauncher = () =>
    void sendToBackground({ type: "open-launcher", query: q.trim() || undefined })
      .catch(() => {})
      .finally(() => window.close());

  const onKey = (e: React.KeyboardEvent) => {
    const mod = isModKey(e);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(clampIndex(selIx + 1, listed.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(clampIndex(selIx - 1, listed.length));
    } else if (e.key === "Enter") {
      const h = listed[selIx];
      if (h) {
        e.preventDefault();
        openUrl(h.doc.canonical_url, mod);
      }
    } else if (e.key === "Escape" && (q || view !== "home")) {
      e.preventDefault();
      setQ("");
      setView("home");
    } else if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      openApp(q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : "");
    }
  };

  return (
    <IconClientContext.Provider value={api}>
    <div className="popup" onKeyDown={onKey}>
      <header className="popup-head">
        <FaberIcon size={26} />
        <span className="popup-brand">Faber</span>
        <ConnStatus conn={conn} searching={searching} />
        <button className="icon-btn" aria-label="Options" title="Options" onClick={() => chrome.runtime.openOptionsPage()}>
          <Icon name="settings" />
        </button>
      </header>

      <div className="search-bar">
        <span className="search-icon">
          <Icon name="search" />
        </span>
        <input
          ref={searchRef}
          autoFocus
          className="search-input"
          placeholder="Search your docs…"
          aria-label="Search your docs"
          role="combobox"
          aria-expanded={listed.length > 0}
          aria-controls="results"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={conn === "offline" || conn === "pairing"}
        />
        <button className="kbd-chip" onClick={openLauncher} title="Open the launcher on this page" data-testid="open-launcher">
          {MOD}⇧K
        </button>
      </div>

      <main className="popup-body">
        {conn === "offline" && <Offline daemonUrl={daemonUrl} onRetry={checkConn} />}
        {conn === "pairing" && <Pairing daemonUrl={daemonUrl} onRetry={checkConn} />}

        {conn === "online" && !searchingNow && view === "home" && (
          <>
            {pageIsWeb && api && tab && <PageCard api={api} daemonUrl={daemonUrl} tab={tab} doc={pageDoc} onDoc={setPageDoc} />}
            <nav className="menu" aria-label="Faber">
              <button className="menu-row" onClick={() => openApp()} data-testid="open-app">
                <IconOpenApp size={18} />
                <span>Open Faber</span>
                <kbd>{MOD}O</kbd>
              </button>
              <button className="menu-row" onClick={() => setView("recent")} data-testid="menu-recent">
                <IconClock size={18} />
                <span>Recent</span>
                <IconChevron size={15} />
              </button>
              <button className="menu-row" onClick={() => setView("collections")} data-testid="menu-collections">
                <IconLayers size={18} />
                <span>Collections</span>
                <IconChevron size={15} />
              </button>
            </nav>
          </>
        )}

        {conn === "online" && !searchingNow && view === "collections" && (
          <section>
            <SubHead title="Collections" onBack={() => setView("home")} />
            {!collections && <div className="empty">Loading…</div>}
            {collections?.length === 0 && <div className="empty">No collections yet. Create one in the app.</div>}
            {collections?.map((c) => (
              <button key={c.id} className="menu-row" onClick={() => openApp(`/collections/${c.id}`)}>
                <IconLayers size={17} />
                <span className="menu-text">
                  <span>{c.name}</span>
                  {c.description && <span className="faint small">{c.description}</span>}
                </span>
                <Icon name="external" size={12} />
              </button>
            ))}
          </section>
        )}

        {conn === "online" && (searchingNow || view === "recent") && (
          <section>
            {view === "recent" && !searchingNow ? (
              <SubHead title="Recent" onBack={() => setView("home")} />
            ) : (
              <div className="section-label">{listed.length ? `${listed.length} result${listed.length === 1 ? "" : "s"}` : ""}</div>
            )}
            {searchError && <div className="notice notice-error">{searchError}</div>}
            {!searchError && listed.length === 0 && !searching && (
              <div className="empty">{searchingNow ? <>No docs match “{q.trim()}”.</> : <>Nothing here yet. Turn on Google Docs in Options, or save this page.</>}</div>
            )}
            <div role="listbox" id="results" aria-label="Results">
              {listed.map((h, i) => (
                <ResultRow key={h.doc.id} hit={h} selected={i === selIx} onHover={() => setSel(i)} />
              ))}
            </div>
          </section>
        )}
      </main>

      {conn === "online" && listed.length > 0 && (
        <footer className="popup-footer">
          <span className="footer-hints faint" aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate <kbd>↵</kbd> open <kbd>{MOD}↵</kbd> new tab
          </span>
        </footer>
      )}
    </div>
    </IconClientContext.Provider>
  );
}

function SubHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="subhead">
      <button className="icon-btn" onClick={onBack} aria-label="Back" title="Back (Esc)">
        <IconChevronLeft size={15} />
      </button>
      <span className="section-label">{title}</span>
    </div>
  );
}

function ConnStatus({ conn, searching }: { conn: Conn; searching: boolean }) {
  if (conn === "online") return searching ? <span className="spinner" aria-label="Searching" /> : <span className="dot dot-ok" title="Connected" aria-label="Connected" />;
  if (conn === "checking") return <span className="spinner" aria-label="Connecting" />;
  const label = conn === "pairing" ? "Not approved" : "Offline";
  return (
    <span className={`status ${conn === "pairing" ? "status-warn" : "status-bad"}`} title={conn === "pairing" ? "This extension isn’t approved yet" : "Daemon not reachable"}>
      <span className={`dot ${conn === "pairing" ? "dot-warn" : "dot-bad"}`} />
      {label}
    </span>
  );
}

/** Approximate characters that fit on a result's meta line in the 380px popup. */
const META_CHARS = 44;

function ResultRow({ hit, selected, onHover }: { hit: SearchHit; selected: boolean; onHover: () => void }) {
  const d = hit.doc;
  const e = d.enrichment;
  const when = `${relativeTime(d.last_seen_at)} · ${d.visit_count}×`;
  const subtitle = hit.snippet ?? e?.summary ?? (d.has_content ? "Waiting to be summarised…" : "Text not fetched yet");
  return (
    <a
      role="option"
      id={`result-${d.id}`}
      aria-selected={selected}
      className={`result ${selected ? "is-selected" : ""}`}
      href={isOpenableUrl(d.canonical_url) ? d.canonical_url : undefined}
      tabIndex={-1}
      onMouseEnter={onHover}
      onClick={(ev) => {
        ev.preventDefault();
        openUrl(d.canonical_url, ev.metaKey || ev.ctrlKey);
      }}
    >
      <span className="result-icon">
        <DocIcon doc={d} size={16} />
      </span>
      <div className="result-main">
        <div className="result-title-row">
          <span className="result-title">{d.title || "Untitled"}</span>
          {d.pinned && (
            <span className="pin-mark" title="Pinned" aria-label="Pinned">
              <Icon name="bookmark" size={12} filled />
            </span>
          )}
        </div>
        <div className="result-sub">
          {hit.snippet
            ? snippetParts(hit.snippet).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))
            : subtitle}
        </div>
        <div className="result-meta">
          {e && <TypeBadge type={e.doc_type} />}
          <span className="result-when">{when}</span>
          <span className="result-tags">
            <TagList tags={d.tags} max={fitTags(d.tags.map((t) => t.tag), META_CHARS - (e ? docTypeLabel(e.doc_type).length + 3 : 0) - when.length)} />
          </span>
        </div>
      </div>
    </a>
  );
}

function Offline({ daemonUrl, onRetry }: { daemonUrl: string; onRetry: () => void }) {
  return (
    <div className="offline">
      <div className="offline-icon">
        <Icon name="power" size={20} />
      </div>
      <div className="offline-title">Faber isn’t running</div>
      <p className="muted">
        Couldn’t reach the daemon at <code>{daemonUrl}</code>. Start it from the project folder:
      </p>
      <pre className="cmd">bun faber serve</pre>
      <p className="faint small">Visits you make meanwhile are queued and sent when it’s back.</p>
      <div className="row-gap">
        <button className="btn btn-primary btn-sm" onClick={onRetry}>
          <Icon name="refresh" size={13} /> Retry
        </button>
        <button className="btn btn-sm" onClick={() => chrome.runtime.openOptionsPage()}>
          Change address
        </button>
      </div>
    </div>
  );
}

function Pairing({ daemonUrl, onRetry }: { daemonUrl: string; onRetry: () => void }) {
  return (
    <div className="offline" role="alert">
      <div className="offline-icon pairing-icon">
        <Icon name="bookmark" size={20} />
      </div>
      <div className="offline-title">Approve Faber in the app</div>
      <p className="muted">
        The daemon is running but hasn’t approved this extension yet. Open the app’s <strong>Settings → Capture & Sources</strong> and approve it, then retry.
      </p>
      <p className="faint small">Visits you make meanwhile are queued and sent once it’s approved.</p>
      <div className="row-gap">
        <button className="btn btn-primary btn-sm" onClick={() => openUrl(`${daemonUrl}/#/settings/capture`)}>
          Open settings <Icon name="external" size={12} />
        </button>
        <button className="btn btn-sm" onClick={onRetry}>
          <Icon name="refresh" size={13} /> Retry
        </button>
      </div>
    </div>
  );
}

type Msg = { kind: "ok" | "error" | "info"; text: string } | null;

function PageCard({
  api,
  daemonUrl,
  tab,
  doc,
  onDoc,
}: {
  api: PbClient;
  daemonUrl: string;
  tab: ActiveTab;
  doc: Doc | null;
  onDoc: (d: Doc | null) => void;
}) {
  const [note, setNote] = useState(doc?.note ?? "");
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  // Confirmations fade after a few seconds; errors stay until the next action.
  useEffect(() => {
    if (!msg || msg.kind === "error") return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Editing controls and AI details stay out of the way until asked for (PRD 2.8).
  const [editing, setEditing] = useState(false);

  // Latest values for the close-time flush (the popup can vanish at any moment).
  const pending = useRef<{ note: string | null; tag: string }>({ note: null, tag: "" });
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savedNote = useRef<string | null>(doc?.note ?? null);

  useEffect(() => {
    setNote(doc?.note ?? "");
    savedNote.current = doc?.note ?? null;
  }, [doc?.id]); // Only when the doc changes, not on every edit.

  const saveNote = useCallback(
    async (value: string) => {
      if (!doc) return;
      const next = value.trim() || null;
      if (next === savedNote.current) {
        pending.current.note = null;
        return;
      }
      setNoteState("saving");
      try {
        const d = await api.setNote(doc.id, next);
        savedNote.current = next;
        if (pending.current.note === value) pending.current.note = null;
        setNoteState("saved");
        onDoc(d);
      } catch (e) {
        setNoteState("error");
        setMsg({ kind: "error", text: `Note not saved: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [api, doc, onDoc],
  );

  // Flush unsaved edits if the popup closes mid-typing.
  useEffect(() => {
    if (!doc) return;
    const flush = () => {
      const n = pending.current.note;
      if (n !== null && (n.trim() || null) !== savedNote.current) {
        sendKeepalive(daemonUrl, "PUT", `/api/docs/${doc.id}/note`, { note: n.trim() || null });
      }
      const t = pending.current.tag.trim();
      if (t) sendKeepalive(daemonUrl, "POST", `/api/docs/${doc.id}/tags`, { tag: t });
    };
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [daemonUrl, doc]);

  const refreshIcon = () => void sendToBackground({ type: "refresh-tab", tabId: tab.id, url: tab.url }).catch(() => {});

  const act = async (fn: () => Promise<Doc>) => {
    try {
      onDoc(await fn());
      refreshIcon();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const runSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await sendToBackground<SaveTabResult>({ type: "save-tab", tabId: tab.id, url: tab.url });
      if (r.ok) {
        setNeedsPermission(false);
        onDoc(await api.lookup(tab.url));
        setMsg(
          r.content === "failed"
            ? { kind: "info", text: `Saved, but couldn’t read the text: ${r.error ?? "unknown error"}` }
            : { kind: "ok", text: "Saved. It will be summarised in the background." },
        );
      } else {
        setNeedsPermission(!!r.needsPermission);
        setMsg({ kind: r.queued ? "info" : "error", text: r.error });
      }
    } catch (e) {
      setMsg({ kind: "error", text: `Couldn’t save: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const grantAndSave = () => {
    // permissions.request must run synchronously inside the click to count as a user gesture.
    let origins: string[] = [];
    try {
      const u = new URL(tab.url);
      origins = [`${u.protocol}//${u.hostname}/*`];
    } catch {
      return;
    }
    chrome.permissions.request({ origins }).then(
      (granted) => (granted ? runSave() : setMsg({ kind: "error", text: "Permission was not granted" })),
      (e: unknown) => setMsg({ kind: "error", text: String(e) }),
    );
  };

  if (!doc) {
    return (
      <section className="page-card page-card-empty" aria-label="This page">
        <div className="page-head">
          <div className="page-head-text">
            <div className="page-status-title">Not saved yet</div>
            <div className="page-title" title={tab.title}>
              {tab.title || tab.url}
            </div>
          </div>
          {needsPermission ? (
            <button className="btn btn-primary btn-sm" onClick={grantAndSave} disabled={saving}>
              Grant access &amp; save
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={runSave} disabled={saving}>
              {saving ? <span className="spinner" /> : <Icon name="bookmark" size={13} />} Save this page
            </button>
          )}
        </div>
        {msg && <div className={`notice notice-${msg.kind}`}>{msg.text}</div>}
      </section>
    );
  }

  const e = doc.enrichment;
  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    setTagInput("");
    pending.current.tag = "";
    void act(() => api.addTag(doc.id, t));
  };

  return (
    <section className="page-card" aria-label="This page">
      <div className="page-status">
        <span className="saved-check" aria-hidden="true">
          <IconCheckCircle size={22} />
        </span>
        <div className="page-head-text">
          <div className="page-status-title">
            This page is saved
            {doc.pinned && (
              <span className="pin-mark" title="Pinned" aria-label="Pinned">
                <Icon name="bookmark" size={12} filled />
              </span>
            )}
          </div>
          <div className="page-title" title={doc.title}>
            {doc.title || "Untitled"}
          </div>
        </div>
        <button className="btn btn-sm" aria-expanded={editing} onClick={() => setEditing((x) => !x)} data-testid="edit-page">
          {editing ? "Done" : "Edit"}
        </button>
      </div>

      {editing && (
        <div className="page-edit" data-testid="page-edit">
          <div className="page-edit-row">
            <button
              className={`btn btn-sm ${doc.pinned ? "btn-pinned" : ""}`}
              aria-pressed={doc.pinned}
              title={doc.pinned ? "Unpin" : "Pin"}
              onClick={() => act(() => api.setPinned(doc.id, !doc.pinned))}
            >
              <Icon name="bookmark" size={13} filled={doc.pinned} /> {doc.pinned ? "Pinned" : "Pin"}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => openUrl(`${daemonUrl}/#/doc/${doc.id}`)}>
              Open in Faber <Icon name="external" size={11} />
            </button>
          </div>

          <div className="tag-row">
            <TagList tags={doc.tags} onRemove={(t) => act(() => api.removeTag(doc.id, t))} />
            <input
              className="tag-input"
              placeholder="+ tag"
              aria-label="Add tag"
              value={tagInput}
              onChange={(ev) => {
                setTagInput(ev.target.value);
                pending.current.tag = ev.target.value;
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
            />
          </div>

          <div className="note-wrap">
            <textarea
              className="input note"
              rows={2}
              placeholder="Why this matters, where you use it…"
              aria-label="Note"
              value={note}
              onChange={(ev) => {
                const v = ev.target.value;
                setNote(v);
                setNoteState("idle");
                pending.current.note = v;
                clearTimeout(noteTimer.current);
                noteTimer.current = setTimeout(() => void saveNote(v), 400);
              }}
              onBlur={() => {
                clearTimeout(noteTimer.current);
                void saveNote(note);
              }}
            />
            {noteState !== "idle" && (
              <span className={`note-state ${noteState === "error" ? "note-error" : "faint"}`} aria-live="polite">
                {noteState === "saving" ? "Saving…" : noteState === "saved" ? "Saved" : "Not saved"}
              </span>
            )}
          </div>

          <ProjectsEditor api={api} docId={doc.id} onMessage={setMsg} />
          <CollectionPicker api={api} docId={doc.id} onMessage={setMsg} />

          <details className="page-details">
            <summary>Summary and details</summary>
            {e ? (
              <p className="page-summary">{e.summary}</p>
            ) : (
              <p className="page-summary faint">
                {doc.content_error ? `Couldn’t read the text: ${doc.content_error}` : doc.has_content ? "Summarising in the background…" : "Text not fetched yet."}
              </p>
            )}
            <div className="page-meta faint">
              {e && <TypeBadge type={e.doc_type} />}
              <span>
                First opened {relativeTime(doc.first_seen_at)} · {doc.visit_count} visit{doc.visit_count === 1 ? "" : "s"}
              </span>
            </div>
          </details>
        </div>
      )}
      {msg && <div className={`notice notice-${msg.kind}`}>{msg.text}</div>}
    </section>
  );
}

/** "Add to collection…": puts this page in one of your collections (as a kept item). */
function CollectionPicker({ api, docId, onMessage }: { api: PbClient; docId: string; onMessage: (m: Msg) => void }) {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  useEffect(() => {
    void api.collections().then(setCollections, () => setCollections([]));
  }, [api]);
  if (!collections?.length) return null;
  return (
    <select
      className="input collection-picker"
      aria-label="Add to collection"
      value=""
      data-testid="add-to-collection"
      onChange={(e) => {
        const c = collections.find((x) => x.id === e.target.value);
        if (!c) return;
        api.setCollectionDoc(c.id, docId, "pin").then(
          () => onMessage({ kind: "ok", text: `Added to ${c.name}.` }),
          (err: unknown) => onMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) }),
        );
      }}
    >
      <option value="">Add to collection…</option>
      {collections.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** The projects this page is in (inferred or set by hand): take it out of one, or add it to another. */
function ProjectsEditor({ api, docId, onMessage }: { api: PbClient; docId: string; onMessage: (m: Msg) => void }) {
  const [mine, setMine] = useState<DocProjectRef[] | null>(null);
  const [all, setAll] = useState<ProjectSummary[]>([]);
  const [value, setValue] = useState("");
  useEffect(() => {
    void api.docProjects(docId).then(setMine, () => setMine([]));
    void api.projects().then(setAll, () => setAll([]));
  }, [api, docId]);
  const set = (project: string, inProject: boolean) =>
    api.setDocProject(docId, project, inProject).then(
      (refs) => (setMine(refs), true),
      (e: unknown) => (onMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) }), false),
    );
  const memberIds = new Set((mine ?? []).map((p) => p.id));
  return (
    <div className="popup-projects" data-testid="popup-projects">
      <div className="tag-row">
        {(mine ?? []).map((p) => (
          <span key={p.id} className="tag tag-project" title={p.corrected ? "Added by you" : "Detected"}>
            {p.name}
            <button type="button" className="tag-remove" aria-label={`Not part of ${p.name}`} onClick={() => void set(p.id, false)}>
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void set(value.trim(), true).then((ok) => ok && setValue(""));
          }}
        >
          <input className="tag-input" list="popup-project-options" placeholder="+ project" aria-label="Add to project" value={value} onChange={(e) => setValue(e.target.value)} data-testid="popup-project-input" />
          <datalist id="popup-project-options">
            {all
              .filter((p) => !memberIds.has(p.id))
              .map((p) => (
                <option key={p.id} value={p.name} />
              ))}
          </datalist>
        </form>
      </div>
    </div>
  );
}
