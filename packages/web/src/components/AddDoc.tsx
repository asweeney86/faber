import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ApiRequestError, parseGoogleUrl, type AddDocResponse } from "@faber/shared";
import { api, emitChange, toError, useAsync } from "../lib";
import { IconChevronDown, IconUpload, SourceIcon } from "./icons";
import { Spinner, withCode } from "./ui";

// ---------- Context: open the add form from anywhere ----------

export interface AddPrefill {
  url?: string;
  title?: string;
}

export const AddDocContext = createContext<(prefill?: AddPrefill) => void>(() => {});
export const useOpenAddDoc = () => useContext(AddDocContext);

// ---------- Toasts ----------

export interface Toast {
  id: number;
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}

export const ToastContext = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="status" data-testid="toast">
          <div className="toast-body">
            <strong>{t.title}</strong>
            {t.detail && <span className="toast-detail">{t.detail}</span>}
          </div>
          {t.action && (
            <button
              className="btn btn-sm"
              onClick={() => {
                t.action!.onClick();
                onDismiss(t.id);
              }}
              data-testid="toast-action"
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- Form ----------

const MAX_TEXT = 1_000_000;
const NEEDS_CONTENT =
  "No text yet: summary and search will appear once the extension fetches it (turn on Google Docs in Settings) or you paste the text.";

type Field = "url" | "title" | "content" | "note" | "tags" | "collection" | "form";

export function validateUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Paste the link to the document or page.";
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http:// and https:// links can be saved.";
    return null;
  } catch {
    return "That doesn’t look like a link. It should start with https://";
  }
}

/** Route a daemon 400/404 message to the field it is about. */
function fieldFor(err: Error): Field {
  const m = err.message.toLowerCase();
  if (err instanceof ApiRequestError && err.status === 404 && m.includes("collection")) return "collection";
  if (m.includes("url") || m.includes("http")) return "url";
  if (m.includes("tag")) return "tags";
  if (m.includes("note")) return "note";
  if (m.includes("title")) return "title";
  if (m.includes("content") || m.includes("text")) return "content";
  return "form";
}

