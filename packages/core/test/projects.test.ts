import { describe, expect, test } from "bun:test";
import { createCollection } from "../src/collections";
import { recordVisit } from "../src/docs";
import { getOverview, getProject, listProjects, projectId } from "../src/projects";
import { gdocUrl, testEnv } from "./helpers";

const DAY = 86_400_000;

async function corpus() {
  const env = testEnv();
  const t = Date.now();
  const ids = {
    design: await env.addDoc(gdocUrl(1), "Rate limit design", "Author: Maya Chen\nProject Atlas token bucket rate limits for pricing tiers. Gateway quota design.", { ts: t - 2 * DAY }),
    notes: await env.addDoc(gdocUrl(2), "Atlas sync", "Attendees: Maya Chen, Lin Zhao\nProject Atlas gateway quota review. Next steps for the gateway.", { ts: t - DAY }),
    growth: await env.addDoc(gdocUrl(3), "Growth OKRs", "Owner: Priya Natarajan\nProject Meridian activation goals. Project Atlas pricing dependency.", { ts: t - 40 * DAY }),
    old: await env.addDoc(gdocUrl(4), "Meridian retro", "Owner: Priya Natarajan\nProject Meridian retrospective.", { ts: t - 60 * DAY }),
    none: await env.addDoc(gdocUrl(5), "Lunch", "Sandwiches for the offsite."),
  };
  return { env, ids, t };
}

describe("projects", () => {
  test("projectId slugs names so spellings group together", () => {
    expect(projectId("Pricing Platform")).toBe("pricing-platform");
    expect(projectId("  pricing   platform ")).toBe("pricing-platform");
    expect(projectId("Zürich Launch!")).toBe("zürich-launch");
  });

  test("lists projects from enrichments: active first, with counts and people", async () => {
    const { env } = await corpus();
    const list = listProjects(env.db);
    expect(list.map((p) => p.name)).toEqual(["Atlas", "Meridian"]);
    const atlas = list[0]!;
    expect(atlas).toMatchObject({ id: "atlas", doc_count: 3, active: true, recent_doc_count: 2 });
    expect(atlas.top_people[0]).toBe("Maya Chen");
    expect(list[1]).toMatchObject({ id: "meridian", doc_count: 2, active: false });
  });

  test("project detail: docs newest first, people, related projects; unknown id is null", async () => {
    const { env, ids } = await corpus();
    const p = getProject(env.db, "atlas")!;
    expect(p.docs.map((d) => d.id)).toEqual([ids.notes, ids.design, ids.growth]);
    expect(p.people.find((x) => x.name === "Maya Chen")?.count).toBe(2);
    expect(p.related_projects).toEqual([{ id: "meridian", name: "Meridian", shared: 1 }]);
    expect(p.topics.some((t) => t.tag === "gateway")).toBe(true);
    expect(getProject(env.db, "nope")).toBeNull();
  });

  test("pinned docs lead the key docs", async () => {
    const { env, ids } = await corpus();
    env.db.run(`UPDATE documents SET pinned = 1 WHERE id = ?`, [ids.growth]);
    expect(getProject(env.db, "atlas")!.key_docs[0]!.id).toBe(ids.growth);
  });

  test("overview counts and an activity feed", async () => {
    const { env } = await corpus();
    createCollection(env.db, { name: "Reading" });
    recordVisit(env.db, { url: gdocUrl(9), title: "Fresh" });
    const o = getOverview(env.db);
    expect(o).toMatchObject({ docs: 6, projects: 2, collections: 1 });
    expect(o.people).toBeGreaterThanOrEqual(3);
    expect(o.activity.map((a) => a.kind)).toContain("captured");
    expect(o.activity.find((a) => a.kind === "enriched")?.count).toBe(5);
  });
});

describe("project identity and scoping", () => {
  test("ids spell out + and # so C++, C# and C stay apart; symbol-only names get stable ids", () => {
    expect([projectId("C++"), projectId("C#"), projectId("C")]).toEqual(["c-plus-plus", "c-sharp", "c"]);
    expect(projectId("Billing v2")).toBe(projectId("billing-v2"));
    expect(projectId("🚀")).toMatch(/^project-[a-z0-9]+$/);
    expect(projectId("🚀")).toBe(projectId("🚀"));
    expect(projectId("🚀")).not.toBe(projectId("🎯"));
  });

  test("a project filter covers every spelling the project page groups", async () => {
    const env = testEnv();
    const { search } = await import("../src/search/hybrid");
    const a = await env.addDoc(gdocUrl(11), "One", "Project Atlas kickoff notes about metering.");
    const b = await env.addDoc(gdocUrl(12), "Two", "Other notes about metering.");
    env.db.run(`UPDATE enrichments SET projects = '["billing-v2"]' WHERE doc_id = ?`, [a]);
    env.db.run(`UPDATE enrichments SET projects = '["Billing v2"]' WHERE doc_id = ?`, [b]);
    expect(getProject(env.db, "billing-v2")!.doc_count).toBe(2);
    const res = await search(env.searchDeps, { q: "", filters: { project: ["Billing v2"] } });
    expect(res.hits.map((h) => h.doc.id).sort()).toEqual([a, b].sort());
  });
});

test('"Project Atlas" and "Atlas" are one project; a project named just "Project" stays itself', () => {
  expect(projectId("Project Atlas")).toBe(projectId("Atlas"));
  expect(projectId("Atlas project")).toBe("atlas");
  expect(projectId("Project")).toBe("project");
});
