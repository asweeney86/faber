import { describe, expect, test } from "bun:test";
import { frecencies, recordOpen } from "../src/frecency";
import { addTag, getDocRow, libraryRevision, recordVisit } from "../src/docs";
import { search } from "../src/search/hybrid";
import { gdocUrl, testEnv } from "./helpers";

const DAY = 86_400_000;

describe("frecency", () => {
  test("recent, frequent use outranks one old visit and heavy use long ago", async () => {
    const env = testEnv();
    const now = Date.now();
    const daily = await env.addDoc(gdocUrl(1), "Daily standup notes", "Standup notes.", { ts: now - 2 * DAY, enrich: false });
    for (let i = 0; i < 4; i++) recordVisit(env.db, { url: gdocUrl(1), ts: now - i * DAY - 1000 });
    const once = await env.addDoc(gdocUrl(2), "Old design doc", "Design doc.", { ts: now - 60 * DAY, enrich: false });
    const yearAgo = await env.addDoc(gdocUrl(3), "Last year's plan", "Plan.", { ts: now - 400 * DAY, enrich: false });
    for (let i = 0; i < 100; i++) recordVisit(env.db, { url: gdocUrl(3), ts: now - 400 * DAY + i * 1000 });

    const f = frecencies(env.db, [daily, once, yearAgo], now);
    expect(f.get(daily)!).toBeGreaterThan(f.get(once)!);
    expect(f.get(daily)!).toBeGreaterThan(f.get(yearAgo)!);
    expect(f.get(yearAgo)).toBe(50); // capped: 25 old visits × 2

    // Browsing with no query lists the most used first; "recent" keeps last-opened order.
    recordVisit(env.db, { url: gdocUrl(2), ts: now }); // opened just now, once
    const frequent = await search(env.searchDeps, { q: "" });
    expect(frequent.hits.map((h) => h.doc.id).slice(0, 2)).toEqual([daily, once]);
    const recent = await search(env.searchDeps, { q: "", sort: "recent" });
    expect(recent.hits[0]!.doc.id).toBe(once);
  });

  test("opening from Faber counts once, even when the browser then reports the same visit", async () => {
    const env = testEnv();
    const id = await env.addDoc(gdocUrl(5), "Roadmap", "Roadmap.", { ts: Date.now() - 10 * DAY, enrich: false });
    const t = Date.now();
    expect(recordOpen(env.db, id, t)).toBe(true);
    recordVisit(env.db, { url: gdocUrl(5), ts: t + 3_000 }); // the page load that open caused
    expect(getDocRow(env.db, id)!.visit_count).toBe(2); // the first visit + one open
    expect(getDocRow(env.db, id)!.last_seen_at).toBe(t + 3_000);
    recordVisit(env.db, { url: gdocUrl(5), ts: t + 10 * 60_000 }); // a later visit counts
    expect(getDocRow(env.db, id)!.visit_count).toBe(3);
    expect(recordOpen(env.db, "nope")).toBe(false);
  });

  test("an open from Faber weighs more than a browser visit", async () => {
    const env = testEnv();
    const t = Date.now();
    const a = await env.addDoc(gdocUrl(6), "A", "A.", { ts: t - 40 * DAY, enrich: false });
    const b = await env.addDoc(gdocUrl(7), "B", "B.", { ts: t - 40 * DAY, enrich: false });
    recordOpen(env.db, a, t - 1000);
    recordVisit(env.db, { url: gdocUrl(7), ts: t - 1000 });
    const f = frecencies(env.db, [a, b], t);
    expect(f.get(a)!).toBeGreaterThan(f.get(b)!);
  });

  test("among equally relevant matches, the one you use more ranks first", async () => {
    const env = testEnv();
    const t = Date.now();
    const rarely = await env.addDoc(gdocUrl(8), "Pricing review", "Pricing review for the gateway.", { ts: t - 5 * DAY });
    const often = await env.addDoc(gdocUrl(9), "Pricing review", "Pricing review for the gateway.", { ts: t - 5 * DAY });
    for (let i = 1; i <= 6; i++) recordOpen(env.db, often, t - i * 3_600_000);
    const r = await search(env.searchDeps, { q: "pricing review gateway" });
    const ids = r.hits.map((h) => h.doc.id);
    expect(ids.indexOf(often)).toBeLessThan(ids.indexOf(rarely));
    expect(r.hits.find((h) => h.doc.id === often)!.signals.frecency).toBeGreaterThan(0);
  });
});

describe("library revision", () => {
  test("moves when something the app shows changes, not otherwise", async () => {
    const env = testEnv();
    const r0 = libraryRevision(env.db);
    expect(libraryRevision(env.db)).toBe(r0);
    const id = await env.addDoc(gdocUrl(20), "New doc", "Some text.");
    const r1 = libraryRevision(env.db);
    expect(r1).not.toBe(r0);
    recordOpen(env.db, id);
    const r2 = libraryRevision(env.db);
    expect(r2).not.toBe(r1);
    addTag(env.db, id, "planning", "manual");
    expect(libraryRevision(env.db)).not.toBe(r2);
  });
});
