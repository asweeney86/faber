import type { Digest } from "@faber/shared";
import { now } from "./db";
import { docsInOrder, waitingForContent } from "./docs";
import { getCollection, listCollections } from "./collections";
import type { SearchDeps } from "./search/hybrid";

const DAY = 86_400_000;

/** The home screen: what you are working on, what you used to rely on, and what is new. */
export async function buildDigest(deps: SearchDeps, opts: { limit?: number; at?: number } = {}): Promise<Digest> {
  const { db } = deps;
  const limit = opts.limit ?? 8;
  const t = opts.at ?? now();
  const ids = (sql: string, ...params: number[]) =>
    db
      .query<{ id: string }, number[]>(sql)
      .all(...params)
      .map((r) => r.id);

  const pinned = ids(`SELECT id FROM documents WHERE pinned = 1 ORDER BY last_seen_at DESC LIMIT ?`, limit * 2);
  const recent = ids(`SELECT id FROM documents WHERE last_seen_at >= ? AND visit_count > 0 ORDER BY last_seen_at DESC LIMIT ?`, t - 7 * DAY, limit);
  const frequent = ids(
    `SELECT doc_id AS id FROM visits WHERE ts >= ? GROUP BY doc_id HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC, MAX(ts) DESC LIMIT ?`,
    t - 30 * DAY,
    limit,
  );
  const resurfacing = ids(
    `SELECT doc_id AS id FROM visits
     WHERE ts BETWEEN ? AND ?
     GROUP BY doc_id
     HAVING COUNT(*) >= 3 AND doc_id NOT IN (SELECT doc_id FROM visits WHERE ts > ?)
     ORDER BY COUNT(*) DESC LIMIT ?`,
    t - 84 * DAY,
    t - 14 * DAY,
    t - 14 * DAY,
    limit,
  );

  const new_in_collections: Digest["new_in_collections"] = [];
  for (const c of listCollections(db).slice(0, 10)) {
    const detail = await getCollection(deps, c.id);
    const fresh = (detail?.items ?? []).map((i) => i.doc).filter((d) => d.first_seen_at >= t - 14 * DAY);
    if (fresh.length) new_in_collections.push({ collection: c, docs: fresh.slice(0, limit) });
  }

  return {
    pinned: docsInOrder(db, pinned),
    recent: docsInOrder(db, recent),
    frequent: docsInOrder(db, frequent),
    resurfacing: docsInOrder(db, resurfacing),
    new_in_collections,
    waiting_for_content: waitingForContent(db),
  };
}
