import { describe, expect, test } from "bun:test";
import { ask, AskError, buildAskPrompt } from "../src/ask";
import {
  CollectionError,
  createCollection,
  deleteCollection,
  exportCollection,
  getCollection,
  importCollection,
  listCollections,
  removeCollectionDoc,
  setCollectionDoc,
  updateCollection,
} from "../src/collections";
import { buildDigest } from "../src/digest";
import { addTag, getDoc, lookupByUrl, recordVisit, setNote, setPinned } from "../src/docs";
import { getFacets } from "../src/facets";
import { linkDocToMeeting } from "../src/meetings";
import type { Embedder } from "../src/providers/types";
import { relatedDocs } from "../src/related";
import { search } from "../src/search/hybrid";
import { gdocUrl, testEnv } from "./helpers";

const DAY = 86_400_000;

async function corpus() {
  const env = testEnv();
  const ids = {
    pricing: await env.addDoc(
      gdocUrl(1),
      "Rate limit design",
      "Author: Maya Chen\nProject Atlas token bucket rate limits at the gateway for usage based pricing tiers.",
    ),
    okrs: await env.addDoc(gdocUrl(2), "Growth OKRs", "Owner: Priya Natarajan\nKey results: activation rate and the Frankfurt launch. OKRs for Q3."),
    residency: await env.addDoc(
      gdocUrl(3),
      "EU residency notes",
      "Attendees: Lin Zhao, Priya Natarajan\nAgenda: Frankfurt launch blocked by EU data residency. Analytics export must stay in eu-central-1.",
    ),
    lunch: await env.addDoc(gdocUrl(4), "Team lunch menu", "Sandwiches, salads and cookies for the offsite lunch."),
  };
  return { env, ids };
}

describe("hybrid search", () => {
  test("finds documents by content, title and summary, best first", async () => {
    const { env, ids } = await corpus();
    const res = await search(env.searchDeps, { q: "gateway rate limits" });
    expect(res.hits[0]!.doc.id).toBe(ids.pricing);
    expect(res.semantic).toBe(true);
    expect(res.hits.map((h) => h.doc.id)).not.toContain(ids.lunch);
    expect(res.hits[0]!.snippet).toContain("[");
  });

  test("keyword and semantic modes work on their own", async () => {
    const { env, ids } = await corpus();
    const kw = await search(env.searchDeps, { q: "frankfurt", mode: "keyword" });
    expect(kw.hits.map((h) => h.doc.id).sort()).toEqual([ids.okrs, ids.residency].sort());
    expect(kw.hits.every((h) => h.signals.semantic === undefined)).toBe(true);
    const sem = await search(env.searchDeps, { q: "eu residency analytics export", mode: "semantic" });
    expect(sem.hits[0]!.doc.id).toBe(ids.residency);
  });

  test("filters: project and person are exact, tags, pinned and time ranges", async () => {
    const { env, ids } = await corpus();
    const byPerson = await search(env.searchDeps, { q: "", filters: { person: ["priya natarajan"] } });
    expect(byPerson.hits.map((h) => h.doc.id).sort()).toEqual([ids.okrs, ids.residency].sort());
    expect((await search(env.searchDeps, { q: "", filters: { person: ["Priya"] } })).hits).toEqual([]);
    const byProject = await search(env.searchDeps, { q: "rate", filters: { project: ["atlas"] } });
    expect(byProject.hits.map((h) => h.doc.id)).toEqual([ids.pricing]);
    addTag(env.db, ids.lunch, "offsite", "manual");
    expect((await search(env.searchDeps, { q: "", filters: { tag: ["Offsite"] } })).hits.map((h) => h.doc.id)).toEqual([ids.lunch]);
    setPinned(env.db, ids.okrs, true);
    expect((await search(env.searchDeps, { q: "", filters: { pinned: true } })).hits.map((h) => h.doc.id)).toEqual([ids.okrs]);
    expect((await search(env.searchDeps, { q: "", filters: { seen_after: Date.now() + DAY } })).hits).toEqual([]);
  });

  test("empty query browses newest first with pins on top", async () => {
    const { env, ids } = await corpus();
    setPinned(env.db, ids.pricing, true);
    const res = await search(env.searchDeps, { q: "", limit: 10 });
    expect(res.hits[0]!.doc.id).toBe(ids.pricing);
    expect(res.hits.length).toBe(4);
  });

  test("degrades to keyword-only when the embedder fails, and says so", async () => {
    const { env, ids } = await corpus();
    const down: Embedder = { provider: "x", model: "fake-embed", embed: () => Promise.reject(new Error("ECONNREFUSED")) };
    const res = await search({ ...env.searchDeps, embedder: down }, { q: "frankfurt" });
    expect(res.semantic).toBe(false);
    expect(res.hits.map((h) => h.doc.id)).toContain(ids.residency);
  });

  test("stopwords don't make every document match, so off-topic Ask questions find nothing", async () => {
    const { env } = await corpus();
    expect((await search(env.searchDeps, { q: "what is the capital of france", mode: "keyword" })).hits).toEqual([]);
    const res = await ask({ ...env.searchDeps, chat: env.chat }, { question: "What is the capital of France?" });
    expect(res.citations).toEqual([]);
  });

  test("a doc ranked first by both signals beats a fresher runner-up", async () => {
    const env = testEnv();
    const t = Date.now();
    const old = await env.addDoc(gdocUrl(301), "Gateway outage postmortem", "postmortem of the gateway outage in march: gateway outage root cause", { ts: t - 200 * DAY });
    await env.addDoc(gdocUrl(302), "Weekly status", "status: mentions the gateway outage once", { ts: t });
    const res = await search(env.searchDeps, { q: "gateway outage postmortem" });
    expect(res.hits[0]!.doc.id).toBe(old);
  });

  test("Ask passages come from document text, never the AI summary chunk", async () => {
    const { env } = await corpus();
    const res = await ask({ ...env.searchDeps, chat: env.chat }, { question: "Frankfurt launch blocked EU data residency" });
    for (const c of res.citations) {
      const summary = getDoc(env.db, c.doc_id)!.enrichment!.summary;
      expect(c.passage.startsWith(summary)).toBe(false);
    }
  });

  test("scoped facets only count the current results", async () => {
    const { env, ids } = await corpus();
    const all = getFacets(env.db);
    const scoped = getFacets(env.db, 30, [ids.pricing]);
    expect(all.source[0]!.count).toBe(4);
    expect(scoped.source).toEqual([{ value: "gdoc", count: 1 }]);
    expect(scoped.people.map((p) => p.value)).toEqual(["Maya Chen"]);
  });

  test("nonsense queries return nothing instead of the nearest neighbour", async () => {
    const { env } = await corpus();
    expect((await search(env.searchDeps, { q: "zzzz-no-such-thing" })).hits).toEqual([]);
    expect((await search(env.searchDeps, { q: "walrus" })).hits).toEqual([]);
  });

  test("punctuation-only and odd queries do not throw", async () => {
    const { env } = await corpus();
    for (const q of ['"', "(", "AND OR NOT", "*", "rate-limit's"]) {
      await expect(search(env.searchDeps, { q })).resolves.toBeDefined();
    }
  });
});

