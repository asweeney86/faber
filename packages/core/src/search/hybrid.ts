import type { Database } from "bun:sqlite";
import { groups, projectDocIds } from "../projects";
import type { SearchFilters, SearchHit, SearchRequest, SearchResponse, SearchSort } from "@faber/shared";
import { getDocs } from "../docs";
import { FRECENCY_SQL, frecencies, frecencyParams } from "../frecency";
import type { Embedder } from "../providers/types";
import { hasFilters } from "./filters";
import type { VectorIndex } from "./vectors";

/** Low k so rank 1 vs rank 2 still matters; boosts below only break near-ties. */
const RRF_K = 20;

/**
 * Words that carry no meaning in a search. Without this, "what is the doc about X"
 * prefix-matches every document on "what", "the", "doc"…
 */
const STOPWORDS = new Set(
  `a about after all also an and any are as at be been but by can could did do does doc docs document documents for from
  had has have how i if in into is it its me my no not of on or our out so some than that the their them then there these
  they this those to up us was we were what when where which who whom why will with would you your`.split(/\s+/),
);
const MIN_CANDIDATES = 60;
/** Fallback similarity floor when the embedder does not declare one. */
const MIN_SEMANTIC = 0.4;
/** Semantic matches must also be within this distance of the best one. */
const SEMANTIC_BAND = 0.15;

/** Turn free text into an FTS5 query: each term quoted (so punctuation is safe), prefix-matched, OR-joined. */
export function toFtsQuery(q: string): string {
  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
}

type Param = string | number;

/**
 * SQL restricting `documents d` (left-joined to its current enrichment `e`) to the filters.
 * Filters must already be validated (see validateFilters).
 */
export function filterSql(db: Database, f: SearchFilters | undefined): { where: string; params: Param[] } {
  if (!f) return { where: "1=1", params: [] };
  const clauses: string[] = [];
  const params: Param[] = [];
  const placeholders = (n: number) => Array(n).fill("?").join(",");
  if (f.source?.length) {
    clauses.push(`d.source IN (${placeholders(f.source.length)})`);
    params.push(...f.source);
  }
  if (f.doc_type?.length) {
    clauses.push(`e.doc_type IN (${placeholders(f.doc_type.length)})`);
    params.push(...f.doc_type);
  }
  if (f.pinned !== undefined) clauses.push(`d.pinned = ${f.pinned ? 1 : 0}`);
  if (f.seen_after !== undefined) {
    clauses.push(`d.last_seen_at >= ?`);
    params.push(f.seen_after);
  }
  if (f.seen_before !== undefined) {
    clauses.push(`d.last_seen_at <= ?`);
    params.push(f.seen_before);
  }
  if (f.tag?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM tags t WHERE t.doc_id = d.id AND t.tag IN (${placeholders(f.tag.length)}))`);
    params.push(...f.tag.map((t) => t.toLowerCase().replace(/\s+/g, "-")));
  }
  // Exact (case-insensitive) membership in the enrichment's JSON arrays; every listed value must match.
  // A project means its documents after corrections and including subprojects (as on its page).
  // A name that isn't a project matches enrichments that use exactly that name.
  const all = f.project?.length ? groups(db) : undefined;
  for (const p of f.project ?? []) {
    const ids = projectDocIds(db, p, all);
    if (ids) {
      clauses.push(`d.id IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(ids));
    } else {
      clauses.push(`EXISTS (SELECT 1 FROM json_each(e.projects) j WHERE j.value = ? COLLATE NOCASE)`);
      params.push(p);
    }
  }
  for (const p of f.person ?? []) {
    clauses.push(`(EXISTS (SELECT 1 FROM json_each(e.people) j WHERE j.value = ? COLLATE NOCASE)
      OR EXISTS (SELECT 1 FROM doc_people dp JOIN people pp ON pp.id = dp.person_id WHERE dp.doc_id = d.id AND (pp.name = ? COLLATE NOCASE OR pp.id = ?)))`);
    params.push(p, p, p);
  }
  return { where: clauses.length ? clauses.join(" AND ") : "1=1", params };
}

