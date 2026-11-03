#!/usr/bin/env bun
/**
 * Try ranking variants offline against the benchmark queries, on a copy of a library.
 * Re-implements hybrid search (FTS5 bm25 + vector similarity, fused with reciprocal rank)
 * with every knob exposed, checks that the baseline reproduces the live numbers, then
 * scores each variant by hit@1 and MRR per query kind.
 *
 *   sqlite3 ~/.faber/faber.sqlite ".backup /tmp/lib.sqlite"
 *   bun scripts/bench/rank-lab.ts /tmp/lib.sqlite [--embed-model qwen3-embedding:0.6b]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { frecencies, identify, openDatabase, toFtsQuery, VectorIndex } from "../../packages/core/src/index";
import { OllamaEmbedder } from "../../packages/core/src/providers/ollama";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: join(homedir(), ".faber", "bench") },
    "embed-model": { type: "string", default: "qwen3-embedding:0.6b" },
    "min-sim": { type: "string", default: "0.47" },
    /** Pretend only this share of docs is embedded (0–1), to study ranking while indexing catches up. */
    "embedded-share": { type: "string", default: "1" },
  },
});
const db = openDatabase(positionals[0]!);
const OUT = values.out!;
type Kind = "title" | "gist" | "detail";
const queries = (JSON.parse(readFileSync(join(OUT, "queries.json"), "utf8")) as { url: string; kind: Kind; q: string }[]).filter((q) => q.q);

// url → doc id, the way the daemon canonicalises URLs.
const idByUrl = new Map(db.query<{ id: string; canonical_url: string }, []>("SELECT id, canonical_url FROM documents").all().map((r) => [r.canonical_url, r.id]));
const want = (url: string) => idByUrl.get(identify(url).canonical_url);

let index = VectorIndex.load(db, values["embed-model"]!);
const share = Number(values["embedded-share"]);
if (share < 1) {
  const keep = new VectorIndex(index.model);
  let i = 0;
  for (const id of idByUrl.values()) if ((i++ * 0.618) % 1 < share && index.vectorsFor(id).length) keep.setDoc(id, index.vectorsFor(id));
  index = keep;
}
console.log(`${idByUrl.size} docs, ${index.size} chunk vectors, ${queries.length} queries`);

// Query embeddings, cached (the model is deterministic).
const embCache = join(OUT, `query-embeddings-${values["embed-model"]!.replace(/[:/]/g, "_")}.json`);
const cached: Record<string, number[]> = existsSync(embCache) ? JSON.parse(readFileSync(embCache, "utf8")) : {};
const embedder = new OllamaEmbedder({ model: values["embed-model"]!, baseUrl: "http://127.0.0.1:11434" });
const missing = [...new Set(queries.map((q) => q.q))].filter((q) => !cached[q]);
for (let i = 0; i < missing.length; i += 32) {
  const batch = missing.slice(i, i + 32);
  const vs = await embedder.embed(batch);
  batch.forEach((q, j) => (cached[q] = Array.from(vs[j]!)));
}
writeFileSync(embCache, JSON.stringify(cached));
const qvec = (q: string) => new Float32Array(cached[q]!);

interface Doc {
  id: string;
  title: string;
  last_seen_at: number;
  visit_count: number;
  pinned: number;
}
const docs = new Map(db.query<Doc, []>("SELECT id, title, last_seen_at, visit_count, pinned FROM documents").all().map((d) => [d.id, d]));
const habitAll = frecencies(db, [...docs.keys()]);