describe("collections", () => {
  test("pins, saved queries and exclusions combine", async () => {
    const { env, ids } = await corpus();
    const c = createCollection(env.db, { name: "  Frankfurt  ", query: { q: "frankfurt" } });
    expect(c.name).toBe("Frankfurt");
    setCollectionDoc(env.db, c.id, ids.lunch, "pin");
    let detail = (await getCollection(env.searchDeps, c.id))!;
    expect(detail.items[0]).toMatchObject({ state: "pin" });
    expect(detail.items[0]!.doc.id).toBe(ids.lunch);
    expect(detail.items.filter((i) => i.state === "query").map((i) => i.doc.id).sort()).toEqual([ids.okrs, ids.residency].sort());
    setCollectionDoc(env.db, c.id, ids.okrs, "exclude");
    detail = (await getCollection(env.searchDeps, c.id))!;
    expect(detail.items.map((i) => i.doc.id)).not.toContain(ids.okrs);
    expect(detail.excluded.map((d) => d.id)).toEqual([ids.okrs]);
    removeCollectionDoc(env.db, c.id, ids.okrs);
    expect((await getCollection(env.searchDeps, c.id))!.items.map((i) => i.doc.id)).toContain(ids.okrs);
    expect(listCollections(env.db)[0]).toMatchObject({ id: c.id, pin_count: 1 });
  });

  test("a doc can belong to many collections", async () => {
    const { env, ids } = await corpus();
    const a = createCollection(env.db, { name: "A" });
    const b = createCollection(env.db, { name: "B" });
    setCollectionDoc(env.db, a.id, ids.pricing, "pin");
    setCollectionDoc(env.db, b.id, ids.pricing, "pin");
    const { getDocDetail } = await import("../src/docs");
    expect(getDocDetail(env.db, ids.pricing)!.collections.map((c) => c.name)).toEqual(["A", "B"]);
  });

  test("collectionsForDoc includes smart-query matches and exclusions", async () => {
    const { env, ids } = await corpus();
    const { collectionsForDoc } = await import("../src/collections");
    const smart = createCollection(env.db, { name: "Smart", query: { q: "frankfurt" } });
    const pinned = createCollection(env.db, { name: "Pinned" });
    setCollectionDoc(env.db, pinned.id, ids.okrs, "pin");
    expect(await collectionsForDoc(env.searchDeps, ids.okrs)).toEqual([
      { id: pinned.id, name: "Pinned", state: "pin" },
      { id: smart.id, name: "Smart", state: "query" },
    ]);
    setCollectionDoc(env.db, smart.id, ids.okrs, "exclude");
    expect((await collectionsForDoc(env.searchDeps, ids.okrs)).find((c) => c.id === smart.id)!.state).toBe("exclude");
    expect(await collectionsForDoc(env.searchDeps, ids.lunch)).toEqual([]);
  });

  test("validation and not-found errors", async () => {
    const { env, ids } = await corpus();
    expect(() => createCollection(env.db, { name: " " })).toThrow(CollectionError);
    expect(() => updateCollection(env.db, "missing", { name: "x" })).toThrow(/not found/);
    const c = createCollection(env.db, { name: "C" });
    expect(() => setCollectionDoc(env.db, c.id, "missing", "pin")).toThrow(/document not found/);
    expect(() => setCollectionDoc(env.db, c.id, ids.okrs, "query" as never)).toThrow(/invalid state/);
    expect(updateCollection(env.db, c.id, { query: { q: "  " } }).query).toBeNull();
    expect(deleteCollection(env.db, c.id)).toBe(true);
    expect(await getCollection(env.searchDeps, c.id)).toBeNull();
  });

  test("export carries URLs and notes, never document text, and imports into another instance", async () => {
    const { env, ids } = await corpus();
    const c = createCollection(env.db, { name: "Atlas", description: "Billing" });
    setCollectionDoc(env.db, c.id, ids.pricing, "pin");
    setNote(env.db, ids.pricing, "The approved design");
    const file = (await exportCollection(env.searchDeps, c.id))!;
    expect(file).toMatchObject({ format: "faber/collection", version: 1, id: c.id, name: "Atlas" });
    expect(file.items[0]).toMatchObject({ url: gdocUrl(1), note: "The approved design" });
    // Only manual tags travel: auto tags come from the document text.
    expect(file.items[0]!.tags).toEqual([]);
    addTag(env.db, ids.pricing, "approved", "manual");
    expect((await exportCollection(env.searchDeps, c.id))!.items[0]!.tags).toEqual(["approved"]);
    expect(file.items[0]).not.toHaveProperty("doc_type");
    expect(JSON.stringify(file)).not.toContain("token bucket");
    expect(file.items[0]).not.toHaveProperty("summary");

    const other = testEnv();
    const r = await importCollection(other.searchDeps, file);
    expect(r).toEqual({ collection_id: c.id, created_docs: 1, items: 1 });
    const imported = (await getCollection(other.searchDeps, c.id))!;
    expect(imported.items[0]).toMatchObject({ state: "pin", shared_note: "The approved design" });
    expect(imported.items[0]!.doc.note).toBeNull();
    expect(imported.items[0]!.doc.has_content).toBe(false);
    expect(lookupByUrl(other.db, gdocUrl(1))!.visit_count).toBe(0);

    // Re-importing an updated file updates in place.
    const again = await importCollection(other.searchDeps, { ...file, name: "Atlas v2" });
    expect(again.created_docs).toBe(0);
    expect(listCollections(other.db).map((x) => x.name)).toEqual(["Atlas v2"]);
  });

  test("keyword hits map to the right document after many FTS rewrites", async () => {
    const env = testEnv();
    const a = await env.addDoc(gdocUrl(201), "Alpha", "the aardvark report", { enrich: false });
    // Rewrite a's FTS row many times so FTS rowids drift away from document rowids.
    for (let i = 0; i < 5; i++) setNote(env.db, a, `note ${i}`);
    const b = await env.addDoc(gdocUrl(202), "Bravo", "the bison report", { enrich: false });
    expect((await search(env.searchDeps, { q: "bison", mode: "keyword" })).hits.map((h) => h.doc.id)).toEqual([b]);
    expect((await search(env.searchDeps, { q: "aardvark", mode: "keyword" })).hits.map((h) => h.doc.id)).toEqual([a]);
  });

  test("filters apply before ranking, so a low-ranked match still comes back", async () => {
    const env = testEnv();
    for (let i = 0; i < 80; i++) await env.addDoc(gdocUrl(100 + i), `Pricing note ${i}`, `pricing pricing pricing ${i}`, { enrich: false });
    const target = await env.addDoc(gdocUrl(999), "Old pricing", "a passing mention of pricing", { enrich: false });
    addTag(env.db, target, "billing", "manual");
    const res = await search(env.searchDeps, { q: "pricing", filters: { tag: ["billing"] }, mode: "keyword" });
    expect(res.hits.map((h) => h.doc.id)).toEqual([target]);
    expect((await search(env.searchDeps, { q: "pricing", mode: "keyword", limit: 200 })).hits.length).toBe(81);
  });

  test("bad saved filters are rejected, and a bad stored row cannot break the digest", async () => {
    const { env } = await corpus();
    expect(() => createCollection(env.db, { name: "X", query: { filters: { source: "gdoc" as never } } })).toThrow(/array/);
    expect(() => createCollection(env.db, { name: "X", query: { q: 5 as never } })).toThrow(/string/);
    await expect(
      importCollection(env.searchDeps, {
        format: "faber/collection",
        version: 1,
        id: "bad-filter-collection",
        name: "Bad",
        description: null,
        query: { filters: { project: "Atlas" as never } },
        exported_at: "",
        items: [],
      }),
    ).rejects.toThrow(CollectionError);
    // Simulate a row written by an older version.
    const c = createCollection(env.db, { name: "Legacy" });
    env.db.run(`UPDATE collections SET query = ? WHERE id = ?`, [JSON.stringify({ filters: { source: "gdoc" } }), c.id]);
    await expect(buildDigest(env.searchDeps)).resolves.toBeDefined();
    expect((await getCollection(env.searchDeps, c.id))!.query).toBeNull();
  });

  test("re-importing your own export keeps query matches as matches and doesn't duplicate notes", async () => {
    const { env, ids } = await corpus();
    const c = createCollection(env.db, { name: "Smart", query: { q: "frankfurt" } });
    setCollectionDoc(env.db, c.id, ids.lunch, "pin");
    setNote(env.db, ids.lunch, "my own words");
    setCollectionDoc(env.db, c.id, ids.pricing, "exclude");
    const file = (await exportCollection(env.searchDeps, c.id))!;
    await importCollection(env.searchDeps, { ...file, items: [...file.items, { url: gdocUrl(1), title: "x", note: null, tags: [] }] });
    const detail = (await getCollection(env.searchDeps, c.id))!;
    expect(detail.items.filter((i) => i.state === "pin").map((i) => i.doc.id)).toEqual([ids.lunch]);
    expect(detail.items.find((i) => i.doc.id === ids.lunch)!.shared_note).toBeNull();
    expect(detail.excluded.map((d) => d.id)).toEqual([ids.pricing]);
  });

  test("import rejects malformed files and skips bad items", async () => {
    const env = testEnv();
    const base = { format: "faber/collection", version: 1, id: "c0ffee00-aaaa", name: "X", description: null, query: null, exported_at: "", items: [] } as const;
    await expect(importCollection(env.searchDeps, { ...base, format: "nope" } as never)).rejects.toThrow(/not a Faber/);
    await expect(importCollection(env.searchDeps, { ...base, version: 2 } as never)).rejects.toThrow(/unsupported/);
    await expect(importCollection(env.searchDeps, { ...base, id: "../../etc" })).rejects.toThrow(/id/);
    // Files exported before the rename from Power Bookmark still import.
    const legacy = await importCollection(env.searchDeps, { ...base, id: "c0ffee00-legacy", format: "power-bookmark/collection" } as never);
    expect(legacy.items).toBe(0);
    const r = await importCollection(env.searchDeps, {
      ...base,
      items: [
        { url: "javascript:alert(1)", title: "x", note: null, tags: [], doc_type: null },
        { url: "https://example.com/ok", title: "ok", note: " ", tags: ["a", 5 as never], doc_type: null },
      ],
    });
    expect(r.items).toBe(1);
  });
});

