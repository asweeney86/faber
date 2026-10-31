import type { Database } from "bun:sqlite";

export interface ChunkHit {
  doc_id: string;
  ix: number;
  score: number;
}

/**
 * In-memory brute-force cosine index over chunk embeddings, keyed by document.
 *
 * Deliberately simple: a few thousand docs × ~16 chunks × 1024 dims is tens of
 * MB and a few milliseconds per query, with no native extensions to install.
 * Vectors are normalised on insert so a query is one dot product per chunk.
 */
export class VectorIndex {
  /** docId → normalised vectors in chunk order. */
  private docs = new Map<string, Float32Array[]>();
  private count = 0;
  private dims = 0;
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  /** Number of chunk vectors. */
  get size() {
    return this.count;
  }

  /** Load every chunk embedded with this index's model. */
  static load(db: Database, model: string): VectorIndex {
    const idx = new VectorIndex(model);
    const rows = db
      .query<{ doc_id: string; embedding: Uint8Array }, [string]>(
        `SELECT doc_id, embedding FROM chunks WHERE embedding IS NOT NULL AND embed_model = ? ORDER BY doc_id, ix`,
      )
      .all(model);
    let cur: string | null = null;
    let batch: Float32Array[] = [];
    const flush = () => {
      if (cur !== null) idx.setDoc(cur, batch);
    };
    for (const r of rows) {
      if (r.doc_id !== cur) {
        flush();
        cur = r.doc_id;
        batch = [];
      }
      // Copy: the blob's buffer may not be 4-byte aligned.
      const bytes = r.embedding.slice();
      batch.push(new Float32Array(bytes.buffer, 0, bytes.byteLength / 4));
    }
    flush();
    return idx;
  }

  /** Replace a document's vectors; vectors[i] is chunk i. */
  setDoc(docId: string, vectors: Float32Array[]) {
    for (const v of vectors) {
      const dims = this.dims || v.length;
      if (v.length !== dims) throw new Error(`Embedding dims mismatch: ${v.length} vs ${dims}. Run \`faber reindex\`.`);
    }
    this.removeDoc(docId);
    if (vectors.length === 0) return;
    if (this.dims === 0) this.dims = vectors[0]!.length;
    this.docs.set(docId, vectors.map(normalise));
    this.count += vectors.length;
  }

  removeDoc(docId: string) {
    const prev = this.docs.get(docId);
    if (!prev) return;
    this.docs.delete(docId);
    this.count -= prev.length;
    if (this.count === 0) this.dims = 0;
  }

  /** A document's (normalised) vectors in chunk order. */
  vectorsFor(docId: string): Float32Array[] {
    return this.docs.get(docId) ?? [];
  }

  /** Top-k chunks, optionally restricted to a set of documents. */
  searchChunks(query: Float32Array, k: number, onlyDocs?: Set<string>): ChunkHit[] {
    if (this.count === 0 || query.length !== this.dims) return [];
    const q = normalise(query);
    const hits: ChunkHit[] = [];
    for (const [id, vs] of this.entries(onlyDocs)) {
      vs.forEach((v, ix) => hits.push({ doc_id: id, ix, score: dot(q, v) }));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** Top-k documents by their best-matching chunk. Scores are cosine similarities in [-1, 1]. */
  search(query: Float32Array, k: number, onlyDocs?: Set<string>): { doc_id: string; score: number }[] {
    if (this.count === 0 || query.length !== this.dims) return [];
    const q = normalise(query);
    const out: { doc_id: string; score: number }[] = [];
    for (const [id, vs] of this.entries(onlyDocs)) {
      let best = -Infinity;
      for (const v of vs) best = Math.max(best, dot(q, v));
      out.push({ doc_id: id, score: best });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }

  private *entries(onlyDocs?: Set<string>): Iterable<[string, Float32Array[]]> {
    if (!onlyDocs) {
      yield* this.docs;
      return;
    }
    for (const id of onlyDocs) {
      const vs = this.docs.get(id);
      if (vs) yield [id, vs];
    }
  }
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}
