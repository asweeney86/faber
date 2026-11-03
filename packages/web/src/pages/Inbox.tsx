import { useState } from "react";
import type { ReviewItem } from "@faber/shared";
import { api, docTitle, emitChange, plural, toError, useAsync } from "../lib";
import { IconCheck, IconCheckCircle, IconFolder, IconX } from "../components/icons";
import { DocIcon, EmptyState, ErrorBanner, PageHeader, Spinner, TypeBadge, useDrawer } from "../components/ui";
import { projectHref } from "./Projects";

/**
 * The review queue (PRD 2.4: "surface uncertain classifications for optional
 * review"). Nothing here is required: every item is a suggestion, and acting on
 * it or dismissing it makes it go away for good.
 */
export function InboxPage() {
  const queue = useAsync(() => api.review(), []);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = queue.data?.items ?? [];

  const act = async (item: ReviewItem, fn: () => Promise<unknown>) => {
    setBusy(item.id);
    setErr(null);
    try {
      await fn();
      emitChange();
      queue.reload();
    } catch (e) {
      setErr(toError(e));
    } finally {
      setBusy(null);
    }
  };
  const dismiss = (item: ReviewItem) => act(item, () => api.dismissReview(item.id));

  return (
    <div className="page page-narrow">
      <PageHeader title="Inbox" subtitle="Suggestions to tidy how Faber organized things. All optional; your choices stick." />
      {err && <ErrorBanner error={err} />}
      {queue.error && <ErrorBanner error={queue.error} onRetry={queue.reload} />}
      {!queue.data && !queue.error && (
        <div className="center-pad">
          <Spinner size={18} />
        </div>
      )}
      {queue.data && items.length === 0 && (
        <EmptyState title="All caught up" icon={<IconCheckCircle size={22} />} testId="inbox-empty">
          New suggestions appear here when Faber spots a project it isn’t sure about, two names that look like the same project, or a document it couldn’t classify confidently.
        </EmptyState>
      )}
      <ul className="review-list" data-testid="review-list">
        {items.map((item) => (
          <li key={item.id} className="card review-item" data-testid={`review-${item.kind}`} aria-busy={busy === item.id}>
            {item.kind === "new_project" && (
              <>
                <div className="review-text">
                  <span className="review-kind">New project</span>
                  <a className="review-title" href={projectHref(item.project.id)}>
                    <IconFolder size={15} /> {item.project.name}
                  </a>
                  <span className="muted small">
                    Seen in {plural(item.project.doc_count, "document")}
                    {item.project.top_people.length ? ` · ${item.project.top_people.join(", ")}` : ""}. Is it a project?
                  </span>
                </div>
                <div className="review-actions">
                  <button className="btn btn-sm btn-primary" disabled={busy === item.id} onClick={() => void act(item, () => api.updateProject(item.project.id, { confirmed: true }))} data-testid="review-keep">
                    <IconCheck size={13} /> Keep
                  </button>
                  <a className="btn btn-sm" href={projectHref(item.project.id)}>
                    Rename or move…
                  </a>
                  <button className="btn btn-sm btn-ghost" disabled={busy === item.id} onClick={() => void act(item, () => api.updateProject(item.project.id, { hidden: true }))} data-testid="review-hide">
                    Not a project
                  </button>
                </div>
              </>
            )}
            {item.kind === "duplicate" && (
              <>
                <div className="review-text">
                  <span className="review-kind">Same project?</span>
                  <span className="review-title">
                    <a href={projectHref(item.a.id)}>{item.a.name}</a> <span className="faint">and</span> <a href={projectHref(item.b.id)}>{item.b.name}</a>
                  </span>
                  <span className="muted small">
                    {plural(item.a.doc_count, "doc")} and {plural(item.b.doc_count, "doc")}. Merging puts everything under the name you keep.
                  </span>
                </div>
                <div className="review-actions">
                  <button className="btn btn-sm btn-primary" disabled={busy === item.id} onClick={() => void act(item, () => api.mergeProject(item.b.id, item.a.id))} data-testid="review-merge">
                    Keep “{item.a.name}”
                  </button>
                  <button className="btn btn-sm" disabled={busy === item.id} onClick={() => void act(item, () => api.mergeProject(item.a.id, item.b.id))} data-testid="review-merge-other">
                    Keep “{item.b.name}”
                  </button>
                  <button className="btn btn-sm btn-ghost" disabled={busy === item.id} onClick={() => void dismiss(item)} data-testid="review-separate">
                    Keep separate
                  </button>
                </div>
              </>
            )}
            {item.kind === "low_confidence" && <LowConfidence item={item} busy={busy === item.id} onDismiss={() => void dismiss(item)} />}
            <button className="icon-btn review-dismiss" aria-label="Dismiss suggestion" title="Dismiss" onClick={() => void dismiss(item)} data-testid="review-dismiss">
              <IconX size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LowConfidence({ item, busy, onDismiss }: { item: Extract<ReviewItem, { kind: "low_confidence" }>; busy: boolean; onDismiss: () => void }) {
  const drawer = useDrawer();
  const d = item.doc;
  return (
    <>
      <div className="review-text">
        <span className="review-kind">Unsure classification</span>
        <button className="review-title linklike" onClick={() => drawer.openDoc(d.id)}>
          <DocIcon doc={d} size={15} /> {docTitle(d)}
        </button>
        <span className="muted small review-meta">
          {d.enrichment && <TypeBadge type={d.enrichment.doc_type} />}
          {d.enrichment?.projects.length ? `Projects: ${d.enrichment.projects.join(", ")}` : "No project"} · confidence {Math.round(item.confidence * 100)}%
        </span>
      </div>
      <div className="review-actions">
        <button className="btn btn-sm" onClick={() => drawer.openDoc(d.id)} data-testid="review-open">
          Check it
        </button>
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onDismiss}>
          Looks right
        </button>
      </div>
    </>
  );
}
