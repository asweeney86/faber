import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Doc, DocType, ExtensionAccess, StatusResponse } from "@faber/shared";
import { ApiRequestError } from "@faber/shared";
import { DOC_TYPE_LABELS, docTitle, formatWritten, OfflineError, relativeTime, snippetParts } from "../lib";
import { DocIcon, IconAlert, IconPin } from "./icons";

export { DocIcon };

// ---------- Drawer context ----------

export interface DrawerApi {
  openDoc: (id: string) => void;
  close: () => void;
  docId: string | null;
}

export const DrawerContext = createContext<DrawerApi>({ openDoc: () => {}, close: () => {}, docId: null });
export const useDrawer = () => useContext(DrawerContext);

/** Daemon status and pending extension requests, polled by the app shell every 5s. */
export interface LiveStatus {
  status: StatusResponse | null;
  offline: boolean;
  pendingExtensions: ExtensionAccess[];
}
export const LiveContext = createContext<LiveStatus>({ status: null, offline: false, pendingExtensions: [] });
export const useLive = () => useContext(LiveContext);
export const usePendingExtensions = () => useContext(LiveContext).pendingExtensions;
/** True once we know the library is empty (first run). Unknown while loading. */
export const useIsEmptyLibrary = () => useContext(LiveContext).status?.docs === 0;

// ---------- Primitives ----------

export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label={label ?? "Loading"} />;
}

export function TypeBadge({ type }: { type: DocType }) {
  return <span className={`badge type-${type}`}>{DOC_TYPE_LABELS[type] ?? type}</span>;
}

export function EmptyState({ title, children, icon, testId }: { title: string; children?: ReactNode; icon?: ReactNode; testId?: string }) {
  return (
    <div className="empty" data-testid={testId}>
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/** Render `code spans` in a message as <code>. */
export function withCode(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part));
}

