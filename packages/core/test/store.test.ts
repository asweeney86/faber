import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION } from "../src/db";
import {
  addTag,
  deleteDoc,
  ensureDoc,
  getDoc,
  getDocDetail,
  lookupByUrl,
  needsContent,
  pendingContent,
  recordVisit,
  setContent,
  setContentError,
  setNote,
  stats,
  waitingForContent,
} from "../src/docs";
import { claimJobs, enqueueEnrichment, failJob, recoverStaleJobs } from "../src/enrich/queue";
import { runQueue } from "../src/enrich/run";
import { importChromeHistory, listChromeProfiles, readGoogleDocVisits, resolveProfile } from "../src/import/chrome";
import { linkDocToMeeting, getMeeting, listMeetings } from "../src/meetings";
import { getPerson, listPeople, prunePeople } from "../src/people";
import { getSettings, saveSettings, SettingsValidationError } from "../src/settings";
import type { Enricher } from "../src/providers/types";
import { gdocUrl, testEnv } from "./helpers";

describe("documents and visits", () => {
  test("URL variants collapse to one document and duplicate visits are ignored", () => {
    const { db } = testEnv();
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
    const a = recordVisit(db, { url: `https://docs.google.com/document/d/${id}/edit#h`, title: "Plan - Google Docs", ts: 1000 });
    const b = recordVisit(db, { url: `https://docs.google.com/document/u/1/d/${id}/view`, ts: 2000 });
    recordVisit(db, { url: `https://docs.google.com/document/d/${id}/edit`, ts: 2000 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.row.id).toBe(a.row.id);
    const doc = getDoc(db, a.row.id)!;
    expect(doc).toMatchObject({ title: "Plan", visit_count: 2, first_seen_at: 1000, last_seen_at: 2000, source: "gdoc" });
    expect(lookupByUrl(db, `https://docs.google.com/document/d/${id}/preview`)?.id).toBe(a.row.id);
    expect(lookupByUrl(db, "not a url")).toBeNull();
  });

  test("an older visit does not overwrite a newer title; plain URLs drop fragments", () => {
    const { db } = testEnv();
    recordVisit(db, { url: gdocUrl(1), title: "New title", ts: 5000 });
    recordVisit(db, { url: gdocUrl(1), title: "Old title", ts: 1000 });
    expect(lookupByUrl(db, gdocUrl(1))!.title).toBe("New title");
    const web = recordVisit(db, { url: "https://wiki.example.com/page#section", title: "Wiki" });
    expect(web.row).toMatchObject({ source: "url", canonical_url: "https://wiki.example.com/page" });
  });

  test("Workspace-domain URLs (/a/example.com/) collapse into the same doc", () => {
    const { db } = testEnv();
    const id = "1WorkspaceDomainAbcdefghijklmnop";
    const a = recordVisit(db, { url: `https://docs.google.com/a/example.com/document/d/${id}/edit` }).row;
    const b = recordVisit(db, { url: `https://docs.google.com/document/d/${id}/edit`, ts: Date.now() + 1 }).row;
    expect(a.id).toBe(b.id);
    expect(a.source).toBe("gdoc");
  });

  test("ensureDoc creates without a visit", () => {
    const { db } = testEnv();
    const { row, created } = ensureDoc(db, gdocUrl(2), { title: "Shared" });
    expect(created).toBe(true);
    expect(row.visit_count).toBe(0);
    expect(ensureDoc(db, gdocUrl(2)).created).toBe(false);
  });

  test("content changes queue enrichment; identical content does not", () => {
    const { db } = testEnv();
    const { row } = recordVisit(db, { url: gdocUrl(3) });
    expect(setContent(db, row.id, "hello world").changed).toBe(true);
    expect(stats(db).queue.pending).toBe(1);
    db.run(`UPDATE enrich_queue SET status = 'done'`);
    expect(setContent(db, row.id, "hello world").changed).toBe(false);
    expect(stats(db).queue.pending).toBe(0);
    expect(setContent(db, row.id, "hello again").changed).toBe(true);
    expect(stats(db).queue.pending).toBe(1);
  });

  test("needsContent: missing, stale, failing and plain-web cases", () => {
    const { db } = testEnv();
    const { row } = recordVisit(db, { url: gdocUrl(4) });
    expect(needsContent(row)).toBe(true);
    setContent(db, row.id, "text");
    const fresh = lookupByUrl(db, gdocUrl(4))!;
    expect(needsContent(fresh)).toBe(false);
    expect(needsContent(fresh, fresh.content_fetched_at! + 25 * 3600 * 1000)).toBe(true);
    const web = recordVisit(db, { url: "https://example.com/a" }).row;
    expect(needsContent(web)).toBe(false);
    const failing = recordVisit(db, { url: gdocUrl(5) }).row;
    for (let i = 0; i < 4; i++) setContentError(db, failing.id, "403");
    expect(needsContent(lookupByUrl(db, gdocUrl(5))!)).toBe(false);
  });

  test("pendingContent filters by source, orders by value, and backs off failures", () => {
    const { db } = testEnv();
    const low = recordVisit(db, { url: gdocUrl(6), ts: 1000 }).row;
    const high = recordVisit(db, { url: gdocUrl(7), ts: 2000 }).row;
    recordVisit(db, { url: gdocUrl(7), ts: 3000 });
    const slides = recordVisit(db, { url: "https://docs.google.com/presentation/d/1SlidesAbcdefghijklmnopqrstu/edit" }).row;
    recordVisit(db, { url: "https://example.com/page" });
    expect(pendingContent(db).map((p) => p.doc_id)).toEqual([high.id, slides.id, low.id]);
    expect(pendingContent(db, { sources: ["gslides"] }).map((p) => p.doc_id)).toEqual([slides.id]);
    expect(pendingContent(db, { sources: [] })).toEqual([]);
    setContentError(db, high.id, "no access");
    expect(pendingContent(db).map((p) => p.doc_id)).not.toContain(high.id);
    expect(waitingForContent(db)).toEqual({ total: 3, by_source: { gdoc: 2, gslides: 1 } });
    expect(pendingContent(db, { sources: ["gslides"] })[0]!.export_url).toBe(
      "https://docs.google.com/presentation/d/1SlidesAbcdefghijklmnopqrstu/export/txt",
    );
  });

  test("backfill exports as the Google account the doc was last opened with", () => {
    const { db } = testEnv();
    const id = "1MultiAccountAbcdefghijklmnopq";
    recordVisit(db, { url: `https://docs.google.com/document/u/2/d/${id}/edit`, ts: 2000 });
    recordVisit(db, { url: `https://docs.google.com/document/d/${id}/edit`, ts: 1000 });
    expect(pendingContent(db)[0]!.export_url).toBe(`https://docs.google.com/document/d/${id}/export?format=txt&authuser=2`);
  });

  test("removeTag normalises like addTag", () => {
    const { db } = testEnv();
    const { row } = recordVisit(db, { url: gdocUrl(9) });
    addTag(db, row.id, "Rate Limits", "manual");
    const { removeTag } = require("../src/docs");
    removeTag(db, row.id, "Rate Limits");
    expect(getDoc(db, row.id)!.tags).toEqual([]);
  });

  test("full-text rows are replaced, not duplicated, and removed with the doc", async () => {
    const env = testEnv();
    const id = await env.addDoc(gdocUrl(15), "FTS", "unique zebra words");
    setNote(env.db, id, "note one");
    setNote(env.db, id, "note two");
    expect(env.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM docs_fts").get()!.n).toBe(1);
    deleteDoc(env.db, id);
    expect(env.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM docs_fts").get()!.n).toBe(0);
  });

  test("deleteDoc removes the doc and derived rows", async () => {
    const env = testEnv();
    const id = await env.addDoc(gdocUrl(8), "Gone", "Author: Maya Chen\nAbout pricing and pricing limits.");
    expect(listPeople(env.db).length).toBeGreaterThan(0);
    expect(deleteDoc(env.db, id)).toBe(true);
    expect(getDoc(env.db, id)).toBeNull();
    expect(env.db.query("SELECT COUNT(*) n FROM visits").get()).toEqual({ n: 0 });
    expect(env.db.query("SELECT COUNT(*) n FROM docs_fts").get()).toEqual({ n: 0 });
    prunePeople(env.db);
    expect(listPeople(env.db)).toEqual([]);
    expect(deleteDoc(env.db, id)).toBe(false);
  });
});

describe("enrichment queue", () => {
  test("enriches, writes tags, people and chunks, and records provenance", async () => {
    const env = testEnv();
    const id = await env.addDoc(gdocUrl(10), "Rate limits", "Author: Maya Chen\nProject Atlas rate limits for the gateway. Rate limits matter.");
    const doc = getDocDetail(env.db, id)!;
    expect(doc.enrichment).toMatchObject({ provider: "fake", model: "fake-enrich", prompt_version: 1 });
    expect(doc.enrichment!.projects).toEqual(["Atlas"]);
    expect(doc.people.map((p) => p.name)).toContain("Maya Chen");
    expect(doc.tags.every((t) => t.source === "auto")).toBe(true);
    expect(doc.queue_status).toBe("done");
    expect(env.index.vectorsFor(id).length).toBeGreaterThan(0);
  });

  test("re-enrichment replaces auto tags but keeps manual ones", async () => {
    const env = testEnv();
    const id = await env.addDoc(gdocUrl(11), "Doc", "alpha alpha alpha bravo bravo");
    addTag(env.db, id, "keep-me", "manual");
    setContent(env.db, id, "charlie charlie charlie delta delta");
    await runQueue(env);
    const tags = getDoc(env.db, id)!.tags.map((t) => t.tag);
    expect(tags).toContain("keep-me");
    expect(tags).toContain("charlie");
    expect(tags).not.toContain("alpha");
  });

  test("failures back off between retries, then park the job as an error until re-queued", async () => {
    const env = testEnv();
    const broken: Enricher = { provider: "x", model: "y", enrich: async () => Promise.reject(new Error("model exploded")) };
    const { row } = recordVisit(env.db, { url: gdocUrl(12) });
    setContent(env.db, row.id, "text");
    // One failure per pass: the retry is not due yet.
    expect(await runQueue({ ...env, enricher: broken })).toEqual({ processed: 0, failed: 1 });
    expect(getDoc(env.db, row.id)!.queue_status).toBe("pending");
    const dueAt = () => env.db.query<{ t: number }, []>("SELECT next_attempt_at t FROM enrich_queue").get()!.t;
    expect(dueAt()).toBeGreaterThan(Date.now() + 50_000);
    for (let i = 0; i < 2; i++) {
      env.db.run("UPDATE enrich_queue SET next_attempt_at = 0");
      await runQueue({ ...env, enricher: broken });
    }
    expect(getDoc(env.db, row.id)!.queue_status).toBe("error");
    const q = env.db.query<{ last_error: string; attempts: number }, []>("SELECT last_error, attempts FROM enrich_queue").get()!;
    expect(q).toEqual({ last_error: "model exploded", attempts: 3 });
    // An explicit re-enrich starts over.
    enqueueEnrichment(env.db, row.id, 1e6);
    expect((await runQueue(env)).processed).toBe(1);
  });

  test("a provider outage pauses the pass without burning attempts", async () => {
    const env = testEnv();
    const down: Enricher = {
      provider: "ollama",
      model: "qwen3:8b",
      enrich: () => Promise.reject(Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" })),
    };
    for (const n of [40, 41, 42]) setContent(env.db, recordVisit(env.db, { url: gdocUrl(n) }).row.id, `doc ${n}`);
    const r = await runQueue({ ...env, enricher: down });
    expect(r.processed + r.failed).toBe(0);
    expect(r.unavailable).toContain("Unable to connect");
    const rows = env.db.query<{ attempts: number; status: string }, []>("SELECT attempts, status FROM enrich_queue").all();
    expect(rows.every((x) => x.attempts === 0 && x.status === "pending")).toBe(true);
  });

  test("content that changes while a job runs is enriched again", async () => {
    const env = testEnv();
    const { row } = recordVisit(env.db, { url: gdocUrl(43) });
    setContent(env.db, row.id, "version one about alpha");
    const slow: Enricher = {
      provider: "fake",
      model: "slow",
      enrich: async (input) => {
        if (input.text.includes("version one")) setContent(env.db, row.id, "version two about bravo");
        return env.enricher.enrich(input);
      },
    };
    await runQueue({ ...env, enricher: slow });
    // The first pass enriched v1, saw v2 arrive, and left the job pending; the same pass then picks up v2.
    expect(getDoc(env.db, row.id)!.enrichment!.tags).toContain("bravo");
    expect(getDoc(env.db, row.id)!.queue_status).toBe("done");
  });

  test("an embedding failure does not repeat the LLM call on retry", async () => {
    const env = testEnv();
    let llmCalls = 0;
    const counting: Enricher = { provider: "fake", model: "fake-enrich", enrich: (i) => (llmCalls++, env.enricher.enrich(i)) };
    let fail = true;
    const flaky = { ...env.embedder, provider: "fake", model: "fake-embed", embed: (t: string[]) => (fail ? Promise.reject(new Error("bad vector")) : env.embedder.embed(t)) };
    const { row } = recordVisit(env.db, { url: gdocUrl(44) });
    setContent(env.db, row.id, "some text");
    await runQueue({ ...env, enricher: counting, embedder: flaky });
    fail = false;
    env.db.run("UPDATE enrich_queue SET next_attempt_at = 0");
    await runQueue({ ...env, enricher: counting, embedder: flaky });
    expect(llmCalls).toBe(1);
    expect(env.index.vectorsFor(row.id).length).toBeGreaterThan(0);
  });

  test("re-enrich with force bypasses the same-content shortcut", async () => {
    const env = testEnv();
    let calls = 0;
    const counting: Enricher = { provider: "fake", model: "fake-enrich", enrich: (i) => (calls++, env.enricher.enrich(i)) };
    const { row } = recordVisit(env.db, { url: gdocUrl(45) });
    setContent(env.db, row.id, "text text text");
    await runQueue({ ...env, enricher: counting });
    enqueueEnrichment(env.db, row.id);
    await runQueue({ ...env, enricher: counting });
    expect(calls).toBe(1);
    enqueueEnrichment(env.db, row.id, 1e6, { force: true });
    await runQueue({ ...env, enricher: counting });
    expect(calls).toBe(2);
  });

  test("jobs without content are not claimed; stale running jobs recover", () => {
    const { db } = testEnv();
    const a = recordVisit(db, { url: gdocUrl(13) }).row;
    enqueueEnrichment(db, a.id);
    expect(claimJobs(db, 5)).toEqual([]);
    setContent(db, a.id, "x");
    expect(claimJobs(db, 5).length).toBe(1);
    expect(claimJobs(db, 5)).toEqual([]);
    recoverStaleJobs(db);
    expect(claimJobs(db, 5)).toEqual([]); // still inside its lease
    recoverStaleJobs(db, -1);
    expect(claimJobs(db, 5).length).toBe(1);
    failJob(db, a.id, "boom");
    expect(getDoc(db, a.id)!.queue_status).toBe("pending");
    expect(claimJobs(db, 5)).toEqual([]); // backing off
    expect(claimJobs(db, 5, Date.now() + 61_000).length).toBe(1);
  });
});

describe("notes", () => {
  test("notes are searchable through FTS", async () => {
    const env = testEnv();
    const id = await env.addDoc(gdocUrl(14), "Doc", "nothing special");
    setNote(env.db, id, "the canonical pricing decision");
    const n = env.db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM docs_fts WHERE docs_fts MATCH '"canonical"'`).get()!.n;
    expect(n).toBe(1);
  });
});

describe("people and meetings", () => {
  test("people list, detail and co-occurrence", async () => {
    const env = testEnv();
    await env.addDoc(gdocUrl(20), "One", "Reviewers: Maya Chen, Tom Okafor");
    await env.addDoc(gdocUrl(21), "Two", "Reviewers: Maya Chen, Lin Zhao");
    const people = listPeople(env.db);
    expect(people[0]).toMatchObject({ name: "Maya Chen", doc_count: 2 });
    const maya = getPerson(env.db, people[0]!.id)!;
    expect(maya.docs.map((d) => d.title).sort()).toEqual(["One", "Two"]);
    expect(maya.related_people.map((p) => p.name).sort()).toEqual(["Lin Zhao", "Tom Okafor"]);
    expect(getPerson(env.db, "nope")).toBeNull();
  });

  test("meetings group recurring occurrences", () => {
    const { db } = testEnv();
    const a = recordVisit(db, { url: gdocUrl(22) }).row;
    const b = recordVisit(db, { url: gdocUrl(23) }).row;
    const m1 = linkDocToMeeting(db, a.id, { title: "Billing sync 4/10" }, 1000);
    const m2 = linkDocToMeeting(db, b.id, { title: "Billing sync 4/17", url: "https://calendar.google.com/x" }, 2000);
    linkDocToMeeting(db, b.id, { title: "Billing sync 4/17" }, 2000);
    expect(m1).toBe(m2);
    expect(linkDocToMeeting(db, a.id, { title: "   " })).toBeNull();
    expect(listMeetings(db)).toEqual([
      { id: m1!, title: "Billing sync 4/17", url: "https://calendar.google.com/x", last_seen_at: 2000, doc_count: 2 },
    ]);
    expect(getMeeting(db, m1!)!.docs.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(getDocDetail(db, a.id)!.meetings[0]!.title).toBe("Billing sync 4/17");
  });
});

describe("settings", () => {
  test("defaults to all built-ins disabled and round-trips toggles and custom rules", () => {
    const { db } = testEnv();
    expect(getSettings(db).watchlist.every((r) => !r.enabled && r.builtin)).toBe(true);
    const s = getSettings(db);
    s.watchlist[0]!.enabled = true;
    s.watchlist.push({ id: "wiki", label: "Wiki", pattern: "wiki.example.com", extractor: "generic", enabled: true, builtin: false });
    const saved = saveSettings(db, s);
    expect(saved.watchlist.find((r) => r.id === "gdocs")!.enabled).toBe(true);
    expect(getSettings(db).watchlist.find((r) => r.id === "wiki")).toMatchObject({ pattern: "wiki.example.com", builtin: false });
  });

  test("refuses whole-TLD rules and duplicate patterns, and normalises patterns", () => {
    const { db } = testEnv();
    let n = 0;
    const add = (...patterns: string[]) => {
      const s = getSettings(db);
      patterns.forEach((pattern) => s.watchlist.push({ id: `r${n++}`, label: pattern, pattern, extractor: "generic", enabled: true, builtin: false }));
      return saveSettings(db, s);
    };
    expect(() => add("*.com")).toThrow(/top-level/);
    expect(() => add("com")).toThrow(/top-level/);
    expect(() => add("WIKI.example.com", "http://wiki.example.com/")).toThrow(/duplicates/);
    expect(add("HTTPS://Wiki.Example.com/").watchlist.at(-1)!.pattern).toBe("wiki.example.com");
    expect(add("localhost").watchlist.at(-1)!.pattern).toBe("localhost");
  });

  test("rejects invalid input", () => {
    const { db } = testEnv();
    expect(() => saveSettings(db, {} as never)).toThrow(SettingsValidationError);
    const bad = getSettings(db);
    bad.watchlist.push({ id: "x", label: "x", pattern: "not a host", extractor: "generic", enabled: true, builtin: false });
    expect(() => saveSettings(db, bad)).toThrow(/invalid pattern/);
    const dup = getSettings(db);
    dup.watchlist.push({ ...dup.watchlist[0]! });
    expect(() => saveSettings(db, dup)).toThrow(/duplicate/);
  });
});

describe("schema migration", () => {
  test("upgrades a v1 database in place", () => {
    const path = join(mkdtempSync(join(tmpdir(), "faber-mig-")), "db.sqlite");
    const old = new Database(path);
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE collection_docs (collection_id TEXT NOT NULL, doc_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (collection_id, doc_id));`);
    old.close();
    const db = openDatabase(path);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(collection_docs)").all().map((c) => c.name);
    expect(cols).toContain("shared_note");
    const qcols = db.query<{ name: string }, []>("PRAGMA table_info(enrich_queue)").all().map((c) => c.name);
    expect(qcols).toEqual(expect.arrayContaining(["next_attempt_at", "claimed_hash"]));
    expect(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value).toBe(String(SCHEMA_VERSION));
  });
});

describe("Chrome history import", () => {
  function fakeHistory(): string {
    const dir = mkdtempSync(join(tmpdir(), "faber-chrome-"));
    const path = join(dir, "History");
    const h = new Database(path);
    h.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
      CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);`);
    const toChrome = (ms: number) => (ms + 11_644_473_600_000) * 1000;
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
    h.run(`INSERT INTO urls VALUES (1, ?, 'Plan - Google Docs')`, [`https://docs.google.com/document/d/${id}/edit`]);
    h.run(`INSERT INTO urls VALUES (2, ?, 'Plan - Google Docs')`, [`https://docs.google.com/document/u/0/d/${id}/edit#x`]);
    h.run(`INSERT INTO urls VALUES (3, 'https://docs.google.com/forms/d/x/edit', 'Form')`);
    h.run(`INSERT INTO urls VALUES (4, 'https://news.example.com/', 'News')`);
    h.run(`INSERT INTO visits (url, visit_time) VALUES (1, ?), (1, ?), (2, ?), (3, ?), (4, ?)`, [
      toChrome(Date.UTC(2026, 0, 1)),
      toChrome(Date.UTC(2026, 0, 2)),
      toChrome(Date.UTC(2026, 0, 3)),
      toChrome(Date.UTC(2026, 0, 4)),
      toChrome(Date.UTC(2026, 0, 5)),
    ]);
    h.close();
    Bun.write(join(dir, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Work", user_name: "me@corp.com" } } } }));
    return dir;
  }

  test("reads only Google doc visits with correct timestamps, leaving no copy behind", async () => {
    const { readdirSync } = await import("node:fs");
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("faber-history-")).length;
    const visits = readGoogleDocVisits(join(fakeHistory(), "History"));
    expect(visits.length).toBe(3);
    expect(visits[0]!.ts).toBe(Date.UTC(2026, 0, 1));
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith("faber-history-")).length).toBe(before);
  });

  test("imports idempotently and queues enrichment", () => {
    const { db } = testEnv();
    const dir = fakeHistory();
    const r = importChromeHistory(db, join(dir, "History"));
    expect(r).toEqual({ visits: 3, docs_created: 1, docs_total: 1 });
    const again = importChromeHistory(db, join(dir, "History"));
    expect(again.docs_created).toBe(0);
    const doc = lookupByUrl(db, "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit")!;
    expect(doc).toMatchObject({ title: "Plan", visit_count: 3 });
    expect(importChromeHistory(db, join(dir, "History"), { dryRun: true }).docs_total).toBe(1);
  });

  test("profiles are listed from Local State and resolved by name", async () => {
    const dir = fakeHistory();
    // listChromeProfiles expects <dir>/<profile>/History
    const { mkdirSync, renameSync } = await import("node:fs");
    mkdirSync(join(dir, "Default"));
    renameSync(join(dir, "History"), join(dir, "Default", "History"));
    const profiles = listChromeProfiles(dir);
    expect(profiles.map((p) => [p.dir, p.name, p.account])).toEqual([["Default", "Work", "me@corp.com"]]);
    expect(resolveProfile("work", profiles).dir).toBe("Default");
    expect(() => resolveProfile("nope", profiles)).toThrow(/Available: Default \(Work\)/);
    const twins = [...profiles, { ...profiles[0]!, dir: "Profile 7" }];
    expect(() => resolveProfile("Work", twins)).toThrow(/several Chrome profiles.*--profile "Default".*--profile "Profile 7"/);
    expect(resolveProfile("Profile 7", twins).dir).toBe("Profile 7");
  });
});

describe("placeholder titles", () => {
  test("error, sign-in and loading pages never replace a document's real title", () => {
    const db = openDatabase(":memory:");
    const url = gdocUrl(77);
    const t0 = Date.now() - 10_000;
    recordVisit(db, { url, title: "Usage-Based Pricing: Rate Limit Design - Google Docs", ts: t0 });
    for (const [i, junk] of ["Page Not Found", "Sign in - Google Accounts", "Google Docs", "Loading…", "Access denied", "Error 404 (Not Found)!!1"].entries()) {
      recordVisit(db, { url, title: junk, ts: t0 + 1000 * (i + 1) });
    }
    expect(lookupByUrl(db, url)!.title).toBe("Usage-Based Pricing: Rate Limit Design");
    // A real rename still wins.
    recordVisit(db, { url, title: "Rate Limits v2 - Google Docs", ts: t0 + 9000 });
    expect(lookupByUrl(db, url)!.title).toBe("Rate Limits v2");
  });
});

test("tags are normalised: punctuation dropped, # prefix stripped, c++/c# kept", async () => {
  const { normaliseTag } = await import("../src/docs");
  expect(normaliseTag("Bad tag!!")).toBe("bad-tag");
  expect(normaliseTag("#Pricing")).toBe("pricing");
  expect(normaliseTag("C++")).toBe("c++");
  expect(normaliseTag("c#")).toBe("c#");
  expect(normaliseTag("  multi   word  ")).toBe("multi-word");
  expect(normaliseTag("!!!")).toBe("");
});