const FROM_DOCS = `FROM documents d LEFT JOIN enrichments e ON e.doc_id = d.id AND e.is_current = 1`;

interface FtsRow {
  doc_id: string;
  rank: number;
}

function keywordSearch(db: Database, q: string, filters: SearchFilters | undefined, limit: number): FtsRow[] {
  const fts = toFtsQuery(q);
  if (!fts) return [];
  const { where, params } = filterSql(db, filters);
  // Column weights: doc_id(0) title summary note tags people projects content
  return db
    .query<FtsRow, Param[]>(
      `SELECT d.id AS doc_id, bm25(docs_fts, 0, 12, 6, 8, 6, 6, 6, 1) AS rank
       FROM docs_fts JOIN documents d ON d.fts_rowid = docs_fts.rowid
       LEFT JOIN enrichments e ON e.doc_id = d.id AND e.is_current = 1
       WHERE docs_fts MATCH ? AND ${where} ORDER BY rank LIMIT ?`,
    )
    .all(fts, ...params, limit);
}

/**
 * Highlighted content snippets for the docs actually shown. snippet() is most of the cost
 * of a keyword query, so it runs only on the final page, not on every candidate.
 */
function snippetsFor(db: Database, q: string, ids: string[]): Map<string, string> {
  const fts = toFtsQuery(q);
  if (!fts || !ids.length) return new Map();
  return new Map(
    db
      .query<{ doc_id: string; snippet: string }, string[]>(
        `SELECT d.id AS doc_id, snippet(docs_fts, 7, '[', ']', '…', 20) AS snippet
         FROM docs_fts JOIN documents d ON d.fts_rowid = docs_fts.rowid
         WHERE docs_fts MATCH ? AND d.id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(fts, ...ids)
      .map((r) => [r.doc_id, r.snippet]),
  );
}

/** Ids of every doc matching the filters, for restricting semantic search. */
function filteredIds(db: Database, filters: SearchFilters): Set<string> {
  const { where, params } = filterSql(db, filters);
  return new Set(
    db
      .query<{ id: string }, Param[]>(`SELECT d.id ${FROM_DOCS} WHERE ${where}`)
      .all(...params)
      .map((r) => r.id),
  );
}

/** Browse without a query: pinned first, then most used (or most recently seen). */
function browse(db: Database, filters: SearchFilters | undefined, limit: number, sort: SearchSort): string[] {
  const { where, params } = filterSql(db, filters);
  if (sort === "recent") {
    return db
      .query<{ id: string }, Param[]>(`SELECT d.id ${FROM_DOCS} WHERE ${where} ORDER BY d.pinned DESC, d.last_seen_at DESC LIMIT ?`)
      .all(...params, limit)
      .map((r) => r.id);
  }
  return db
    .query<{ id: string }, Param[]>(
      `SELECT d.id, ${FRECENCY_SQL} AS f ${FROM_DOCS} WHERE ${where} ORDER BY d.pinned DESC, f DESC, d.last_seen_at DESC LIMIT ?`,
    )
    .all(...frecencyParams(), ...params, limit)
    .map((r) => r.id);
}

/** Query embeddings are reused across the digest, smart collections and repeated searches. */
const embedCache = new Map<string, Float32Array>();
const EMBED_CACHE_MAX = 256;

export async function embedQuery(embedder: Embedder, q: string): Promise<Float32Array | null> {
  const key = `${embedder.provider}/${embedder.model}\u0000${q}`;
  const hit = embedCache.get(key);
  if (hit) {
    embedCache.delete(key);
    embedCache.set(key, hit);
    return hit;
  }
  const [v] = await embedder.embed([q]);
  if (!v) return null;
  embedCache.set(key, v);
  if (embedCache.size > EMBED_CACHE_MAX) embedCache.delete(embedCache.keys().next().value!);
  return v;
}

export interface SearchDeps {
  db: Database;
  index: VectorIndex;
  embedder: Embedder | null;
}

/** `snippets: false` skips highlighting, for callers that only need which docs match (facets). */
export async function search(deps: SearchDeps, req: SearchRequest, opts: { snippets?: boolean } = {}): Promise<SearchResponse> {
  const started = performance.now();
  const { db, index, embedder } = deps;
  const limit = req.limit ?? 20;
  const mode = req.mode ?? "hybrid";
  const q = req.q.trim();
  const filters = hasFilters(req.filters) ? req.filters : undefined;
  const took = () => Math.round(performance.now() - started);

  if (!q) {
    const ids = browse(db, filters, limit, req.sort === "recent" ? "recent" : "frequent");
    const docs = getDocs(db, ids);
    return {
      hits: ids.flatMap((id) => (docs.get(id) ? [{ doc: docs.get(id)!, score: 0, snippet: null, signals: {} }] : [])),
      took_ms: took(),
      semantic: true,
    };
  }

  const candidates = Math.max(MIN_CANDIDATES, limit);
  const keyword = mode === "semantic" ? [] : keywordSearch(db, q, filters, candidates);
  let semantic: { doc_id: string; score: number }[] = [];
  let semanticOk = mode === "keyword" || index.size === 0;
  if (mode !== "keyword" && embedder && index.size > 0) {
    try {
      const qv = await embedQuery(embedder, q);
      if (qv) {
        const raw = index.search(qv, candidates, filters ? filteredIds(db, filters) : undefined);
        const floor = Math.max(embedder.minSimilarity ?? MIN_SEMANTIC, (raw[0]?.score ?? 0) - SEMANTIC_BAND);
        semantic = raw.filter((r) => r.score >= floor);
      }
      semanticOk = true;
    } catch {
      // Embedder down (Ollama not running): degrade to keyword-only rather than fail the search.
    }
  }

  const fused = new Map<string, SearchHit["signals"] & { rrf: number }>();
  const bump = (id: string) => {
    let f = fused.get(id);
    if (!f) {
      f = { rrf: 0 };
      fused.set(id, f);
    }
    return f;
  };
  keyword.forEach((r, i) => {
    const f = bump(r.doc_id);
    f.rrf += 1 / (RRF_K + i);
    f.keyword = -r.rank;
  });
  semantic.forEach((r, i) => {
    const f = bump(r.doc_id);
    f.rrf += 1 / (RRF_K + i);
    f.semantic = r.score;
  });

  const docs = getDocs(db, [...fused.keys()]);
  const nowMs = Date.now();
  const used = frecencies(db, [...fused.keys()], nowMs);
  const hits: SearchHit[] = [];
  for (const [id, f] of fused) {
    const doc = docs.get(id);
    if (!doc) continue;
    // Boosts: things you open often and recently are more likely what you mean.
    // Frecency ~100 per use this week; log-scaled so a heavy favourite helps without swamping relevance.
    const ageDays = Math.max(0, (nowMs - doc.last_seen_at) / 86_400_000);
    const recency = 1 / (1 + ageDays / 90);
    const popularity = Math.log1p(doc.visit_count) / 5;
    const frecency = used.get(id) ?? 0;
    const habit = Math.min(1, Math.log1p(frecency) / Math.log1p(2000));
    const score = f.rrf * (1 + 0.1 * recency + 0.05 * popularity + 0.3 * habit + (doc.pinned ? 0.1 : 0));
    hits.push({
      doc,
      score,
      snippet: null,
      signals: { keyword: f.keyword, semantic: f.semantic, recency, popularity, frecency },
    });
  }
  hits.sort((a, b) => b.score - a.score);
  const page = hits.slice(0, limit);
  const snippets = opts.snippets === false ? new Map<string, string>() : snippetsFor(db, q, page.filter((h) => h.signals.keyword !== undefined).map((h) => h.doc.id));
  for (const h of page) {
    const s = snippets.get(h.doc.id);
    if (s?.includes("[")) h.snippet = s;
  }
  return { hits: page, took_ms: took(), semantic: semanticOk };
}
