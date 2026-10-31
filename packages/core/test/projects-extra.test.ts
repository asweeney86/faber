import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { deleteDoc, recordVisit } from "../src/docs";
import { getOverview, getProject, listProjects, projectId, projectKey, projectSpellings } from "../src/projects";
import { search } from "../src/search/hybrid";
import { gdocUrl, testEnv } from "./helpers";

/**
 * Edge cases for project inference. Enrichments are written straight to the table so
 * the test controls exactly which project names a document carries (the fake enricher
 * only knows "Project Xyz").
 */

const DAY = 86_400_000;
let n = 0;

function addDoc(db: Database, opts: { projects: unknown[]; ts?: number; title?: string; docType?: string; tags?: string[]; enrichedAt?: number }): string {
  const { row } = recordVisit(db, { url: gdocUrl(`x${++n}`), title: opts.title ?? `Doc ${n}`, ts: opts.ts });
  enrich(db, row.id, opts.projects, { docType: opts.docType, tags: opts.tags, at: opts.enrichedAt ?? opts.ts });
  return row.id;
}

function enrich(db: Database, docId: string, projects: unknown[], opts: { docType?: string; tags?: string[]; at?: number } = {}) {
  db.run(`UPDATE enrichments SET is_current = 0 WHERE doc_id = ?`, [docId]);
  db.run(
    `INSERT INTO enrichments (doc_id, provider, model, prompt_version, content_hash, summary, doc_type, written_at,
       projects, people, teams, tags, confidence, raw, is_current, created_at)
     VALUES (?, 'test', 'test', 1, NULL, 'summary', ?, NULL, ?, '[]', '[]', ?, 0.9, NULL, 1, ?)`,
    [docId, opts.docType ?? "design_doc", JSON.stringify(projects), JSON.stringify(opts.tags ?? []), opts.at ?? Date.now()],
  );
}

