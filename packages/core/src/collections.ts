import type { Database } from "bun:sqlite";
import type {
  Collection,
  CollectionDetail,
  CollectionExport,
  CollectionInput,
  CollectionItem,
  CollectionQuery,
  DocCollectionRef,
  ImportResult,
} from "@faber/shared";
import { COLLECTION_FORMAT, isCollectionFormat } from "@faber/shared";
import { newId, now } from "./db";
import { addTag, docsInOrder, ensureDoc, getDoc, refreshFts } from "./docs";
import { hasFilters, validateFilters } from "./search/filters";
import { search, type SearchDeps } from "./search/hybrid";

/** Max documents a saved query contributes to a collection. */
const QUERY_LIMIT = 200;

export class CollectionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  query: string | null;
  created_at: number;
  updated_at: number;
  pin_count: number;
}

const SELECT = `SELECT c.*, (SELECT COUNT(*) FROM collection_docs cd WHERE cd.collection_id = c.id AND cd.state = 'pin') AS pin_count
  FROM collections c`;

function toCollection(r: CollectionRow): Collection {
  let query: CollectionQuery | null = null;
  try {
    // Re-validate on read: a bad row written by an older version must not break every page that lists collections.
    query = r.query ? cleanQuery(JSON.parse(r.query)) : null;
  } catch {
    query = null;
  }
  return { ...r, query };
}

function hasQuery(q: CollectionQuery | null | undefined): q is CollectionQuery {
  return Boolean(q && (q.q?.trim() || hasFilters(q.filters)));
}

/** Validate a saved query from untrusted input (API body or an imported file). */
function cleanQuery(raw: unknown): CollectionQuery | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new CollectionError("query must be an object");
  const q = raw as { q?: unknown; filters?: unknown };
  if (q.q !== undefined && q.q !== null && typeof q.q !== "string") throw new CollectionError("query.q must be a string");
  let filters;
  try {
    filters = validateFilters(q.filters);
  } catch (e) {
    throw new CollectionError(e instanceof Error ? e.message : String(e));
  }
  const text = typeof q.q === "string" ? q.q.trim().slice(0, 500) : "";
  const clean: CollectionQuery = {};
  if (text) clean.q = text;
  if (filters) clean.filters = filters;
  return hasQuery(clean) ? clean : null;
}

function cleanName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new CollectionError("name is required");
  return name.trim().slice(0, 120);
}

export function listCollections(db: Database): Collection[] {
  return db.query<CollectionRow, []>(`${SELECT} ORDER BY c.updated_at DESC`).all().map(toCollection);
}

export function getCollectionRow(db: Database, id: string): Collection | null {
  const r = db.query<CollectionRow, [string]>(`${SELECT} WHERE c.id = ?`).get(id);
  return r ? toCollection(r) : null;
}

