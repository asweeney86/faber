#!/usr/bin/env bun
/**
 * Benchmark a Faber library: search latency (by mode, cold and warm), the other endpoints the
 * app calls, and recall: does the page you're thinking of come up first?
 *
 * Recall queries are built from the crawled corpus (scripts/bench/crawl.ts), three ways:
 *   title  a few words of the headline, as you'd remember it
 *   gist   how you'd describe it a week later, in other words (written by the local model)
 *   detail a specific fact from the body of the article
 * and scored by hit@1, hit@3, hit@10 and MRR, for hybrid, keyword-only and semantic-only search.
 *
 *   bun scripts/bench/run.ts [--daemon URL] [--sample 150] [--label after-1000]
 *
 * Results go to <out>/results-<label>.json; the queries are cached in <out>/queries.json so
 * runs are comparable over time.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CorpusDoc } from "./crawl";

const { values } = parseArgs({
  options: {
    daemon: { type: "string", default: "http://127.0.0.1:7777" },
    out: { type: "string", default: join(homedir(), ".faber", "bench") },
    sample: { type: "string", default: "150" },
    label: { type: "string", default: new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") },
    ollama: { type: "string", default: "http://127.0.0.1:11434" },
    "query-model": { type: "string", default: "qwen3:4b" },
  },
});
const DAEMON = values.daemon!.replace(/\/$/, "");
const OUT = values.out!;

type Mode = "hybrid" | "keyword" | "semantic";
interface Query {
  url: string;
  kind: "title" | "gist" | "detail";
  q: string;
}
interface Hit {
  doc: { id: string; canonical_url: string; title: string };
}

async function search(q: string, mode: Mode = "hybrid", limit = 10): Promise<{ hits: Hit[]; took_ms: number; wall_ms: number; semantic: boolean }> {
  const t = performance.now();
  const res = await fetch(`${DAEMON}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q, mode, limit }) });
  const body = (await res.json()) as { hits: Hit[]; took_ms: number; semantic: boolean };
  return { ...body, wall_ms: performance.now() - t };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]! * 10) / 10 : 0;
};
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 0.5), p90: pct(xs, 0.9), p99: pct(xs, 0.99), max: pct(xs, 1) });

// ---------- deterministic sample ----------
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const corpus: CorpusDoc[] = JSON.parse(readFileSync(join(OUT, "corpus.json"), "utf8"));

/** Canonical doc URL as the daemon stores it, via lookup (so we compare ids, not strings). */
const idOf = new Map<string, string>();
async function resolveIds(urls: string[]) {
  for (const u of urls) {
    if (idOf.has(u)) continue;
    const r = await fetch(`${DAEMON}/api/docs/lookup?url=${encodeURIComponent(u)}`);
    if (r.ok) idOf.set(u, ((await r.json()) as { id: string }).id);
  }
}

// ---------- query building ----------
const STOP = new Set(
  "a an the and or but of in on at to for with from by as is are was were be been it its this that these those how why what who when where after before over under into about than more most new says say said will would could can may might not no yes his her their our your my we you they he she i us them up out just".split(
    " ",
  ),
);
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];

function titleQuery(title: string): string {
  // The 3-4 most distinctive words of the headline, in order: how people half-remember titles.
  const ws = words(title).filter((w) => !STOP.has(w) && w.length > 2);
  const pick = ws.sort((a, b) => b.length - a.length).slice(0, 4);
  return words(title)
    .filter((w) => pick.includes(w))
    .slice(0, 4)
    .join(" ");
}

