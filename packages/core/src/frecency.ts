/**
 * Frecency: how often *and* how recently you've used a document, from its visits.
 * Opening a document from Faber (search, launcher, a dashboard) counts more than a visit the
 * browser happened to record, since it's a deliberate pick.
 *
 * Each visit in the last 90 days scores by age (today 100 … three months 10); older visits
 * add a little each, capped, so a page you used heavily a year ago doesn't outrank this week's.
 */
import type { Database } from "bun:sqlite";
import { getDocRow } from "./docs";

const DAY = 86_400_000;

/** SQL for a document's frecency; `d` is the documents row. Bind `frecencyParams(now)` in order. */
export const FRECENCY_SQL = `(
  SELECT COALESCE(SUM(
    CASE WHEN v.ts >= ? THEN 100 WHEN v.ts >= ? THEN 80 WHEN v.ts >= ? THEN 50 WHEN v.ts >= ? THEN 30 WHEN v.ts >= ? THEN 10 ELSE 0 END
    * CASE v.origin WHEN 'faber' THEN 1.5 WHEN 'chrome-history' THEN 0.8 ELSE 1 END
  ), 0) + 2 * MIN(25, COALESCE(SUM(v.ts < ?), 0))
  FROM visits v WHERE v.doc_id = d.id
)`;

export function frecencyParams(now = Date.now()): number[] {
  const ninety = now - 90 * DAY;
  return [now - DAY, now - 4 * DAY, now - 14 * DAY, now - 31 * DAY, ninety, ninety];
}

/** Frecency for a set of documents (missing ids score 0). */
export function frecencies(db: Database, ids: string[], now = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .query<{ id: string; f: number }, (string | number)[]>(
        `SELECT d.id, ${FRECENCY_SQL} f FROM documents d WHERE d.id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...frecencyParams(now), ...chunk);
    for (const r of rows) out.set(r.id, r.f ?? 0);
  }
  return out;
}

/** Record that the document was opened from Faber. False if there's no such document. */
export function recordOpen(db: Database, id: string, ts = Date.now()): boolean {
  if (!getDocRow(db, id)) return false;
  db.transaction(() => {
    const ins = db.run(`INSERT OR IGNORE INTO visits (doc_id, ts, origin) VALUES (?, ?, 'faber')`, [id, ts]);
    if (ins.changes > 0) {
      db.run(`UPDATE documents SET visit_count = visit_count + 1, last_seen_at = MAX(last_seen_at, ?), updated_at = ? WHERE id = ?`, [ts, Date.now(), id]);
    }
  })();
  return true;
}
