import type { Database } from "bun:sqlite";
import type { FacetCount, Facets } from "@faber/shared";
import { displayName, groups, rollupDocs } from "./projects";

/** Projects as the app knows them (corrections, subprojects, hand-added docs), by id with the name as label. */
function projectFacets(db: Database, limit: number, docIds?: string[]): FacetCount[] {
  const scope = docIds ? new Set(docIds) : null;
  const all = groups(db);
  return [...all.values()]
    .map((g) => {
      const docs = rollupDocs(all, g);
      return { value: g.id, label: displayName(g), count: scope ? docs.filter((d) => scope.has(d.doc_id)).length : docs.length };
    })
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/**
 * Facet counts for the search sidebar: over every document, or only `docIds`
 * (the current results) so that picking a facet never leads to zero hits.
 */
export function getFacets(db: Database, limit = 30, docIds?: string[]): Facets {
  // Scope with a temp table: result sets can exceed SQLite's parameter limit.
  let scope = "";
  if (docIds) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS facet_scope (id TEXT PRIMARY KEY)`);
    db.exec(`DELETE FROM facet_scope`);
    const ins = db.prepare(`INSERT OR IGNORE INTO facet_scope (id) VALUES (?)`);
    db.transaction(() => docIds.forEach((id) => ins.run(id)))();
    scope = "IN (SELECT id FROM facet_scope)";
  }
  const where = (col: string) => (scope ? `${col} ${scope}` : "1=1");
  const json = (column: "people" | "projects") =>
    db
      .query<FacetCount, [number]>(
        `SELECT j.value AS value, COUNT(DISTINCT e.doc_id) AS count
         FROM enrichments e, json_each(e.${column}) j
         WHERE e.is_current = 1 AND ${where("e.doc_id")}
         GROUP BY j.value ORDER BY count DESC, j.value LIMIT ?`,
      )
      .all(limit);
  return {
    doc_type: db
      .query<FacetCount, []>(
        `SELECT doc_type AS value, COUNT(*) AS count FROM enrichments WHERE is_current = 1 AND ${where("doc_id")}
         GROUP BY doc_type ORDER BY count DESC`,
      )
      .all(),
    source: db
      .query<FacetCount, []>(`SELECT source AS value, COUNT(*) AS count FROM documents WHERE ${where("id")} GROUP BY source ORDER BY count DESC`)
      .all(),
    tags: db
      .query<FacetCount, [number]>(
        `SELECT tag AS value, COUNT(*) AS count FROM tags WHERE ${where("doc_id")} GROUP BY tag ORDER BY count DESC, tag LIMIT ?`,
      )
      .all(limit),
    people: json("people"),
    projects: projectFacets(db, limit, docIds),
  };
}