function detailQuery(text: string, title: string): string | null {
  // A sentence from the middle of the body, reduced to its capitalised names and numbers.
  const titleWords = new Set(words(title));
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 60 && s.length < 300);
  if (sentences.length < 4) return null;
  for (let tries = 0; tries < 6; tries++) {
    const s = sentences[Math.floor(sentences.length * (0.3 + rand() * 0.5))]!;
    const names = (s.match(/\b(?:[A-Z][\p{L}’'-]+|\d[\d,.%]*)\b/gu) ?? []).filter((w, i) => i > 0 || !/^[A-Z][a-z]+$/.test(w));
    const key = names.filter((w) => !titleWords.has(w.toLowerCase()) && !STOP.has(w.toLowerCase()));
    if (key.length >= 2) {
      const rest = words(s).filter((w) => !STOP.has(w) && w.length > 4 && !titleWords.has(w)).slice(0, 2);
      return [...new Set([...key.slice(0, 3), ...rest])].join(" ").slice(0, 80);
    }
  }
  return null;
}

async function gistQuery(doc: CorpusDoc): Promise<string | null> {
  const prompt = `You read this article about a week ago. Write the search query (3 to 8 words) you would type to find it again from memory. Describe what it was about in your own words; avoid copying the headline. Reply with the query only.

Headline: ${doc.title}
Article: ${doc.text.slice(0, 1500)}`;
  try {
    // JSON output: Qwen3 ignores think:false and would otherwise reply with its reasoning.
    const res = await fetch(`${values.ollama}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model: values["query-model"],
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        format: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        options: { temperature: 0.2, num_predict: 60 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const out = ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
    const q = (JSON.parse(out) as { query?: string }).query?.trim().replace(/^["'`]|["'`.]$/g, "");
    return q && q.length > 3 && q.split(/\s+/).length <= 12 ? q.slice(0, 100) : null;
  } catch {
    return null;
  }
}

async function buildQueries(n: number): Promise<Query[]> {
  const path = join(OUT, "queries.json");
  if (existsSync(path)) {
    const cached = (JSON.parse(readFileSync(path, "utf8")) as Query[]).filter((q) => q.kind !== "gist" || !/^(okay|hmm|alright)\b|the user/i.test(q.q));
    const urls = [...new Set(cached.map((q) => q.url))];
    if (urls.length >= n) {
      // Fill in gist queries that are missing (or were thrown away above).
      for (const url of urls) {
        if (cached.some((q) => q.url === url && q.kind === "gist")) continue;
        const d = corpus.find((c) => c.url === url);
        const g = d && (await gistQuery(d));
        if (g) cached.push({ url, kind: "gist", q: g });
      }
      writeFileSync(path, JSON.stringify(cached, null, 2));
      return cached;
    }
  }
  const pool = corpus.filter((d) => d.text_from === "page" && d.text.length > 1500);
  const picked: CorpusDoc[] = [];
  while (picked.length < Math.min(n, pool.length)) {
    const d = pool[Math.floor(rand() * pool.length)]!;
    if (!picked.includes(d)) picked.push(d);
  }
  const qs: Query[] = [];
  let i = 0;
  for (const d of picked) {
    const t = titleQuery(d.title);
    if (t.split(" ").length >= 2) qs.push({ url: d.url, kind: "title", q: t });
    const det = detailQuery(d.text, d.title);
    if (det) qs.push({ url: d.url, kind: "detail", q: det });
    const g = await gistQuery(d);
    if (g) qs.push({ url: d.url, kind: "gist", q: g });
    if (++i % 25 === 0) console.log(`  queries for ${i}/${picked.length} docs`);
  }
  writeFileSync(path, JSON.stringify(qs, null, 2));
  return qs;
}

// ---------- recall ----------
async function recall(qs: Query[]) {
  await resolveIds(qs.map((q) => q.url));
  const out: Record<string, Record<string, { n: number; hit1: number; hit3: number; hit10: number; mrr: number }>> = {};
  const misses: { kind: string; q: string; want: string; got: string[] }[] = [];
  for (const mode of ["hybrid", "keyword", "semantic"] as Mode[]) {
    out[mode] = {};
    for (const kind of ["title", "gist", "detail", "all"] as const) {
      const subset = qs.filter((q) => (kind === "all" || q.kind === kind) && idOf.has(q.url));
      let h1 = 0,
        h3 = 0,
        h10 = 0,
        rr = 0;
      for (const q of subset) {
        const r = await search(q.q, mode, 10);
        const rank = r.hits.findIndex((h) => h.doc.id === idOf.get(q.url)) + 1;
        if (rank === 1) h1++;
        if (rank && rank <= 3) h3++;
        if (rank) h10++;
        if (rank) rr += 1 / rank;
        if (mode === "hybrid" && kind !== "all" && rank !== 1 && misses.length < 60)
          misses.push({ kind: q.kind, q: q.q, want: corpus.find((d) => d.url === q.url)?.title ?? q.url, got: r.hits.slice(0, 3).map((h) => h.doc.title) });
      }
      const n = subset.length || 1;
      out[mode]![kind] = { n: subset.length, hit1: +(h1 / n).toFixed(3), hit3: +(h3 / n).toFixed(3), hit10: +(h10 / n).toFixed(3), mrr: +(rr / n).toFixed(3) };
    }
  }
  return { by_mode: out, hybrid_misses: misses };
}

// ---------- latency ----------
async function latency(qs: Query[]) {
  const res: Record<string, unknown> = {};
  const unique = qs.map((q) => q.q);
  for (const mode of ["hybrid", "keyword", "semantic"] as Mode[]) {
    const wall: number[] = [];
    const server: number[] = [];
    // Cold: each query seen for the first time this run (the query-embedding cache is per text).
    for (const q of unique.slice(0, 80)) {
      const r = await search(`${q} ${mode}`, mode, 20);
      wall.push(r.wall_ms);
      server.push(r.took_ms);
    }
    res[`search_${mode}_cold`] = { wall: stats(wall), server: stats(server) };
  }
  const warm: number[] = [];
  for (const q of unique.slice(0, 80)) warm.push((await search(`${q} hybrid`, "hybrid", 20)).wall_ms);
  res.search_hybrid_warm = { wall: stats(warm) };

  // Typing: every prefix of a query, as the search box (debounced) would send them.
  const typing: number[] = [];
  for (const q of unique.slice(0, 15)) for (let i = 3; i <= q.length; i += 3) typing.push((await search(q.slice(0, i), "hybrid", 50)).wall_ms);
  res.search_while_typing = { wall: stats(typing) };

  const time = async (name: string, f: () => Promise<Response>, n = 10) => {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await (await f()).arrayBuffer();
      xs.push(performance.now() - t);
    }
    res[name] = stats(xs);
  };
  const post = (path: string, body: unknown) => fetch(`${DAEMON}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await time("browse_frequent", () => post("/api/search", { q: "", limit: 50 }));
  await time("browse_recent", () => post("/api/search", { q: "", limit: 50, sort: "recent" }));
  await time("facets_all", () => fetch(`${DAEMON}/api/facets`));
  await time("facets_query", () => post("/api/facets", { q: "climate change" }));
  await time("status", () => fetch(`${DAEMON}/api/status`));
  await time("projects", () => fetch(`${DAEMON}/api/projects`));
  await time("overview", () => fetch(`${DAEMON}/api/overview`));
  await time("digest", () => fetch(`${DAEMON}/api/digest`), 3);
  await time("people", () => fetch(`${DAEMON}/api/people`));
  return res;
}

// ---------- main ----------
const status = (await (await fetch(`${DAEMON}/api/status`)).json()) as Record<string, unknown>;
console.log(`library: ${status.docs} docs, ${status.enriched} enriched; building queries…`);
const qs = await buildQueries(Number(values.sample));
console.log(`${qs.length} queries (${["title", "gist", "detail"].map((k) => `${qs.filter((q) => q.kind === k).length} ${k}`).join(", ")})`);
const lat = await latency(qs);
console.log("latency done");
const rec = await recall(qs);
const result = { label: values.label, at: new Date().toISOString(), status, latency: lat, recall: rec };
writeFileSync(join(OUT, `results-${values.label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ latency: lat, recall: rec.by_mode }, null, 2));
