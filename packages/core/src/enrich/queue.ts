import type { Database } from "bun:sqlite";
import { now } from "../db";

export const MAX_ATTEMPTS = 3;

/** Higher first. Recent and frequently-opened docs get enriched before the long tail. */
export function priorityFor(visitCount: number, lastSeenAt: number, pinned: boolean): number {
  const ageDays = Math.max(0, (now() - lastSeenAt) / 86_400_000);
  return (pinned ? 1000 : 0) + Math.log1p(visitCount) * 10 - Math.log1p(ageDays);
}

/**
 * (Re)queue a doc. A fresh request always starts over: attempts and backoff are reset.
 * Docs without text are skipped: there is nothing to summarise yet, and storing the text
 * (setContent) queues them when it arrives.
 */
export function enqueueEnrichment(db: Database, docId: string, priority?: number, opts: { force?: boolean } = {}) {
  const row = db
    .query<{ visit_count: number; last_seen_at: number; pinned: number; has_content: number }, [string]>(
      `SELECT visit_count, last_seen_at, pinned, content IS NOT NULL AS has_content FROM documents WHERE id = ?`,
    )
    .get(docId);
  if (!row?.has_content) return;
  const p = priority ?? priorityFor(row.visit_count, row.last_seen_at, row.pinned === 1);
  db.run(
    `INSERT INTO enrich_queue (doc_id, priority, status, attempts, last_error, next_attempt_at, force, updated_at)
     VALUES (?, ?, 'pending', 0, NULL, 0, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET priority = excluded.priority, status = 'pending', attempts = 0,
       last_error = NULL, next_attempt_at = 0, force = MAX(enrich_queue.force, excluded.force), updated_at = excluded.updated_at`,
    [docId, p, opts.force ? 1 : 0, now()],
  );
}

export interface QueueItem {
  doc_id: string;
  priority: number;
  attempts: number;
  /** Re-run the model even if this content was already enriched. */
  force: boolean;
}

/** Claim up to `limit` due jobs that have content, marking them running and remembering which content version they cover. */
export function claimJobs(db: Database, limit: number, at = now()): QueueItem[] {
  return db.transaction(() => {
    const items = db
      .query<Omit<QueueItem, "force"> & { force: number; content_hash: string }, [number, number, number]>(
        `SELECT q.doc_id, q.priority, q.attempts, q.force, d.content_hash FROM enrich_queue q
         JOIN documents d ON d.id = q.doc_id
         WHERE q.status = 'pending' AND d.content IS NOT NULL AND q.attempts < ? AND q.next_attempt_at <= ?
         ORDER BY q.priority DESC LIMIT ?`,
      )
      .all(MAX_ATTEMPTS, at, limit);
    for (const it of items) {
      db.run(`UPDATE enrich_queue SET status = 'running', claimed_hash = ?, updated_at = ? WHERE doc_id = ?`, [
        it.content_hash,
        now(),
        it.doc_id,
      ]);
    }
    return items.map(({ doc_id, priority, attempts, force }) => ({ doc_id, priority, attempts, force: force === 1 }));
  })();
}

/**
 * Mark a job done — unless the doc was re-queued while it ran (new content arrived),
 * in which case it stays pending so the new version gets enriched too.
 */
export function completeJob(db: Database, docId: string) {
  db.run(
    `UPDATE enrich_queue SET status = 'done', force = 0, updated_at = ?
     WHERE doc_id = ? AND status = 'running'
       AND claimed_hash IS (SELECT content_hash FROM documents WHERE id = ?)`,
    [now(), docId, docId],
  );
  db.run(`UPDATE enrich_queue SET status = 'pending' WHERE doc_id = ? AND status = 'running'`, [docId]);
}

/** Record a failure. Retries back off; after MAX_ATTEMPTS the job is parked as an error until re-queued. */
export function failJob(db: Database, docId: string, error: string, opts: { countAttempt?: boolean } = {}) {
  const count = opts.countAttempt === false ? 0 : 1;
  db.run(
    `UPDATE enrich_queue SET
       status = CASE WHEN attempts + ? >= ? THEN 'error' ELSE 'pending' END,
       attempts = attempts + ?,
       last_error = ?,
       next_attempt_at = ? + ? * (attempts + ?) * (attempts + ?) + CASE WHEN ? = 0 THEN 60000 ELSE 0 END,
       updated_at = ?
     WHERE doc_id = ? AND status = 'running'`,
    [count, MAX_ATTEMPTS, count, error.slice(0, 1000), now(), 60_000, count, count, count, now(), docId],
  );
}

/**
 * Jobs left 'running' longer than the lease go back to pending. The daemon calls this with
 * a lease of 0 at startup (anything running then was orphaned by a crash) and with the
 * default on every tick, so a wedged job never sits forever.
 */
export function recoverStaleJobs(db: Database, leaseMs = 15 * 60_000) {
  db.run(`UPDATE enrich_queue SET status = 'pending' WHERE status = 'running' AND updated_at < ?`, [now() - leaseMs]);
}

/** When the soonest pending job becomes due, or null if none. */
export function nextDueAt(db: Database): number | null {
  return (
    db
      .query<{ t: number | null }, [number]>(
        `SELECT MIN(q.next_attempt_at) t FROM enrich_queue q JOIN documents d ON d.id = q.doc_id
         WHERE q.status = 'pending' AND d.content IS NOT NULL AND q.attempts < ?`,
      )
      .get(MAX_ATTEMPTS)?.t ?? null
  );
}