describe("facets, related, digest", () => {
  test("facets count tags, people, projects and types", async () => {
    const { env } = await corpus();
    const f = getFacets(env.db);
    expect(f.people.find((p) => p.value === "Priya Natarajan")?.count).toBe(2);
    expect(f.projects).toEqual([{ value: "atlas", label: "Atlas", count: 1 }]);
    expect(f.source).toEqual([{ value: "gdoc", count: 4 }]);
    expect(f.doc_type.reduce((s, x) => s + x.count, 0)).toBe(4);
  });

  test("related docs explain why they are related", async () => {
    const { env, ids } = await corpus();
    linkDocToMeeting(env.db, ids.okrs, { title: "Growth weekly" });
    linkDocToMeeting(env.db, ids.lunch, { title: "Growth weekly" });
    const rel = relatedDocs(env.db, env.index, ids.okrs);
    const residency = rel.find((r) => r.doc.id === ids.residency)!;
    expect(residency.reasons.join(" ")).toContain("Priya Natarajan");
    const lunch = rel.find((r) => r.doc.id === ids.lunch)!;
    expect(lunch.reasons).toContain("Same meeting: Growth weekly");
    expect(rel.map((r) => r.doc.id)).not.toContain(ids.okrs);
  });

  test("digest buckets by recency, frequency and resurfacing", async () => {
    const env = testEnv();
    const t = Date.now();
    const at = (d: number) => t - d * DAY;
    const recent = await env.addDoc(gdocUrl(30), "Recent", "recent work", { ts: at(1) });
    const old = await env.addDoc(gdocUrl(31), "Old favourite", "old favourite", { ts: at(40) });
    for (const d of [35, 30, 25]) recordVisit(env.db, { url: gdocUrl(31), ts: at(d) });
    for (const d of [2, 3]) recordVisit(env.db, { url: gdocUrl(30), ts: at(d) });
    recordVisit(env.db, { url: gdocUrl(32), ts: at(1) });
    setPinned(env.db, old, true);
    const c = createCollection(env.db, { name: "C" });
    setCollectionDoc(env.db, c.id, recent, "pin");

    const d = await buildDigest(env.searchDeps, { at: t });
    expect(d.pinned.map((x) => x.id)).toEqual([old]);
    expect(d.recent.map((x) => x.id)).toContain(recent);
    expect(d.recent.map((x) => x.id)).not.toContain(old);
    expect(d.frequent[0]!.id).toBe(recent);
    expect(d.resurfacing.map((x) => x.id)).toEqual([old]);
    expect(d.new_in_collections[0]!.docs.map((x) => x.id)).toEqual([recent]);
    expect(d.waiting_for_content).toEqual({ total: 1, by_source: { gdoc: 1 } });
  });
});