export function ErrorBanner({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const offline = error instanceof OfflineError;
  return (
    <div className={`banner ${offline ? "banner-offline" : "banner-error"}`} role="alert" data-testid={offline ? "offline-banner" : "error-banner"}>
      <IconAlert size={15} />
      <span>{withCode(error.message)}</span>
      {onRetry && (
        <button className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** A 404 gets a plain "not found" with a way back (retrying won't help); anything else gets the retryable banner. */
export function LoadError({ error, onRetry, what, backHref, backLabel }: { error: Error; onRetry?: () => void; what: string; backHref: string; backLabel: string }) {
  if (error instanceof ApiRequestError && error.status === 404)
    return (
      <EmptyState title={`${what} not found`} testId="not-found">
        It may have been deleted or forgotten. <a href={backHref}>{backLabel}</a>
      </EmptyState>
    );
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

/** Daemon-reported setup problems (Ollama down, model missing…), shown at the top of every page. */
export function IssuesBar({ issues }: { issues: string[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="issues-bar" role="status" data-testid="status-issues">
      <IconAlert size={15} />
      <ul>
        {issues.map((i) => (
          <li key={i}>{withCode(i)}</li>
        ))}
      </ul>
      <a className="btn btn-sm" href="#/settings/ai">
        Settings
      </a>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Snippet({ text }: { text: string }) {
  // FTS snippets already carry "…" where they were cut; collapse runs and don't add more.
  const clean = text.replace(/…+/g, "…").replace(/\.{3,}/g, "…");
  return (
    <div className="snippet">
      <p className="snippet-text">{snippetParts(clean).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</p>
    </div>
  );
}

/** Re-render every 30s so relative times stay honest on a long-open page. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function DocMeta({ doc, now, inline }: { doc: Doc; now?: number; inline?: boolean }) {
  const written = formatWritten(doc.enrichment?.written_at);
  if (inline) {
    // One line, for dense lists: type · written · last opened · opens.
    return (
      <div className="doc-meta doc-meta-inline">
        {doc.enrichment ? <TypeBadge type={doc.enrichment.doc_type} /> : <ContentState doc={doc} compact />}
        {written && (
          <span className="doc-meta-written" title="Estimated date written">
            {written}
          </span>
        )}
        <span title={`Last opened ${new Date(doc.last_seen_at).toLocaleString()}`}>{relativeTime(doc.last_seen_at, now)}</span>
        <span className="doc-meta-count" title={`Opened ${doc.visit_count} ${doc.visit_count === 1 ? "time" : "times"}`}>
          {doc.visit_count}×
        </span>
      </div>
    );
  }
  return (
    <div className="doc-meta">
      {doc.enrichment ? <TypeBadge type={doc.enrichment.doc_type} /> : <ContentState doc={doc} compact />}
      {written && <span title="Estimated date written">Written {written}</span>}
      <span title={new Date(doc.last_seen_at).toLocaleString()}>Opened {relativeTime(doc.last_seen_at, now)}</span>
      <span>{doc.visit_count}×</span>
    </div>
  );
}

/** What state a doc's text/enrichment is in, for docs without an enrichment yet. */
export function ContentState({ doc, compact }: { doc: Doc; compact?: boolean }) {
  let label: string;
  let cls = "state";
  let hint: string;
  if (doc.content_error) {
    label = "Fetch failed";
    cls += " state-error";
    hint = doc.content_error;
  } else if (!doc.has_content) {
    label = "Waiting for text";
    hint = "The browser extension fetches the text next time it runs with this source enabled.";
  } else if (doc.queue_status === "running") {
    label = "Enriching…";
    cls += " state-busy";
    hint = "The model is reading this document now.";
  } else if (doc.queue_status === "error") {
    label = "Enrichment failed";
    cls += " state-error";
    hint = "Use Re-enrich to try again.";
  } else {
    label = "Queued";
    hint = "Waiting in the enrichment queue.";
  }
  if (compact)
    return (
      <span className={cls} title={hint}>
        {label}
      </span>
    );
  return (
    <div className={`content-state ${cls}`} data-testid="content-state">
      <strong>{label}</strong>
      <span>{hint}</span>
    </div>
  );
}

/** Compact one-line row for digest lists and sidebars. */
export function DocRow({ doc, extra, actions, testId }: { doc: Doc; extra?: ReactNode; actions?: ReactNode; testId?: string }) {
  const drawer = useDrawer();
  return (
    <div className={`doc-row${drawer.docId === doc.id ? " is-active" : ""}`} data-testid={testId ?? "doc-row"} data-doc-id={doc.id}>
      <button className="doc-row-main" onClick={() => drawer.openDoc(doc.id)} title={doc.enrichment?.summary ?? docTitle(doc)}>
        <DocIcon doc={doc} size={16} />
        <span className="doc-row-title">{docTitle(doc)}</span>
        {doc.pinned && <IconPin size={12} filled className="pin-mark" />}
        {doc.enrichment && <TypeBadge type={doc.enrichment.doc_type} />}
        <span className="doc-row-time">{extra ?? relativeTime(doc.last_seen_at)}</span>
      </button>
      {actions && <div className="doc-row-actions">{actions}</div>}
    </div>
  );
}

export function DocList({ docs, empty, extra, actions }: { docs: Doc[]; empty?: ReactNode; extra?: (d: Doc) => ReactNode; actions?: (d: Doc) => ReactNode }) {
  if (docs.length === 0) return <>{empty ?? null}</>;
  return (
    <div className="doc-list">
      {docs.map((d) => (
        <DocRow key={d.id} doc={d} extra={extra?.(d)} actions={actions?.(d) ?? undefined} />
      ))}
    </div>
  );
}

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer, testId, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; testId?: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus moves into the dialog (unless something inside asked for it) and comes back when it closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!ref.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab" && ref.current) {
        // Keep Tab inside the dialog.
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items.at(-1)!;
        if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="modal-header">
          <h2>{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