export function AddDocForm({ prefill, onDone, onCancel, autoFocus = true }: { prefill?: AddPrefill; onDone: (r: AddDocResponse) => void; onCancel?: () => void; autoFocus?: boolean }) {
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [showText, setShowText] = useState(false);
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [pinned, setPinned] = useState(false);
  const [collectionId, setCollectionId] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const collections = useAsync(() => api.collections(), [], { live: false });
  const google = parseGoogleUrl(url.trim());

  useEffect(() => {
    if (prefill?.url !== undefined) setUrl(prefill.url);
    if (prefill?.title !== undefined) setTitle(prefill.title);
  }, [prefill?.url, prefill?.title]);

  const setErr = (f: Field, msg: string | null) => setErrors((e) => ({ ...e, [f]: msg ?? undefined }));

  const readFile = async (file: File) => {
    if (file.size > MAX_TEXT) {
      setErr("content", `That file is ${(file.size / 1_000_000).toFixed(1)} MB; the limit is 1 MB. Paste the most relevant part instead.`);
      return;
    }
    const text = await file.text();
    setContent(text);
    setShowText(true);
    setErr("content", null);
    if (!title.trim()) setTitle(file.name.replace(/\.(txt|md|csv)$/i, ""));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void readFile(file);
  };

  const submit = async () => {
    const urlErr = validateUrl(url);
    const tagList = tags
      .split(",")
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
    const longTag = tagList.find((t) => t.length > 60);
    const contentErr = content.length > MAX_TEXT ? "The text is over 1 MB. Paste the most relevant part instead." : null;
    const next: Partial<Record<Field, string>> = {};
    if (urlErr) next.url = urlErr;
    if (longTag) next.tags = `“${longTag.slice(0, 20)}…” is too long — tags can be at most 60 characters.`;
    if (contentErr) next.content = contentErr;
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      const r = await api.addDoc({
        url: url.trim(),
        title: title.trim() || undefined,
        content: content.trim() ? content : undefined,
        note: note.trim() || undefined,
        tags: tagList.length ? tagList : undefined,
        pinned: pinned || undefined,
        collection_id: collectionId || undefined,
      });
      emitChange();
      onDone(r);
    } catch (e) {
      const err = toError(e);
      setErrors({ [fieldFor(err)]: err.message });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="form add-form"
      data-testid="add-form"
      noValidate
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {errors.form && (
        <div className="banner banner-error" role="alert" data-testid="add-error">
          {withCode(errors.form)}
        </div>
      )}
      <Row label="Link" error={errors.url} id="add-url">
        <div className={`input-with-icon${google ? " has-icon" : ""}`}>
          {google && <SourceIcon source={google.kind} size={16} />}
          <input
            id="add-url"
            autoFocus={autoFocus}
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (errors.url) setErr("url", null);
            }}
            onBlur={() => url.trim() && setErr("url", validateUrl(url))}
            placeholder="https://docs.google.com/document/d/…"
            aria-invalid={!!errors.url}
            aria-describedby={errors.url ? "add-url-error" : undefined}
            data-testid="add-url"
          />
        </div>
      </Row>
      <Row label="Title" optional id="add-title" error={errors.title}>
        <input
          id="add-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={google ? "Optional — the extension fills in Google doc titles" : "Optional — taken from the text if you paste it"}
          data-testid="add-title"
        />
      </Row>

      <div className="field">
        <button type="button" className="disclosure" aria-expanded={showText} onClick={() => setShowText(!showText)} data-testid="add-text-toggle">
          <IconChevronDown size={11} className="disclosure-chevron" />
          Paste the document’s text
          <span className="disclosure-hint">optional, enables summary and full-text search</span>
        </button>
        {showText && (
          <div className="text-zone">
            <p className="muted small hint">
              In Google Docs: <strong>File → Download → Plain text (.txt)</strong>, then paste or drop the file here.
            </p>
            <textarea
              value={content}
              rows={7}
              onChange={(e) => {
                setContent(e.target.value);
                if (errors.content) setErr("content", null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={dragging ? "is-dragging" : ""}
              placeholder="Paste text, or drop a .txt, .md or .csv file"
              aria-label="Document text"
              aria-invalid={!!errors.content}
              data-testid="add-content"
            />
            <div className="text-zone-foot">
              <input ref={fileRef} type="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv" hidden data-testid="add-file" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => fileRef.current?.click()}>
                <IconUpload /> Choose file
              </button>
              <span className="muted small">{content ? `${content.length.toLocaleString()} characters` : "Up to 1 MB"}</span>
            </div>
            {errors.content && (
              <span className="field-error" role="alert" data-testid="add-content-error">
                {errors.content}
              </span>
            )}
          </div>
        )}
      </div>

      <Row label="Note" optional id="add-note" error={errors.note}>
        <input id="add-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Why it matters, in a line" data-testid="add-note" />
      </Row>
      <div className="field-row">
        <Row label="Tags" optional id="add-tags" error={errors.tags}>
          <input id="add-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="pricing, q4-planning" data-testid="add-tags" />
        </Row>
        <Row label="Collection" optional id="add-collection" error={errors.collection}>
          <select id="add-collection" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} data-testid="add-collection">
            <option value="">None</option>
            {(collections.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Row>
      </div>
      <label className="check">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} data-testid="add-pinned" />
        <span>Pin it to Home</span>
      </label>

      <div className="form-actions">
        <span className="muted small kbd-hint">
          <kbd>⌘</kbd>
          <kbd>↵</kbd> to save
        </span>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy} data-testid="add-submit">
          {busy && <Spinner size={12} />} Save bookmark
        </button>
      </div>
    </form>
  );
}

function Row({ label, optional, id, error, children }: { label: string; optional?: boolean; id: string; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {optional && <span className="optional"> optional</span>}
      </label>
      {children}
      {error && (
        <span className="field-error" id={`${id}-error`} role="alert" data-testid={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Toast copy for a finished add, shared by the modal and the #/add page. */
export function addResultToast(r: AddDocResponse, openDoc: (id: string) => void): Omit<Toast, "id"> {
  return {
    title: r.created ? "Added" : "Already saved — updated",
    detail: r.needs_content ? NEEDS_CONTENT : undefined,
    action: { label: "Open", onClick: () => openDoc(r.doc.id) },
  };
}

export { NEEDS_CONTENT };
