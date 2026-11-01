import type { Database } from "bun:sqlite";
import type { Enrichment } from "@faber/shared";
import type { Config } from "../config";
import { newId, now } from "../db";
import { addTag, getDocRow, refreshFts } from "../docs";
import type { Embedder, Enricher } from "../providers/types";
import { chunkText } from "../search/chunk";
import type { VectorIndex } from "../search/vectors";
import { PROMPT_VERSION } from "./prompt";
import { claimJobs, completeJob, failJob } from "./queue";

export interface RunDeps {
  db: Database;
  cfg: Config;
  enricher: Enricher;
  embedder: Embedder;
  index: VectorIndex;
  log?: (msg: string) => void;
}

/** Enrich one document end to end: LLM extraction, tags, people, FTS, embeddings. */
export async function enrichDoc(deps: RunDeps, docId: string, opts: { force?: boolean } = {}): Promise<Enrichment> {
  const { db, cfg, enricher, embedder, index } = deps;
  const row = getDocRow(db, docId);
  if (!row) throw new Error(`No document ${docId}`);
  if (row.content == null) throw new Error(`Document ${docId} has no content yet`);

  // If this exact content was already enriched by this model and prompt (e.g. only embedding
  // failed last time), reuse it instead of paying for another LLM call.
  const existing = db
    .query<{ raw: string }, [string, string, string, string, number]>(
      `SELECT raw FROM enrichments WHERE doc_id = ? AND is_current = 1 AND content_hash = ? AND provider = ? AND model = ? AND prompt_version = ?`,
    )
    .get(docId, row.content_hash ?? "", enricher.provider, enricher.model, PROMPT_VERSION);
  if (existing && !opts.force) {
    const enrichment = JSON.parse(existing.raw) as Enrichment;
    await embedDoc({ db, cfg, embedder, index }, docId, enrichment.summary);
    return enrichment;
  }

  const text = row.content.slice(0, cfg.enrichment.max_chars);
  const enrichment = await enricher.enrich({
    title: row.title,
    url: row.canonical_url,
    source: row.source,
    text,
    first_seen_iso: new Date(row.first_seen_at).toISOString().slice(0, 10),
  });

  db.transaction(() => {
    db.run(`UPDATE enrichments SET is_current = 0 WHERE doc_id = ?`, [docId]);
    db.run(
      `INSERT INTO enrichments (doc_id, provider, model, prompt_version, content_hash, summary, doc_type, written_at,
         projects, people, teams, tags, confidence, raw, is_current, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        docId,
        enricher.provider,
        enricher.model,
        PROMPT_VERSION,
        row.content_hash,
        enrichment.summary,
        enrichment.doc_type,
        enrichment.written_at,
        JSON.stringify(enrichment.projects),
        JSON.stringify(enrichment.people),
        JSON.stringify(enrichment.teams),
        JSON.stringify(enrichment.tags),
        enrichment.confidence,
        JSON.stringify(enrichment),
        now(),
      ],
    );
    db.run(`DELETE FROM tags WHERE doc_id = ? AND source = 'auto'`, [docId]);
    for (const t of enrichment.tags) addTag(db, docId, t, "auto", enrichment.confidence);
    db.run(`DELETE FROM doc_people WHERE doc_id = ? AND role = 'mentioned'`, [docId]);
    for (const name of enrichment.people) {
      const pid = upsertPerson(db, name);
      db.run(`INSERT OR IGNORE INTO doc_people (doc_id, person_id, role) VALUES (?, ?, 'mentioned')`, [docId, pid]);
    }
  })();
  refreshFts(db, docId);

  await embedDoc({ db, cfg, embedder, index }, docId, enrichment.summary);
  return enrichment;
}

/** (Re)embed a document: the summary plus the first N chunks of its text. */
export async function embedDoc(
  deps: Pick<RunDeps, "db" | "cfg" | "embedder" | "index">,
  docId: string,
  summary?: string,
) {
  const { db, cfg, embedder, index } = deps;
  const row = getDocRow(db, docId);
  if (!row) return;
  const pieces: string[] = [];
  const header = `${row.title}\n${summary ?? ""}`.trim();
  if (header) pieces.push(header);
  pieces.push(...chunkText(row.content ?? "", cfg.search.chunk_chars, cfg.search.max_chunks_per_doc));
  if (pieces.length === 0) return;

  const vectors = await embedder.embed(pieces);
  db.transaction(() => {
    db.run(`DELETE FROM chunks WHERE doc_id = ?`, [docId]);
    pieces.forEach((text, ix) => {
      const v = vectors[ix]!;
      db.run(`INSERT INTO chunks (doc_id, ix, text, embedding, embed_model) VALUES (?, ?, ?, ?, ?)`, [
        docId,
        ix,
        text,
        new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
        embedder.model,
      ]);
    });
  })();
  index.setDoc(docId, vectors);
}

/**
 * Enriched documents with no chunks from `model`: after the embedding model changes, these
 * need re-embedding (their summaries are reused; the LLM isn't called again).
 */
const NEEDS_EMBEDDING = `FROM documents d JOIN enrichments e ON e.doc_id = d.id AND e.is_current = 1
  WHERE d.content IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.doc_id = d.id AND c.embed_model = ?)`;

export function countNeedingEmbedding(db: Database, model: string): number {
  return db.query<{ n: number }, [string]>(`SELECT COUNT(*) n ${NEEDS_EMBEDDING}`).get(model)!.n;
}

/** Re-embed up to `limit` documents that lack chunks from the current embedding model. Returns how many were done. */
export async function embedMissing(deps: Pick<RunDeps, "db" | "cfg" | "embedder" | "index">, limit = 25, signal?: AbortSignal): Promise<number> {
  const rows = deps.db
    .query<{ id: string; summary: string }, [string, number]>(`SELECT d.id, e.summary ${NEEDS_EMBEDDING} ORDER BY d.last_seen_at DESC LIMIT ?`)
    .all(deps.embedder.model, limit);
  let n = 0;
  for (const r of rows) {
    if (signal?.aborted) break;
    await embedDoc(deps, r.id, r.summary);
    n++;
  }
  return n;
}

function upsertPerson(db: Database, name: string): string {
  const existing = db.query<{ id: string }, [string]>(`SELECT id FROM people WHERE lower(name) = lower(?)`).get(name);
  if (existing) return existing.id;
  const id = newId();
  db.run(`INSERT INTO people (id, name, created_at) VALUES (?, ?, ?)`, [id, name, now()]);
  return id;
}

const shortTitle = (t: string) => (t.length > 80 ? `${t.slice(0, 79)}…` : t);

export interface RunResult {
  processed: number;
  failed: number;
  /** Set when the pass stopped early because a provider could not be reached. */
  unavailable?: string;
}

/** Connection-level failures mean the provider is down, not that this document is bad. */
export function isProviderUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message} ${(err as { code?: string }).code ?? ""}` : String(err);
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|Unable to connect|fetch failed|ConnectionRefused|TimeoutError|timed out|socket connection was closed/i.test(
    msg,
  );
}

/** Drain the enrichment queue. Runs `limit` jobs (or all when undefined) with the configured concurrency. */
export async function runQueue(deps: RunDeps, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
  const { db, cfg } = deps;
  const log = deps.log ?? (() => {});
  const result: RunResult = { processed: 0, failed: 0 };
  let remaining = opts.limit ?? Number.POSITIVE_INFINITY;

  while (remaining > 0 && !opts.signal?.aborted) {
    const batch = claimJobs(db, Math.min(cfg.enrichment.concurrency, remaining));
    if (batch.length === 0) break;
    await Promise.all(
      batch.map(async (job) => {
        const row = getDocRow(db, job.doc_id);
        const started = Date.now();
        try {
          const e = await enrichDoc(deps, job.doc_id, { force: job.force });
          completeJob(db, job.doc_id);
          result.processed++;
          log(`✓ ${shortTitle(row?.title || job.doc_id)} → ${e.doc_type} [${e.tags.join(", ")}] (${Date.now() - started}ms)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isProviderUnavailable(err)) {
            // Don't burn the doc's attempts while Ollama (or the network) is down.
            failJob(db, job.doc_id, msg, { countAttempt: false });
            result.unavailable = msg;
          } else {
            failJob(db, job.doc_id, msg);
            result.failed++;
          }
          log(`✗ ${shortTitle(row?.title || job.doc_id)}: ${msg.slice(0, 300)}`);
        }
      }),
    );
    remaining -= batch.length;
    if (result.unavailable) break;
  }
  return result;
}