export function createCollection(db: Database, input: CollectionInput, id = newId()): Collection {
  const t = now();
  db.run(`INSERT INTO collections (id, name, description, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    id,
    cleanName(input.name),
    input.description?.trim() || null,
    JSON.stringify(cleanQuery(input.query)),
    t,
    t,
  ]);
  return getCollectionRow(db, id)!;
}

export function updateCollection(db: Database, id: string, input: Partial<CollectionInput>): Collection {
  const cur = getCollectionRow(db, id);
  if (!cur) throw new CollectionError("collection not found", 404);
  const name = input.name !== undefined ? cleanName(input.name) : cur.name;
  const description = input.description !== undefined ? input.description?.trim() || null : cur.description;
  const query = input.query !== undefined ? cleanQuery(input.query) : cur.query;
  db.run(`UPDATE collections SET name = ?, description = ?, query = ?, updated_at = ? WHERE id = ?`, [
    name,
    description,
    JSON.stringify(query),
    now(),
    id,
  ]);
  return getCollectionRow(db, id)!;
}

export function deleteCollection(db: Database, id: string): boolean {
  return db.run(`DELETE FROM collections WHERE id = ?`, [id]).changes > 0;
}

/** Pin a doc into a collection, or exclude it from the collection's saved query. */
export function setCollectionDoc(db: Database, id: string, docId: string, state: "pin" | "exclude", sharedNote?: string | null) {
  if (!getCollectionRow(db, id)) throw new CollectionError("collection not found", 404);
  if (!getDoc(db, docId)) throw new CollectionError("document not found", 404);
  if (state !== "pin" && state !== "exclude") throw new CollectionError(`invalid state "${state}"`);
  db.run(
    `INSERT INTO collection_docs (collection_id, doc_id, state, shared_note, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(collection_id, doc_id) DO UPDATE SET state = excluded.state,
       shared_note = COALESCE(excluded.shared_note, collection_docs.shared_note)`,
    [id, docId, state, sharedNote ?? null, now()],
  );
  db.run(`UPDATE collections SET updated_at = ? WHERE id = ?`, [now(), id]);
}

/** Remove a pin or an exclusion; the doc reverts to whatever the saved query says. */
export function removeCollectionDoc(db: Database, id: string, docId: string) {
  db.run(`DELETE FROM collection_docs WHERE collection_id = ? AND doc_id = ?`, [id, docId]);
  db.run(`UPDATE collections SET updated_at = ? WHERE id = ?`, [now(), id]);
}

/** Pins first (newest first), then saved-query matches in relevance order, minus exclusions. */
export async function getCollection(deps: SearchDeps, id: string): Promise<CollectionDetail | null> {
  const { db } = deps;
  const c = getCollectionRow(db, id);
  if (!c) return null;
  const rows = db
    .query<{ doc_id: string; state: "pin" | "exclude"; shared_note: string | null }, [string]>(
      `SELECT doc_id, state, shared_note FROM collection_docs WHERE collection_id = ? ORDER BY created_at DESC`,
    )
    .all(id);
  const pins = rows.filter((r) => r.state === "pin");
  const excluded = new Set(rows.filter((r) => r.state === "exclude").map((r) => r.doc_id));
  const pinned = new Set(pins.map((r) => r.doc_id));

  const items: CollectionItem[] = pins.flatMap((r) => {
    const doc = getDoc(db, r.doc_id);
    return doc ? [{ doc, state: "pin" as const, shared_note: r.shared_note }] : [];
  });

  if (hasQuery(c.query)) {
    const res = await search(deps, { q: c.query.q ?? "", filters: c.query.filters, limit: QUERY_LIMIT });
    for (const h of res.hits) {
      if (pinned.has(h.doc.id) || excluded.has(h.doc.id)) continue;
      items.push({ doc: h.doc, state: "query", shared_note: null });
    }
  }
  return { ...c, items, excluded: docsInOrder(db, [...excluded]) };
}

export async function exportCollection(deps: SearchDeps, id: string): Promise<CollectionExport | null> {
  const c = await getCollection(deps, id);
  if (!c) return null;
  return {
    format: COLLECTION_FORMAT,
    version: 1,
    id: c.id,
    name: c.name,
    description: c.description,
    query: c.query,
    exported_at: new Date().toISOString(),
    items: c.items.map(({ doc, shared_note }) => ({
      url: doc.canonical_url,
      title: doc.title,
      // Share your own note; if you have none, pass along the one you were given.
      note: doc.note ?? shared_note,
      // Only tags you chose: auto tags are derived from the document text.
      tags: doc.tags.filter((t) => t.source === "manual").map((t) => t.tag),
    })),
  };
}

const MAX_IMPORT_ITEMS = 5000;

/**
 * Import a collection file. The collection keeps its id, so re-importing an
 * updated file from a colleague updates it in place. Items become pins unless
 * your copy already includes them (pinned, excluded, or matched by its saved
 * query); notes are kept as shared notes, separate from your own, and only when
 * they differ from your own note.
 */
export async function importCollection(deps: SearchDeps, file: CollectionExport): Promise<ImportResult> {
  const { db } = deps;
  if (!file || !isCollectionFormat(file.format)) throw new CollectionError("not a Faber collection file");
  if (file.version !== 1) throw new CollectionError(`unsupported collection version ${String(file.version)}`);
  if (typeof file.id !== "string" || !/^[\w-]{8,64}$/.test(file.id)) throw new CollectionError("collection id is missing or invalid");
  if (!Array.isArray(file.items)) throw new CollectionError("items must be an array");
  if (file.items.length > MAX_IMPORT_ITEMS) throw new CollectionError(`too many items (max ${MAX_IMPORT_ITEMS})`);

  const input = { name: file.name, description: file.description, query: cleanQuery(file.query) };
  // What the saved query already matches here (before we touch anything), so those stay query matches.
  let matched = new Set<string>();
  if (hasQuery(input.query)) {
    const res = await search(deps, { q: input.query.q ?? "", filters: input.query.filters, limit: QUERY_LIMIT });
    matched = new Set(res.hits.map((h) => h.doc.id));
  }
  const existing = new Map(
    db
      .query<{ doc_id: string; state: string }, [string]>(`SELECT doc_id, state FROM collection_docs WHERE collection_id = ?`)
      .all(file.id)
      .map((r) => [r.doc_id, r.state]),
  );

  return db.transaction(() => {
    if (getCollectionRow(db, file.id)) updateCollection(db, file.id, input);
    else createCollection(db, input, file.id);

    let created = 0;
    let items = 0;
    for (const item of file.items) {
      if (!item || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) continue;
      let r: ReturnType<typeof ensureDoc>;
      try {
        r = ensureDoc(db, item.url, { title: typeof item.title === "string" ? item.title : undefined });
      } catch {
        continue;
      }
      if (r.created) {
        created++;
        // Give brand-new docs the sender's tags until your own enrichment replaces them.
        for (const t of Array.isArray(item.tags) ? item.tags.slice(0, 20) : []) {
          if (typeof t === "string") addTag(db, r.row.id, t, "auto");
        }
        refreshFts(db, r.row.id);
      }
      items++;
      const own = r.row.note?.trim() ?? null;
      const shared = typeof item.note === "string" && item.note.trim() ? item.note.trim().slice(0, 2000) : null;
      const note = shared && shared !== own ? shared : null;
      const state = existing.get(r.row.id);
      if (state === "pin" || state === "exclude" || matched.has(r.row.id)) {
        // Already part of (or deliberately excluded from) your copy: only carry a new shared note.
        if (note) db.run(`UPDATE collection_docs SET shared_note = ? WHERE collection_id = ? AND doc_id = ?`, [note, file.id, r.row.id]);
        continue;
      }
      setCollectionDoc(db, file.id, r.row.id, "pin", note);
    }
    return { collection_id: file.id, created_docs: created, items };
  })();
}

/**
 * Every collection a document belongs to: pinned, or matched by a saved query
 * (and not excluded). Smart collections need a search each, so this is async.
 */
export async function collectionsForDoc(deps: SearchDeps, docId: string): Promise<DocCollectionRef[]> {
  const { db } = deps;
  const explicit = new Map(
    db
      .query<{ collection_id: string; state: "pin" | "exclude" }, [string]>(
        `SELECT collection_id, state FROM collection_docs WHERE doc_id = ?`,
      )
      .all(docId)
      .map((r) => [r.collection_id, r.state]),
  );
  const out: DocCollectionRef[] = [];
  for (const c of listCollections(db)) {
    const state = explicit.get(c.id);
    if (state === "pin") out.push({ id: c.id, name: c.name, state: "pin" });
    else if (state === "exclude") out.push({ id: c.id, name: c.name, state: "exclude" });
    else if (hasQuery(c.query)) {
      const res = await search(deps, { q: c.query.q ?? "", filters: c.query.filters, limit: QUERY_LIMIT });
      if (res.hits.some((h) => h.doc.id === docId)) out.push({ id: c.id, name: c.name, state: "query" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