interface Variant {
  name: string;
  rrfK?: number;
  /** Boost weights (multipliers on the fused score), as in hybrid.ts. */
  recency?: number;
  popularity?: number;
  habit?: number;
  pinned?: number;
  /** bm25 column weights: title, summary, note, tags, people, projects, content. */
  weights?: number[];
  /** Extra boost by the share of query terms found in the title. */
  titleCoverage?: number;
  /** Semantic floor: absolute, and band below the best match. */
  minSim?: number;
  band?: number;
  /** Weight of the semantic list in the fusion (keyword is 1). */
  semanticWeight?: number;
  /** Docs without vectors get their keyword contribution twice (so they aren't outranked just for being unindexed). */
  fillUnembedded?: boolean;
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function rank(q: string, v: Variant): string[] {
  const K = v.rrfK ?? 20;
  const w = v.weights ?? [12, 6, 8, 6, 6, 6, 1];
  const fts = toFtsQuery(q);
  const kw = fts
    ? db
        .query<{ doc_id: string }, [string]>(
          `SELECT d.id AS doc_id FROM docs_fts JOIN documents d ON d.fts_rowid = docs_fts.rowid WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts, 0, ${w.join(", ")}) LIMIT 60`,
        )
        .all(fts)
    : [];
  const raw = index.search(qvec(q), 60);
  const floor = Math.max(v.minSim ?? Number(values["min-sim"]), (raw[0]?.score ?? 0) - (v.band ?? 0.15));
  const sem = raw.filter((r) => r.score >= floor);
  const fused = new Map<string, number>();
  kw.forEach((r, i) => {
    const add = 1 / (K + i);
    fused.set(r.doc_id, (fused.get(r.doc_id) ?? 0) + add * (v.fillUnembedded && index.vectorsFor(r.doc_id).length === 0 ? 2 : 1));
  });
  sem.forEach((r, i) => fused.set(r.doc_id, (fused.get(r.doc_id) ?? 0) + (v.semanticWeight ?? 1) / (K + i)));
  const qw = words(q).filter((x) => x.length > 2);
  const now = Date.now();
  const scored = [...fused].map(([id, rrf]) => {
    const d = docs.get(id)!;
    const ageDays = Math.max(0, (now - d.last_seen_at) / 86_400_000);
    const recency = 1 / (1 + ageDays / 90);
    const popularity = Math.log1p(d.visit_count) / 5;
    const habit = Math.min(1, Math.log1p(habitAll.get(id) ?? 0) / Math.log1p(2000));
    const tw = new Set(words(d.title));
    const coverage = qw.length ? qw.filter((x) => [...tw].some((t) => t.startsWith(x))).length / qw.length : 0;
    const boost = 1 + (v.recency ?? 0.1) * recency + (v.popularity ?? 0.05) * popularity + (v.habit ?? 0.3) * habit + (d.pinned ? (v.pinned ?? 0.1) : 0) + (v.titleCoverage ?? 0) * coverage;
    return { id, score: rrf * boost };
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.id);
}

function evaluate(v: Variant) {
  const by: Record<string, { n: number; h1: number; rr: number }> = {};
  for (const q of queries) {
    const id = want(q.url);
    if (!id) continue;
    const r = rank(q.q, v).indexOf(id) + 1;
    for (const k of [q.kind, "all"]) {
      const b = (by[k] ??= { n: 0, h1: 0, rr: 0 });
      b.n++;
      if (r === 1) b.h1++;
      if (r) b.rr += 1 / r;
    }
  }
  const f = (k: string) => (by[k] ? `${Math.round((100 * by[k]!.h1) / by[k]!.n)}% / ${(by[k]!.rr / by[k]!.n).toFixed(2)}` : "-");
  return [v.name, f("title"), f("gist"), f("detail"), f("all")];
}

const VARIANTS: Variant[] = [
  { name: "current (0.1.3)" },
  { name: "shipped (after tuning)", habit: 0.15, recency: 0.05, popularity: 0.05, titleCoverage: 0.3, semanticWeight: 0.5, weights: [12, 6, 8, 6, 6, 6, 3] },
  { name: "no use boosts", habit: 0, recency: 0, popularity: 0, pinned: 0 },
  { name: "gentle use boosts (habit 0.05)", habit: 0.05, recency: 0.03, popularity: 0 },
  { name: "+ title coverage 0.3", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3 },
  { name: "+ title coverage 0.6", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.6 },
  { name: "gentle + semantic weight 1.5", habit: 0.05, recency: 0.03, popularity: 0, semanticWeight: 1.5 },
  { name: "gentle + cov 0.3 + sem 1.5", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, semanticWeight: 1.5 },
  { name: "gentle + cov 0.3 + rrfK 60", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, rrfK: 60 },
  { name: "gentle + cov 0.3 + wider band 0.25", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, band: 0.25 },
  { name: "gentle + cov 0.3 + content weight 2", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, weights: [12, 6, 8, 6, 6, 6, 2] },
  { name: "gentle + cov 0.3 + fill unembedded", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, fillUnembedded: true },
  { name: "no boosts + semantic weight 0.5", habit: 0, recency: 0, popularity: 0, pinned: 0, semanticWeight: 0.5 },
  { name: "gentle + cov 0.3 + sem 0.5", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, semanticWeight: 0.5 },
  { name: "gentle + cov 0.3 + sem 0.5 + content 2", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, semanticWeight: 0.5, weights: [12, 6, 8, 6, 6, 6, 2] },
  { name: "gentle + cov 0.3 + sem 0.7 + content 2", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, semanticWeight: 0.7, weights: [12, 6, 8, 6, 6, 6, 2] },
  { name: "gentle + cov 0.3 + sem 0.5 + content 3", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, semanticWeight: 0.5, weights: [12, 6, 8, 6, 6, 6, 3] },
  { name: "gentle + cov 0.2 + sem 0.5 + content 2 + band 0.08", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.2, semanticWeight: 0.5, weights: [12, 6, 8, 6, 6, 6, 2], band: 0.08 },
  { name: "gentle + cov 0.3 + sem 0.3 + content 3", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, semanticWeight: 0.3, weights: [12, 6, 8, 6, 6, 6, 3] },
  { name: "gentle + cov 0.3 + sem 0.5 + content 4", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, semanticWeight: 0.5, weights: [12, 6, 8, 6, 6, 6, 4] },
  { name: "gentle + cov 0.3 + sem 0.5 + content 3 + band 0.08", habit: 0.05, recency: 0.03, popularity: 0, titleCoverage: 0.3, semanticWeight: 0.5, weights: [12, 6, 8, 6, 6, 6, 3], band: 0.08 },
  { name: "habit 0.15 + cov 0.3 + sem 0.5 + content 3", habit: 0.15, recency: 0.05, popularity: 0, titleCoverage: 0.3, semanticWeight: 0.5, weights: [12, 6, 8, 6, 6, 6, 3] },
  { name: "habit 0.1 + cov 0.3 + sem 0.5 + content 3", habit: 0.1, recency: 0.05, popularity: 0, titleCoverage: 0.3, semanticWeight: 0.5, weights: [12, 6, 8, 6, 6, 6, 3] },
];

const rows = VARIANTS.map(evaluate);
console.log("\n| variant | title hit@1 / MRR | gist | detail | all |\n|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.join(" | ")} |`);