describe("projectId / projectKey", () => {
  test("case, inner and outer whitespace, tabs and newlines collapse to one id", () => {
    for (const s of ["Pricing Platform", "PRICING PLATFORM", " pricing\tplatform ", "pricing\n\nPlatform", "Pricing-Platform", "pricing_platform"]) {
      expect(projectId(s)).toBe("pricing-platform");
    }
    expect(projectKey("  A\t B  ")).toBe("a b");
  });

  test("ids are URL-path safe: no slashes, dots, query or hash characters", () => {
    for (const s of ["Billing/v2", "a/../b", "q?x=1", "#hash", "%2F", "C:\\path", "dots.in.name"]) {
      const id = projectId(s);
      expect(id).not.toMatch(/[/?#%\\.]/);
      expect(id.length).toBeGreaterThan(0);
    }
    expect(projectId("Billing/v2")).toBe("billing-v2");
  });

  test("unicode letters and digits are kept; composed and decomposed forms agree", () => {
    expect(projectId("Zürich")).toBe("zürich");
    expect(projectId("Zu\u0308rich")).toBe(projectId("Z\u00fcrich"));
    expect(projectId("東京 ローンチ")).toBe("東京-ローンチ");
    expect(projectId("Ünïcödé 2026")).toBe("ünïcödé-2026");
  });

  test("names with no letters or digits get a stable, per-name placeholder id", () => {
    expect(projectId("!!!")).toMatch(/^project-[0-9a-z]+$/);
    expect(projectId("!!!")).toBe(projectId("!!!"));
    expect(projectId("!!!")).not.toBe(projectId("???"));
    expect(projectId("—")).not.toBe(projectId("project"));
    expect(projectId("!!!")).not.toBe("project");
  });

  test("+ and # are spelled out so C++ and C# stay apart", () => {
    expect(projectId("C++ Migration")).toBe("c-plus-plus-migration");
    expect(projectId("C# Migration")).toBe("c-sharp-migration");
    expect(projectId("c++  migration")).toBe("c-plus-plus-migration");
  });
});

describe("grouping", () => {
  test("spellings group; on a tie the display name prefers capitals", () => {
    const { db } = testEnv();
    const t = Date.now();
    addDoc(db, { projects: ["pricing platform"], ts: t });
    addDoc(db, { projects: ["Pricing Platform"], ts: t });
    addDoc(db, { projects: ["  pricing\tplatform "], ts: t });
    const [p, ...rest] = listProjects(db, t);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ id: "pricing-platform", doc_count: 3, name: "Pricing Platform" });
  });

  // APP BUG (cosmetic): displayName() only trims the outer whitespace of a spelling, so a
  // name enriched as "Pricing   Platform" (or with a tab) is shown with the run of spaces,
  // although projectKey() collapses it for grouping. projects.ts groups() `m.name.trim()`.
  test("display names collapse inner whitespace runs", () => {
    const { db } = testEnv();
    addDoc(db, { projects: ["Pricing   Platform"] });
    addDoc(db, { projects: ["Pricing\tPlatform"] });
    expect(listProjects(db)[0]!.name).toBe("Pricing Platform");
  });

  test("the majority spelling wins over capitals", () => {
    const { db } = testEnv();
    const t = Date.now();
    addDoc(db, { projects: ["atlas"], ts: t });
    addDoc(db, { projects: ["atlas"], ts: t });
    addDoc(db, { projects: ["ATLAS"], ts: t });
    expect(listProjects(db, t)[0]!.name).toBe("atlas");
  });

  test("display names are trimmed and lookups use the slug", () => {
    const { db } = testEnv();
    const t = Date.now();
    addDoc(db, { projects: ["  Zürich Launch  "], ts: t });
    const [p] = listProjects(db, t);
    expect(p).toMatchObject({ id: "zürich-launch", name: "Zürich Launch" });
    expect(getProject(db, "zürich-launch", t)?.doc_count).toBe(1);
    // Names resolve too (so ?project=Zürich%20Launch links work), to the same project.
    expect(getProject(db, "Zürich Launch", t)?.id).toBe("zürich-launch");
  });

  // Regression: "C++ Migration" and "C# Migration" used to collide as "c-migration" (fixed in 78786ce).
  test("distinct names that only differ in + / # stay separate projects", () => {
    const { db } = testEnv();
    addDoc(db, { projects: ["C++ Migration"] });
    addDoc(db, { projects: ["C# Migration"] });
    addDoc(db, { projects: ["!!!"] });
    addDoc(db, { projects: ["???"] });
    addDoc(db, { projects: ["Project"] });
    const ids = listProjects(db).map((p) => p.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(getProject(db, id)!.doc_count).toBe(1);
  });

  test("a doc naming the same project twice counts once", () => {
    const { db } = testEnv();
    addDoc(db, { projects: ["Atlas", "atlas", "ATLAS"] });
    const [p] = listProjects(db);
    expect(p!.doc_count).toBe(1);
    expect(getProject(db, "atlas")!.docs).toHaveLength(1);
  });

  test("blank, whitespace-only and scalar non-string project entries are ignored", () => {
    // (Objects and arrays can't get here: the enrichment schema only accepts strings.)
    const { db } = testEnv();
    addDoc(db, { projects: ["", "   ", null, 42, true, "Real"] });
    expect(listProjects(db).map((p) => p.id)).toEqual(["real"]);
  });

  test("an empty or missing projects list yields no projects", () => {
    const { db } = testEnv();
    addDoc(db, { projects: [] });
    expect(listProjects(db)).toEqual([]);
    expect(getOverview(db).projects).toBe(0);
  });

  test("only the current enrichment counts: re-enriching moves a doc between projects", () => {
    const { db } = testEnv();
    const id = addDoc(db, { projects: ["Atlas"] });
    addDoc(db, { projects: ["Atlas"] });
    expect(getProject(db, "atlas")!.doc_count).toBe(2);
    enrich(db, id, ["Meridian"]);
    expect(getProject(db, "atlas")!.doc_count).toBe(1);
    expect(getProject(db, "meridian")!.docs.map((d) => d.id)).toEqual([id]);
    // ...and a project left with no docs disappears entirely.
    enrich(db, id, []);
    expect(getProject(db, "meridian")).toBeNull();
    expect(listProjects(db).map((p) => p.id)).toEqual(["atlas"]);
  });

  test("deleting a doc removes it from its projects, and the last doc removes the project", () => {
    const { db } = testEnv();
    const a = addDoc(db, { projects: ["Atlas", "Solo"] });
    const b = addDoc(db, { projects: ["Atlas"] });
    expect(deleteDoc(db, a)).toBe(true);
    expect(getProject(db, "solo")).toBeNull();
    expect(getProject(db, "atlas")!.docs.map((d) => d.id)).toEqual([b]);
    expect(getProject(db, "atlas")!.related_projects).toEqual([]);
  });

  test("a project with a single doc has a complete detail page", () => {
    const { db } = testEnv();
    const id = addDoc(db, { projects: ["Lonely"], tags: ["one", "two"] });
    const p = getProject(db, "lonely")!;
    expect(p).toMatchObject({ doc_count: 1, recent_doc_count: 1, new_doc_count: 1, active: true });
    expect(p.docs.map((d) => d.id)).toEqual([id]);
    expect(p.key_docs.map((d) => d.id)).toEqual([id]);
    expect(p.people).toEqual([]);
    expect(p.top_people).toEqual([]);
    expect(p.topics).toEqual([]); // topics need two docs sharing a tag
    expect(p.related_projects).toEqual([]);
    expect(p.doc_types).toEqual([{ doc_type: "design_doc", count: 1 }]);
  });

  test("meetings are the project's meeting notes; key docs cap at five", () => {
    const { db } = testEnv();
    const t = Date.now();
    for (let i = 0; i < 7; i++) addDoc(db, { projects: ["Big"], ts: t - i * 1000, docType: i % 2 ? "meeting_notes" : "design_doc" });
    const p = getProject(db, "big", t)!;
    expect(p.key_docs).toHaveLength(5);
    expect(p.meetings).toHaveLength(3);
    expect(p.meetings.every((d) => d.enrichment?.doc_type === "meeting_notes")).toBe(true);
    expect(p.doc_types).toEqual([
      { doc_type: "design_doc", count: 4 },
      { doc_type: "meeting_notes", count: 3 },
    ]);
  });

  test("activity windows: recent (7d), new (7d), active (14d)", () => {
    const { db } = testEnv();
    const t = Date.now();
    // First seen 20 days ago, last opened 10 days ago: not recent, not new, still active.
    const { row } = recordVisit(db, { url: gdocUrl("w1"), title: "Older", ts: t - 20 * DAY });
    recordVisit(db, { url: gdocUrl("w1"), title: "Older", ts: t - 10 * DAY });
    enrich(db, row.id, ["Windowed"]);
    let p = listProjects(db, t)[0]!;
    expect(p).toMatchObject({ recent_doc_count: 0, new_doc_count: 0, active: true });
    // Fifteen days later nothing changed: quiet.
    p = listProjects(db, t + 5 * DAY)[0]!;
    expect(p.active).toBe(false);
    // Boundaries are inclusive.
    expect(listProjects(db, t - 10 * DAY + 7 * DAY)[0]!.recent_doc_count).toBe(1);
    expect(listProjects(db, t - 10 * DAY + 14 * DAY)[0]!.active).toBe(true);
  });

  test("ordering: active before quiet, then most recent, then larger, then name", () => {
    const { db } = testEnv();
    const t = Date.now();
    addDoc(db, { projects: ["Quiet Big"], ts: t - 30 * DAY });
    addDoc(db, { projects: ["Quiet Big"], ts: t - 30 * DAY });
    addDoc(db, { projects: ["Fresh"], ts: t - DAY });
    addDoc(db, { projects: ["Same B", "Same A"], ts: t - 2 * DAY });
    expect(listProjects(db, t).map((p) => p.name)).toEqual(["Fresh", "Same A", "Same B", "Quiet Big"]);
  });

  test("related projects count shared docs and exclude the project itself", () => {
    const { db } = testEnv();
    addDoc(db, { projects: ["Hub", "Spoke One"] });
    addDoc(db, { projects: ["Hub", "Spoke One", "Spoke Two"] });
    addDoc(db, { projects: ["Spoke Two"] });
    expect(getProject(db, "hub")!.related_projects).toEqual([
      { id: "spoke-one", name: "Spoke One", shared: 2 },
      { id: "spoke-two", name: "Spoke Two", shared: 1 },
    ]);
  });

  test("many docs in one project don't break the IN (...) queries", () => {
    const { db } = testEnv();
    for (let i = 0; i < 400; i++) addDoc(db, { projects: ["Huge"] });
    const p = getProject(db, "huge")!;
    expect(p.doc_count).toBe(400);
    expect(p.docs).toHaveLength(400);
  });
});

describe("overview", () => {
  test("an empty library is all zeros and no activity", () => {
    const { db } = testEnv();
    expect(getOverview(db)).toEqual({ docs: 0, projects: 0, new_projects: 0, collections: 0, people: 0, activity: [] });
  });

  test("activity falls back from today to this week, and is empty beyond that", () => {
    const { db } = testEnv();
    const t = Date.now();
    addDoc(db, { projects: ["Weekly"], ts: t - 3 * DAY, enrichedAt: t - 3 * DAY });
    const week = getOverview(db, t).activity;
    expect(week.find((a) => a.kind === "captured")).toMatchObject({ count: 1, label: "1 doc captured" });
    expect(week.find((a) => a.kind === "enriched")).toMatchObject({ count: 1, label: "1 doc enriched" });
    expect(week.find((a) => a.kind === "project")).toMatchObject({ project_id: "weekly", label: "Project updated: Weekly", count: 1 });

    const later = getOverview(db, t + 10 * DAY);
    expect(later.activity).toEqual([]);
    expect(later.new_projects).toBe(0);
  });

  test("today's activity hides the rest of the week; counts and labels pluralise", () => {
    const { db } = testEnv();
    const t = Date.now();
    addDoc(db, { projects: [], ts: t - 3 * DAY, enrichedAt: t - 3 * DAY });
    addDoc(db, { projects: [], ts: t - 1000, enrichedAt: t - 1000 });
    addDoc(db, { projects: [], ts: t - 2000, enrichedAt: t - 2000 });
    const a = getOverview(db, t).activity;
    expect(a.find((x) => x.kind === "captured")).toMatchObject({ count: 2, label: "2 docs captured" });
    expect(a.find((x) => x.kind === "enriched")).toMatchObject({ count: 2, label: "2 docs enriched" });
  });

  test("activity is newest first and lists at most three updated projects", () => {
    const { db } = testEnv();
    const t = Date.now();
    for (let i = 0; i < 5; i++) addDoc(db, { projects: [`P${i}`], ts: t - (i + 1) * 60_000, enrichedAt: t - (i + 1) * 60_000 });
    const a = getOverview(db, t).activity;
    expect(a.filter((x) => x.kind === "project")).toHaveLength(3);
    const times = a.map((x) => x.at);
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  test("new_projects counts projects whose every doc is new this week", () => {
    const { db } = testEnv();
    const t = Date.now();
    addDoc(db, { projects: ["Brand New"], ts: t - DAY });
    addDoc(db, { projects: ["Mixed"], ts: t - DAY });
    addDoc(db, { projects: ["Mixed"], ts: t - 30 * DAY });
    const o = getOverview(db, t);
    expect(o.projects).toBe(2);
    expect(o.new_projects).toBe(1);
  });

  test("superseded enrichments don't count as activity", () => {
    const { db } = testEnv();
    const t = Date.now();
    // An old doc whose recent enrichment was superseded by one from a month ago.
    const id = addDoc(db, { projects: [], ts: t - 30 * DAY, enrichedAt: t - 1000 });
    enrich(db, id, [], { at: t - 30 * DAY });
    expect(getOverview(db, t).activity).toEqual([]);
  });
});

describe("project filters match every spelling", () => {
  async function spelledCorpus() {
    const env = testEnv();
    const ids = [
      await env.addDoc(gdocUrl("s1"), "Walrus plan one", "walrus migration plan one"),
      await env.addDoc(gdocUrl("s2"), "Walrus plan two", "walrus migration plan two"),
      await env.addDoc(gdocUrl("s3"), "Walrus plan three", "walrus migration plan three"),
      await env.addDoc(gdocUrl("s4"), "Walrus other", "walrus migration elsewhere"),
    ];
    enrich(env.db, ids[0]!, ["Pricing Platform"]);
    enrich(env.db, ids[1]!, ["pricing platform"]);
    enrich(env.db, ids[2]!, ["PRICING  PLATFORM"]);
    enrich(env.db, ids[3]!, ["Something Else"]);
    return { env, ids };
  }

  test("projectSpellings resolves a name or an id to all grouped spellings", async () => {
    const { env } = await spelledCorpus();
    for (const key of ["pricing-platform", "Pricing Platform", "pricing platform"]) {
      expect(projectSpellings(env.db, key).sort()).toEqual(["PRICING  PLATFORM", "Pricing Platform", "pricing platform"]);
    }
    expect(projectSpellings(env.db, "Unknown Thing")).toEqual(["Unknown Thing"]);
  });

  test("search scoped to one spelling finds the docs under every spelling, and nothing else", async () => {
    const { env, ids } = await spelledCorpus();
    for (const name of ["Pricing Platform", "pricing platform", "pricing-platform"]) {
      const res = await search(env.searchDeps, { q: "walrus migration", filters: { project: [name] }, mode: "keyword" });
      expect(res.hits.map((h) => h.doc.id).sort()).toEqual(ids.slice(0, 3).sort());
    }
  });
});