describe("ask", () => {
  test("answers from retrieved passages with numbered citations", async () => {
    const { env, ids } = await corpus();
    const res = await ask({ ...env.searchDeps, chat: env.chat }, { question: "What blocked the Frankfurt launch?" });
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0]!.n).toBe(1);
    expect(res.citations.map((c) => c.doc_id)).toContain(ids.residency);
    expect(res.answer).toContain("[1]");
    expect(res).toMatchObject({ provider: "fake", model: "fake-chat" });
  });

  test("each document is cited once even when several passages come from it", async () => {
    const { env } = await corpus();
    const res = await ask({ ...env.searchDeps, chat: env.chat }, { question: "Frankfurt launch EU residency analytics export", k: 12 });
    const ids = res.citations.map((c) => c.doc_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(res.citations.map((c) => c.n)).toEqual(ids.map((_, i) => i + 1));
  });

  test("says so when nothing matches, and validates input", async () => {
    const { env } = await corpus();
    const res = await ask({ ...env.searchDeps, chat: env.chat }, { question: "zzqx" });
    expect(res.citations).toEqual([]);
    expect(res.answer).toMatch(/couldn't find/);
    await expect(ask({ ...env.searchDeps, chat: env.chat }, { question: "  " })).rejects.toThrow(AskError);
  });

  test("prompt numbers sources and includes metadata", () => {
    const p = buildAskPrompt("Q?", [
      { doc_id: "a", title: "Doc A", url: "u", meta: "prd · written ~2026-01", text: "alpha" },
      { doc_id: "b", title: "Doc B", url: "u", meta: "", text: "beta" },
    ]);
    expect(p).toContain("[1] Doc A (prd · written ~2026-01)\nalpha");
    expect(p).toContain("[2] Doc B\nbeta");
  });

  test("filters restrict which docs Ask can see", async () => {
    const { env, ids } = await corpus();
    const res = await ask({ ...env.searchDeps, chat: env.chat }, { question: "Frankfurt launch", filters: { project: ["Atlas"] } });
    expect(res.citations.every((c) => c.doc_id === ids.pricing)).toBe(true);
    expect(getDoc(env.db, ids.pricing)).not.toBeNull();
  });
});
