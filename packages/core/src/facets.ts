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
  // Scope as one JSON parameter: result sets can exceed SQLite's parameter limit, and a
  // read-only query keeps caches keyed on writes (groups()) intact.
  // ?1 is the JSON list of ids, or NULL for every document.
  const ids = docIds ? JSON.stringify(docIds) : null;
  const where = (col: string) => `(?1 IS NULL OR ${col} IN (SELECT value FROM json_each(?1)))`;
  const json = (column: "people" | "projects") =>
    db
      .query<FacetCount, [string | null, number]>(
        `SELECT j.value AS value, COUNT(DISTINCT e.doc_id) AS count
         FROM enrichments e, json_each(e.${column}) j
         WHERE e.is_current = 1 AND ${where("e.doc_id")}
         GROUP BY j.value ORDER BY count DESC, j.value LIMIT ?2`,
      )
      .all(ids, limit);
  return {
    doc_type: db
      .query<FacetCount, [string | null]>(
        `SELECT doc_type AS value, COUNT(*) AS count FROM enrichments WHERE is_current = 1 AND ${where("doc_id")}
         GROUP BY doc_type ORDER BY count DESC`,
      )
      .all(ids),
    source: db
      .query<FacetCount, [string | null]>(
        `SELECT source AS value, COUNT(*) AS count FROM documents WHERE ${where("id")} GROUP BY source ORDER BY count DESC`,
      )
      .all(ids),
    tags: db
      .query<FacetCount, [string | null, number]>(
        `SELECT tag AS value, COUNT(*) AS count FROM tags WHERE ${where("doc_id")} GROUP BY tag ORDER BY count DESC, tag LIMIT ?2`,
      )
      .all(ids, limit),
    people: json("people"),
    projects: projectFacets(db, limit, docIds),
  };
}
