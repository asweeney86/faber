import type { Database } from "bun:sqlite";
import type {
  Doc,
  DocCollectionRef,
  DocTag,
  DocDetail,
  DocSource,
  EnrichmentRecord,
  Meeting,
  PendingContentItem,
  PersonRef,
} from "@faber/shared";
import { cleanGoogleTitle, exportUrlFor, parseGoogleUrl } from "@faber/shared";
import { newId, now } from "./db";
import { projectRefsByDoc } from "./projects";
import { enqueueEnrichment } from "./enrich/queue";

export interface DocRow {
  id: string;
  source: DocSource;
  canonical_url: string;
  external_id: string | null;
  google_authuser: number | null;
  fts_rowid: number | null;
  title: string;
  content: string | null;
  content_hash: string | null;
  content_fetched_at: number | null;
  content_error: string | null;
  content_attempts: number;
  meta: string | null;
  first_seen_at: number;
  last_seen_at: number;
  visit_count: number;
  pinned: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

interface EnrichmentRow {
  provider: string;
  model: string;
  prompt_version: number;
  summary: string;
  doc_type: string;
  written_at: string | null;
  projects: string;
  people: string;
  teams: string;
  tags: string;
  confidence: number;
  created_at: number;
}

/** A browser visit this soon after opening the doc from Faber (frecency.ts recordOpen) is that same open. */
export const OPEN_MERGE_MS = 2 * 60_000;

export interface VisitInput {
  url: string;
  title?: string;
  ts?: number;
  referrer?: string;
  dwell_ms?: number;
  origin?: "live" | "chrome-history" | "manual";
}

/** Identity for any URL we might store: Google docs collapse to a canonical form, others are kept as-is minus fragments. */
export function identify(url: string): { source: DocSource; canonical_url: string; external_id: string | null } {
  const g = parseGoogleUrl(url);
  if (g) return { source: g.kind, canonical_url: g.canonicalUrl, external_id: g.id };
  const u = new URL(url);
  u.hash = "";
  return { source: "url", canonical_url: u.toString(), external_id: null };
}

export function getDocRow(db: Database, id: string): DocRow | null {
  return db.query<DocRow, [string]>("SELECT * FROM documents WHERE id = ?").get(id);
}

export function getDocRowByUrl(db: Database, canonical: string): DocRow | null {
  return db.query<DocRow, [string]>("SELECT * FROM documents WHERE canonical_url = ?").get(canonical);
}

/** Find a document by any URL form (edit/view/u/1 variants all resolve to the same doc). */
export function lookupByUrl(db: Database, url: string): DocRow | null {
  try {
    return getDocRowByUrl(db, identify(url).canonical_url);
  } catch {
    return null;
  }
}

/** Create the document if it does not exist, without recording a visit. */
export function ensureDoc(db: Database, url: string, opts: { title?: string; ts?: number } = {}): { row: DocRow; created: boolean } {
  const ident = identify(url);
  const existing = getDocRowByUrl(db, ident.canonical_url);
  if (existing) return { row: existing, created: false };
  const id = newId();
  const ts = opts.ts ?? now();
  db.run(
    `INSERT INTO documents (id, source, canonical_url, external_id, title, first_seen_at, last_seen_at, visit_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, ident.source, ident.canonical_url, ident.external_id, cleanGoogleTitle(opts.title), ts, ts, now(), now()],
  );
  refreshFts(db, id);
  return { row: getDocRow(db, id)!, created: true };
}

/** Record a visit, creating the document if needed. Returns the row and whether it was new. */
export function recordVisit(db: Database, v: VisitInput): { row: DocRow; created: boolean } {
  const ts = v.ts ?? now();
  const title = cleanGoogleTitle(v.title) || "";
  const origin = v.origin ?? "live";

  return db.transaction(() => {
    const { row, created } = ensureDoc(db, v.url, { title, ts });
    // Remember which signed-in Google account opened it, so backfill exports as that account.
    const authuser = parseGoogleUrl(v.url)?.authuser;
    if (authuser !== undefined && authuser !== null && authuser !== row.google_authuser && ts >= row.last_seen_at) {
      db.run(`UPDATE documents SET google_authuser = ? WHERE id = ?`, [authuser, row.id]);
    }
    // Opening a doc from Faber records the visit itself; the browser then reports the same page load.
    const sameAsOpen =
      origin === "live" &&
      db.query(`SELECT 1 FROM visits WHERE doc_id = ? AND origin = 'faber' AND ts BETWEEN ? AND ?`).get(row.id, ts - OPEN_MERGE_MS, ts) !== null;
    const inserted = sameAsOpen
      ? { changes: 0 }
      : db.run(`INSERT OR IGNORE INTO visits (doc_id, ts, referrer, dwell_ms, origin) VALUES (?, ?, ?, ?, ?)`, [
          row.id,
          ts,
          v.referrer ?? null,
          v.dwell_ms ?? null,
          origin,
        ]);
    if (inserted.changes > 0 || sameAsOpen) {
      db.run(
        `UPDATE documents SET
           visit_count = visit_count + ${sameAsOpen ? 0 : 1},
           first_seen_at = MIN(first_seen_at, ?),
           last_seen_at = MAX(last_seen_at, ?),
           title = CASE WHEN ? != '' AND (title = '' OR ? >= last_seen_at) THEN ? ELSE title END,
           updated_at = ?
         WHERE id = ?`,
        [ts, ts, title, ts, title, now(), row.id],
      );
    }
    const fresh = getDocRow(db, row.id)!;
    if (fresh.title !== row.title) refreshFts(db, row.id);
    return { row: fresh, created };
  })();
}

/** Google docs change; refetch text when what we have is older than this. */
export const CONTENT_STALE_MS = 24 * 3600 * 1000;

/** Whether the extension should fetch text for this doc now. Plain web pages bring their own text at capture. */
export function needsContent(row: DocRow, at = now()): boolean {
  if (row.source === "url") return false;
  if (row.content == null) {
    // Back off after repeated failures (no access, signed out) so we do not hammer Google.
    if (row.content_attempts >= 4) return false;
    return row.content_fetched_at == null || at - row.content_fetched_at > 3600 * 1000 * row.content_attempts;
  }
  return row.content_fetched_at == null || at - row.content_fetched_at > CONTENT_STALE_MS;
}

/** Remove a document and everything derived from it. */
export function deleteDoc(db: Database, docId: string): boolean {
  return db.transaction(() => {
    const ftsRowid = db.query<{ fts_rowid: number | null }, [string]>(`SELECT fts_rowid FROM documents WHERE id = ?`).get(docId)?.fts_rowid;
    if (ftsRowid != null) db.run(`DELETE FROM docs_fts WHERE rowid = ?`, [ftsRowid]);
    return db.run(`DELETE FROM documents WHERE id = ?`, [docId]).changes > 0;
  })();
}

export function hashContent(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 32);
}

/** Store fetched text. Re-queues enrichment when the content actually changed. */
export function setContent(
  db: Database,
  docId: string,
  content: string,
  opts: { title?: string; meta?: Record<string, unknown> } = {},
): { changed: boolean } {
  const row = getDocRow(db, docId);
  if (!row) throw new Error(`No document ${docId}`);
  const hash = hashContent(content);
  const changed = hash !== row.content_hash;
  const title = cleanGoogleTitle(opts.title) || row.title;
  db.run(
    `UPDATE documents SET content = ?, content_hash = ?, content_fetched_at = ?, content_error = NULL,
       content_attempts = 0, title = ?, meta = COALESCE(?, meta), updated_at = ? WHERE id = ?`,
    [content, hash, now(), title, opts.meta ? JSON.stringify(opts.meta) : null, now(), docId],
  );
  refreshFts(db, docId);
  if (changed) enqueueEnrichment(db, docId);
  return { changed };
}

export function setContentError(db: Database, docId: string, error: string) {
  db.run(
    `UPDATE documents SET content_error = ?, content_attempts = content_attempts + 1, content_fetched_at = ?, updated_at = ? WHERE id = ?`,
    [error.slice(0, 500), now(), now(), docId],
  );
}

/**
 * Documents that still have no text, most valuable first, for the extension's backfill.
 * Failed fetches back off by an hour per attempt and stop after four.
 */
export function pendingContent(db: Database, opts: { limit?: number; sources?: DocSource[] } = {}): PendingContentItem[] {
  const sources = (opts.sources ?? ["gdoc", "gslides", "gsheets"]).filter((s) => s !== "url");
  if (sources.length === 0) return [];
  const t = now();
  const rows = db
    .query<{ doc_id: string; canonical_url: string; source: DocSource; external_id: string | null; google_authuser: number | null }, (string | number)[]>(
      `SELECT id AS doc_id, canonical_url, source, external_id, google_authuser FROM documents
       WHERE content IS NULL AND source IN (${sources.map(() => "?").join(",")}) AND content_attempts < 4
         AND (content_fetched_at IS NULL OR content_fetched_at < ? - 3600000 * content_attempts)
       ORDER BY pinned DESC, visit_count DESC, last_seen_at DESC LIMIT ?`,
    )
    .all(...sources, t, opts.limit ?? 20);
  return rows.map((r) => ({
    doc_id: r.doc_id,
    canonical_url: r.canonical_url,
    source: r.source,
    export_url: r.source !== "url" && r.external_id ? exportUrlFor(r.source, r.external_id, r.google_authuser) : null,
  }));
}

/** Count of docs waiting for text, by source. */
export function waitingForContent(db: Database): { total: number; by_source: Partial<Record<DocSource, number>> } {
  const rows = db
    .query<{ source: DocSource; n: number }, []>(
      `SELECT source, COUNT(*) n FROM documents WHERE content IS NULL AND source != 'url' AND content_attempts < 4 GROUP BY source`,
    )
    .all();
  const by_source: Partial<Record<DocSource, number>> = {};
  let total = 0;
  for (const r of rows) {
    by_source[r.source] = r.n;
    total += r.n;
  }
  return { total, by_source };
}

export function setNote(db: Database, docId: string, note: string | null) {
  db.run(`UPDATE documents SET note = ?, updated_at = ? WHERE id = ?`, [note, now(), docId]);
  refreshFts(db, docId);
}

export function setPinned(db: Database, docId: string, pinned: boolean) {
  db.run(`UPDATE documents SET pinned = ?, updated_at = ? WHERE id = ?`, [pinned ? 1 : 0, now(), docId]);
}

export function addTag(db: Database, docId: string, tag: string, source: "manual" | "auto", confidence?: number) {
  const t = normaliseTag(tag);
  if (!t) return;
  db.run(
    `INSERT INTO tags (doc_id, tag, source, confidence, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(doc_id, tag) DO UPDATE SET source = CASE WHEN tags.source = 'manual' THEN 'manual' ELSE excluded.source END`,
    [docId, t, source, confidence ?? null, now()],
  );
}

/** "Bad tag!!" → "bad-tag", "#pricing" → "pricing"; keeps letters, digits and - _ . + # (c++, c#). */
export function normaliseTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_.+#]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
}

export function removeTag(db: Database, docId: string, tag: string) {
  db.run(`DELETE FROM tags WHERE doc_id = ? AND tag = ?`, [docId, normaliseTag(tag)]);
}

function parseEnrichment(r: EnrichmentRow): EnrichmentRecord {
  return {
    provider: r.provider,
    model: r.model,
    prompt_version: r.prompt_version,
    summary: r.summary,
    doc_type: r.doc_type as EnrichmentRecord["doc_type"],
    written_at: r.written_at,
    projects: JSON.parse(r.projects),
    people: JSON.parse(r.people),
    teams: JSON.parse(r.teams),
    tags: JSON.parse(r.tags),
    confidence: r.confidence,
    created_at: r.created_at,
  };
}

const ENRICHMENT_COLUMNS = `provider, model, prompt_version, summary, doc_type, written_at, projects, people, teams, tags, confidence, created_at`;

export function currentEnrichment(db: Database, docId: string): EnrichmentRecord | null {
  const r = db
    .query<EnrichmentRow, [string]>(
      `SELECT ${ENRICHMENT_COLUMNS} FROM enrichments WHERE doc_id = ? AND is_current = 1 ORDER BY created_at DESC LIMIT 1`,
    )
    .get(docId);
  return r ? parseEnrichment(r) : null;
}

/** Everything a Doc needs, without the (potentially huge) content column. */
const DOC_COLUMNS = `id, source, canonical_url, external_id, title, content IS NOT NULL AS has_content, content_fetched_at,
  content_error, first_seen_at, last_seen_at, visit_count, pinned, note`;

interface DocListRow {
  id: string;
  source: DocSource;
  canonical_url: string;
  external_id: string | null;
  title: string;
  has_content: number;
  content_fetched_at: number | null;
  content_error: string | null;
  first_seen_at: number;
  last_seen_at: number;
  visit_count: number;
  pinned: number;
  note: string | null;
}

const BATCH = 400;

/** Load many docs with a fixed number of queries per batch (no N+1). */
export function getDocs(db: Database, ids: string[]): Map<string, Doc> {
  const out = new Map<string, Doc>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const ph = batch.map(() => "?").join(",");
    const rows = db.query<DocListRow, string[]>(`SELECT ${DOC_COLUMNS} FROM documents WHERE id IN (${ph})`).all(...batch);
    const tags = new Map<string, DocTag[]>();
    for (const t of db
      .query<{ doc_id: string; tag: string; source: DocTag["source"] }, string[]>(
        `SELECT doc_id, tag, source FROM tags WHERE doc_id IN (${ph}) ORDER BY source DESC, tag`,
      )
      .all(...batch)) {
      const list = tags.get(t.doc_id) ?? [];
      list.push({ tag: t.tag, source: t.source });
      tags.set(t.doc_id, list);
    }
    const enrichments = new Map<string, EnrichmentRecord>();
    for (const e of db
      .query<EnrichmentRow & { doc_id: string }, string[]>(
        `SELECT doc_id, ${ENRICHMENT_COLUMNS} FROM enrichments WHERE is_current = 1 AND doc_id IN (${ph}) ORDER BY created_at`,
      )
      .all(...batch)) {
      enrichments.set(e.doc_id, parseEnrichment(e));
    }
    const queue = new Map(
      db
        .query<{ doc_id: string; status: Doc["queue_status"] }, string[]>(`SELECT doc_id, status FROM enrich_queue WHERE doc_id IN (${ph})`)
        .all(...batch)
        .map((q) => [q.doc_id, q.status]),
    );
    for (const r of rows) {
      out.set(r.id, {
        id: r.id,
        source: r.source,
        canonical_url: r.canonical_url,
        external_id: r.external_id,
        title: r.title,
        has_content: r.has_content === 1,
        content_fetched_at: r.content_fetched_at,
        content_error: r.content_error,
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
        visit_count: r.visit_count,
        pinned: r.pinned === 1,
        note: r.note,
        tags: tags.get(r.id) ?? [],
        enrichment: enrichments.get(r.id) ?? null,
        queue_status: queue.get(r.id) ?? null,
        project_refs: [],
      });
    }
  }
  // The projects each doc is in now: corrections, merges and renames applied.
  if (out.size) {
    const refs = projectRefsByDoc(db, new Set(out.keys()));
    for (const [id, d] of out) d.project_refs = refs.get(id) ?? [];
  }
  return out;
}

export function getDoc(db: Database, id: string): Doc | null {
  return getDocs(db, [id]).get(id) ?? null;
}

/** Docs by id, preserving the order of `ids`. */
export function docsInOrder(db: Database, ids: string[]): Doc[] {
  const docs = getDocs(db, ids);
  return ids.flatMap((id) => {
    const d = docs.get(id);
    return d ? [d] : [];
  });
}

/** Full detail for the doc page: people, meetings, collections and recent visits. */
export function getDocDetail(db: Database, id: string): DocDetail | null {
  const doc = getDoc(db, id);
  if (!doc) return null;
  const people = db
    .query<PersonRef, [string]>(
      `SELECT DISTINCT p.id, p.name FROM doc_people dp JOIN people p ON p.id = dp.person_id WHERE dp.doc_id = ? ORDER BY p.name`,
    )
    .all(id);
  const meetings = db
    .query<Meeting, [string]>(
      `SELECT m.id, m.title, m.url, m.last_seen_at,
              (SELECT COUNT(*) FROM doc_meetings x WHERE x.meeting_id = m.id) AS doc_count
       FROM doc_meetings dm JOIN meetings m ON m.id = dm.meeting_id WHERE dm.doc_id = ? ORDER BY m.last_seen_at DESC`,
    )
    .all(id);
  const collections = db
    .query<DocCollectionRef, [string]>(
      `SELECT c.id, c.name, cd.state FROM collection_docs cd JOIN collections c ON c.id = cd.collection_id
       WHERE cd.doc_id = ? ORDER BY c.name`,
    )
    .all(id);
  const recent_visits = db
    .query<{ ts: number; referrer: string | null }, [string]>(`SELECT ts, referrer FROM visits WHERE doc_id = ? ORDER BY ts DESC LIMIT 20`)
    .all(id);
  return { ...doc, people, meetings, collections, recent_visits };
}

/** Rebuild this doc's full-text row from the current title, note, tags, enrichment and content. */
export function refreshFts(db: Database, docId: string) {
  const row = getDocRow(db, docId);
  if (!row) return;
  const e = currentEnrichment(db, docId);
  const tags = db.query<{ tag: string }, [string]>(`SELECT tag FROM tags WHERE doc_id = ?`).all(docId).map((t) => t.tag);
  db.transaction(() => {
    // Delete by rowid: doc_id is UNINDEXED in FTS5, so filtering on it scans the whole index.
    if (row.fts_rowid != null) db.run(`DELETE FROM docs_fts WHERE rowid = ?`, [row.fts_rowid]);
    const inserted = db.run(
      `INSERT INTO docs_fts (doc_id, title, summary, note, tags, people, projects, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docId,
        row.title,
        e?.summary ?? "",
        row.note ?? "",
        tags.join(" "),
        e?.people.join(" ") ?? "",
        [...(e?.projects ?? []), ...(e?.teams ?? [])].join(" "),
        (row.content ?? "").slice(0, 200_000),
      ],
    );
    db.run(`UPDATE documents SET fts_rowid = ? WHERE id = ?`, [inserted.lastInsertRowid, docId]);
  })();
}

export interface Stats {
  docs: number;
  docs_with_content: number;
  enriched: number;
  queue: { pending: number; running: number; error: number };
}

export function stats(db: Database): Stats {
  const one = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  return {
    docs: one(`SELECT COUNT(*) n FROM documents`),
    docs_with_content: one(`SELECT COUNT(*) n FROM documents WHERE content IS NOT NULL`),
    enriched: one(`SELECT COUNT(DISTINCT doc_id) n FROM enrichments WHERE is_current = 1`),
    queue: {
      pending: one(`SELECT COUNT(*) n FROM enrich_queue WHERE status = 'pending'`),
      running: one(`SELECT COUNT(*) n FROM enrich_queue WHERE status = 'running'`),
      error: one(`SELECT COUNT(*) n FROM enrich_queue WHERE status = 'error'`),
    },
  };
}
