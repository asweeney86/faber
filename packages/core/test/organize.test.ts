import { describe, expect, test } from "bun:test";
import { ask, buildAskPrompt } from "../src/ask";
import { recordVisit } from "../src/docs";
import {
  clearDocProject,
  createProject,
  dismissReviewItem,
  listCorrections,
  mergeProject,
  OrganizeError,
  projectsForDoc,
  resetProject,
  reviewQueue,
  setDocProject,
  updateProject,
  writeProjectSummary,
} from "../src/organize";
import { extractDecisions, getProject, listProjects, recentProjectActivity } from "../src/projects";
import { search } from "../src/search/hybrid";
import { createView, deleteView, getView, listViews, updateView, ViewError } from "../src/views";
import { gdocUrl, testEnv } from "./helpers";

const DAY = 86_400_000;

async function corpus() {
  const env = testEnv();
  const t = Date.now();
  const ids = {
    atlas1: await env.addDoc(gdocUrl(1), "Rate limit design", "Author: Maya Chen\nProject Atlas token bucket rate limits. Decision: enforce limits for Starter on Nov 3.", { ts: t - DAY }),
    atlas2: await env.addDoc(gdocUrl(2), "Atlas metering", "Owner: Maya Chen\nProject Atlas metering pipeline. We agreed to bill monthly.", { ts: t - 2 * DAY }),
    fleet: await env.addDoc(gdocUrl(3), "Fleet capacity", "Owner: Lin Zhao\nProject Atlas Fleet node counts per region.", { ts: t - 3 * DAY }),
    kick: await env.addDoc(gdocUrl(4), "Kickstart onboarding", "Owner: Dana Ruiz\nProject Kickstart signup experiment.", { ts: t - 4 * DAY }),
    kick2: await env.addDoc(gdocUrl(5), "Kick-start retro", "Owner: Dana Ruiz\nProject Kickstarts retro notes.", { ts: t - 5 * DAY }),
    lunch: await env.addDoc(gdocUrl(6), "Lunch", "Sandwiches for the offsite."),
  };
  // The offline enricher only reads one-word names after "Project"; give this doc a two-word one.
  env.db.run(`UPDATE enrichments SET projects = '["Atlas Fleet"]' WHERE doc_id = ?`, [ids.fleet]);
  return { env, ids, t };
}
const names = (db: Parameters<typeof listProjects>[0]) => listProjects(db).map((p) => p.name).sort();

describe("hierarchy", () => {
  test("a name that extends another project's name is its subproject; the parent rolls up its docs", async () => {
    const { env, ids } = await corpus();
    const fleet = listProjects(env.db).find((p) => p.name === "Atlas Fleet")!;
    expect(fleet.parent_id).toBe("atlas");
    const atlas = getProject(env.db, "atlas")!;
    expect(atlas.children.map((c) => c.id)).toEqual(["atlas-fleet"]);
    expect(atlas.doc_count).toBe(3); // its two + the subproject's one
    expect(atlas.docs.map((d) => d.id)).toContain(ids.fleet);
    expect(getProject(env.db, "atlas-fleet")!.ancestors).toEqual([{ id: "atlas", name: "Atlas" }]);
  });

  test("explicit parents win; moving to top level; no cycles", async () => {
    const { env } = await corpus();
    updateProject(env.db, "kickstart", { parent_id: "atlas" });
    expect(listProjects(env.db).find((p) => p.id === "kickstart")!.parent_id).toBe("atlas");
    expect(() => updateProject(env.db, "atlas", { parent_id: "kickstart" })).toThrow(OrganizeError); // would be inside itself
    updateProject(env.db, "atlas-fleet", { parent_id: "" });
    expect(listProjects(env.db).find((p) => p.id === "atlas-fleet")!.parent_id).toBeNull();
    updateProject(env.db, "atlas-fleet", { parent_id: null }); // back to inferred
    expect(listProjects(env.db).find((p) => p.id === "atlas-fleet")!.parent_id).toBe("atlas");
  });
});

describe("corrections", () => {
  test("rename keeps the id; merge moves everything; reset undoes", async () => {
    const { env } = await corpus();
    updateProject(env.db, "kickstart", { name: "Onboarding (Kickstart)" });
    expect(getProject(env.db, "kickstart")!.name).toBe("Onboarding (Kickstart)");
    mergeProject(env.db, "kickstarts", "kickstart");
    const k = getProject(env.db, "kickstart")!;
    expect(k.doc_count).toBe(2);
    expect(k.aliases).toContain("Kickstarts");
    expect(names(env.db)).not.toContain("Kickstarts");
    // The old id still finds where it went.
    expect(getProject(env.db, "kickstarts")!.id).toBe("kickstart");
    expect(() => mergeProject(env.db, "kickstart", "kickstart")).toThrow(OrganizeError);
    resetProject(env.db, "kickstarts");
    expect(names(env.db)).toContain("Kickstarts");
  });

  test("not a project: hidden from lists, and re-enrichment can't bring it back", async () => {
    const { env } = await corpus();
    updateProject(env.db, "kickstarts", { hidden: true });
    expect(names(env.db)).not.toContain("Kickstarts");
    expect(getProject(env.db, "kickstarts")).toBeNull();
    expect(listCorrections(env.db).rules.find((r) => r.id === "kickstarts")?.hidden).toBe(true);
  });

  test("hand-made projects exist empty; docs can be put in and taken out", async () => {
    const { env, ids } = await corpus();
    const id = createProject(env.db, { name: "Offsite planning" });
    expect(getProject(env.db, id)).toMatchObject({ name: "Offsite planning", doc_count: 0, manual: true });
    expect(() => createProject(env.db, { name: "offsite  planning" })).toThrow(/already exists/);
    setDocProject(env.db, ids.lunch, id, true);
    expect(projectsForDoc(env.db, ids.lunch)).toEqual([{ id, name: "Offsite planning", corrected: true }]);
    // Take a doc out of the project enrichment put it in.
    setDocProject(env.db, ids.atlas2, "atlas", false);
    expect(getProject(env.db, "atlas")!.docs.map((d) => d.id)).not.toContain(ids.atlas2);
    // Scoped search follows the corrections.
    const hits = await search(env.searchDeps, { q: "", filters: { project: ["Atlas"] } });
    expect(hits.hits.map((h) => h.doc.id).sort()).toEqual([ids.atlas1, ids.fleet].sort());
    clearDocProject(env.db, ids.atlas2, "atlas");
    expect(getProject(env.db, "atlas")!.docs.map((d) => d.id)).toContain(ids.atlas2);
    // Adding to a project that doesn't exist yet creates it.
    setDocProject(env.db, ids.lunch, "Team rituals", true);
    expect(names(env.db)).toContain("Team rituals");
    expect(listCorrections(env.db).docs.length).toBeGreaterThanOrEqual(2);
  });

  test("subprojects follow their parent into a merge", async () => {
    const { env } = await corpus();
    updateProject(env.db, "atlas-fleet", { parent_id: "atlas" });
    createProject(env.db, { name: "Pricing" });
    mergeProject(env.db, "atlas", "pricing");
    expect(listProjects(env.db).find((p) => p.id === "atlas-fleet")!.parent_id).toBe("pricing");
  });
});

describe("review queue", () => {
  test("offers unconfirmed small projects and look-alike names; acting or dismissing clears them", async () => {
    const { env } = await corpus();
    const q = reviewQueue(env.db);
    const kinds = q.items.map((i) => i.id);
    expect(kinds).toContain("dup:kickstart|kickstarts");
    expect(kinds).toContain("new:kickstarts");
    expect(kinds).not.toContain("new:atlas"); // 2+ docs with a subproject: not "uncertain"
    mergeProject(env.db, "kickstarts", "kickstart");
    expect(reviewQueue(env.db).items.map((i) => i.id)).not.toContain("dup:kickstart|kickstarts");
    const rest = reviewQueue(env.db).items[0];
    if (rest) {
      dismissReviewItem(env.db, rest.id);
      expect(reviewQueue(env.db).items.map((i) => i.id)).not.toContain(rest.id);
    }
    expect(() => dismissReviewItem(env.db, "bogus")).toThrow(OrganizeError);
  });

  test("low-confidence classifications are offered for review", async () => {
    const { env, ids } = await corpus();
    env.db.run(`UPDATE enrichments SET confidence = 0.2 WHERE doc_id = ?`, [ids.lunch]);
    const item = reviewQueue(env.db).items.find((i) => i.kind === "low_confidence");
    expect(item && item.kind === "low_confidence" && item.doc.id).toBe(ids.lunch);
  });
});

describe("workspace extras", () => {
  test("decisions come from the project's documents", async () => {
    const { env } = await corpus();
    const d = getProject(env.db, "atlas")!.decisions.map((x) => x.text);
    expect(d).toContain("Decision: enforce limits for Starter on Nov 3.");
    expect(d.some((x) => x.includes("We agreed to bill monthly"))).toBe(true);
    expect(extractDecisions("Did we decide anything? Unknown.\nDecision: ship it Friday.")).toEqual(["Decision: ship it Friday."]);
    // Status lines and pending items aren't decisions.
    expect(extractDecisions("Status: Approved by the council.\nRisks: Finance decision on burst pricing still pending.\nApproved in the April sync.")).toEqual([]);
  });

  test("the AI overview is cached and marked stale when the docs change", async () => {
    const { env } = await corpus();
    expect(getProject(env.db, "atlas")!.summary).toBeNull();
    const s = await writeProjectSummary(env.db, env.chat, "atlas");
    expect(s.text).toContain("Atlas");
    expect(getProject(env.db, "atlas")!.summary).toMatchObject({ text: s.text, stale: false });
    await env.addDoc(gdocUrl(9), "Atlas FAQ", "Project Atlas frequently asked questions about limits.");
    expect(getProject(env.db, "atlas")!.summary!.stale).toBe(true);
    const empty = createProject(env.db, { name: "Empty" });
    await expect(writeProjectSummary(env.db, env.chat, empty)).rejects.toThrow(/no summarised documents/);
  });

  test("recent project activity lists projects with what was opened, parents over subprojects", async () => {
    const { env } = await corpus();
    recordVisit(env.db, { url: gdocUrl(3) });
    const act = recentProjectActivity(env.db);
    expect(act[0]!.project.id).toBe("atlas");
    expect(act.map((a) => a.project.id)).not.toContain("atlas-fleet");
  });
});

describe("Ask follow-ups", () => {
  test("earlier turns go into the prompt as context, without their citation marks", () => {
    const p = buildAskPrompt("Who owns it?", [{ doc_id: "d", title: "T", url: "u", source: "gdoc", meta: "", text: "Sam owns the export fix." }], [
      { question: "What blocked Frankfurt?", answer: "The export pipeline [1]." },
    ]);
    expect(p).toContain("Q: What blocked Frankfurt?\nA: The export pipeline.");
    expect(p.indexOf("Earlier in this conversation")).toBeLessThan(p.indexOf("Question: Who owns it?"));
  });

  test("a follow-up is searched together with the question it follows", async () => {
    const { env } = await corpus();
    const r = await ask({ ...env.searchDeps, chat: env.chat }, { question: "who wrote it?", history: [{ question: "token bucket rate limits", answer: "Limits per tier [1]." }] });
    expect(r.citations.some((c) => c.title === "Rate limit design")).toBe(true);
  });
});

describe("saved views", () => {
  test("built-ins first and read-only; custom views validate, update and delete", () => {
    const env = testEnv();
    expect(listViews(env.db).slice(0, 3).map((v) => v.id)).toEqual(["my-work", "planning", "project-activity"]);
    expect(() => updateView(env.db, "my-work", { name: "x" })).toThrow(ViewError);
    expect(() => deleteView(env.db, "planning")).toThrow(ViewError);
    expect(() => createView(env.db, { name: "", spec: { widgets: [] } })).toThrow(/name/);
    expect(() => createView(env.db, { name: "X", spec: { widgets: [{ kind: "nope" }] } })).toThrow(/unknown kind/);
    const v = createView(env.db, { name: "  Pricing  ", spec: { widgets: [{ kind: "search", title: "Pricing", q: "pricing", limit: 999 }, { kind: "pinned" }] } });
    expect(v).toMatchObject({ name: "Pricing", builtin: false });
    expect(v.spec.widgets[0]).toMatchObject({ kind: "search", limit: 25 });
    expect(updateView(env.db, v.id, { name: "Pricing work" }).name).toBe("Pricing work");
    deleteView(env.db, v.id);
    expect(getView(env.db, v.id)).toBeNull();
  });
});

describe("correction edge cases (review round 2)", () => {
  const setProjects = (env: ReturnType<typeof testEnv>, id: string, names: string[]) =>
    env.db.run(`UPDATE enrichments SET projects = ? WHERE doc_id = ?`, [JSON.stringify(names), id]);

  test("a removal made in a project doesn't follow it into a merge; an explicit add always wins", async () => {
    const { env, ids } = await corpus();
    setProjects(env, ids.lunch, ["Atlas", "Apollo"]);
    setProjects(env, ids.kick2, ["Apollo"]);
    setDocProject(env.db, ids.lunch, "atlas", false);
    mergeProject(env.db, "atlas", "apollo");
    expect(getProject(env.db, "apollo")!.docs.map((d) => d.id)).toContain(ids.lunch); // it names Apollo itself
    setDocProject(env.db, ids.lunch, "apollo", false);
    expect(getProject(env.db, "apollo")!.docs.map((d) => d.id)).not.toContain(ids.lunch);
    setDocProject(env.db, ids.lunch, "apollo", true);
    expect(projectsForDoc(env.db, ids.lunch).map((p) => p.id)).toEqual(["apollo"]);
  });

  test("merging keeps the target's own name even when the merged one has more documents", async () => {
    const { env, ids } = await corpus();
    for (const id of [ids.atlas1, ids.atlas2, ids.fleet]) setProjects(env, id, ["Atlas Legacy"]);
    setProjects(env, ids.kick, ["Atlas"]);
    mergeProject(env.db, "atlas-legacy", "atlas");
    expect(getProject(env.db, "atlas")).toMatchObject({ name: "Atlas", doc_count: 4 });
  });

  test("a project can't be merged into its own descendant", async () => {
    const { env } = await corpus();
    expect(() => mergeProject(env.db, "atlas", "atlas-fleet")).toThrow(/inside/);
  });

  test("deleting a hand-made project removes it for good, even if docs were added to it", async () => {
    const { env, ids } = await corpus();
    const id = createProject(env.db, { name: "Handmade" });
    setDocProject(env.db, ids.lunch, id, true);
    resetProject(env.db, id);
    expect(getProject(env.db, id)).toBeNull();
    expect(projectsForDoc(env.db, ids.lunch)).toEqual([]);
  });

  test("re-creating a merged or hidden name is refused instead of silently undoing it", async () => {
    const { env } = await corpus();
    mergeProject(env.db, "kickstarts", "kickstart");
    expect(() => createProject(env.db, { name: "Kickstarts" })).toThrow(/merged/);
    updateProject(env.db, "atlas-fleet", { hidden: true });
    expect(() => createProject(env.db, { name: "Atlas Fleet" })).toThrow(/not a project/);
    // …and a hidden project can be brought back directly.
    updateProject(env.db, "atlas-fleet", { hidden: false });
    expect(getProject(env.db, "atlas-fleet")).not.toBeNull();
  });

  test("adding a doc to a new project with a very long name works", async () => {
    const { env, ids } = await corpus();
    const long = `Project ${"x".repeat(200)}`;
    setDocProject(env.db, ids.lunch, long, true);
    expect(projectsForDoc(env.db, ids.lunch)).toHaveLength(1);
  });

  test("bad input types are 400s, not crashes or truthy surprises", async () => {
    const { env } = await corpus();
    expect(() => updateProject(env.db, "atlas", { parent_id: 5 as never })).toThrow(OrganizeError);
    expect(() => updateProject(env.db, "atlas", { hidden: "no" as never })).toThrow(OrganizeError);
    expect(() => createProject(env.db, { name: 3 as never })).toThrow(OrganizeError);
    expect(() => mergeProject(env.db, "atlas", 7 as never)).toThrow(OrganizeError);
  });

  test("a hidden project's name filters to nothing, not to its raw spelling", async () => {
    const { env } = await corpus();
    updateProject(env.db, "kickstart", { hidden: true });
    const res = await search(env.searchDeps, { q: "", filters: { project: ["Kickstart"] } });
    expect(res.hits).toHaveLength(0);
  });

  test("numbered siblings aren't offered as duplicates", async () => {
    const { env, ids } = await corpus();
    setProjects(env, ids.lunch, ["Billing v1"]);
    setProjects(env, ids.kick, ["Billing v2"]);
    expect(reviewQueue(env.db).items.some((i) => i.id === "dup:billing-v1|billing-v2")).toBe(false);
  });

  test("the overview goes stale when the project is renamed", async () => {
    const { env } = await corpus();
    await writeProjectSummary(env.db, env.chat, "atlas");
    updateProject(env.db, "atlas", { name: "Atlas Pricing" });
    expect(getProject(env.db, "atlas")!.summary!.stale).toBe(true);
  });

  test("saved views validate search filters (relative seen_after allowed)", () => {
    const env = testEnv();
    expect(() => createView(env.db, { name: "x", spec: { widgets: [{ kind: "search", q: "", filters: { doc_type: ["nope"] } }] } })).toThrow(ViewError);
    expect(() => createView(env.db, { name: "x", spec: { widgets: [{ kind: "search", q: "", title: { a: 1 } }] } })).toThrow(/title/);
    const v = createView(env.db, { name: "x", spec: { widgets: [{ kind: "search", q: "", filters: { seen_after: -30, junk: 1 } as never }] } });
    expect(v.spec.widgets[0]).toMatchObject({ filters: { seen_after: -30 } });
    expect((v.spec.widgets[0] as { filters: Record<string, unknown> }).filters.junk).toBeUndefined();
  });
});

test("renaming to another project's name is refused; documents carry their corrected project names", async () => {
  const { env, ids } = await corpus();
  expect(() => updateProject(env.db, "atlas", { name: "Kickstart" })).toThrow(/already exists/);
  expect(() => updateProject(env.db, "atlas", { name: "kickstart" })).toThrow(/already exists/);
  updateProject(env.db, "atlas", { name: "Atlas Platform" });
  const { getDoc } = await import("../src/docs");
  expect(getDoc(env.db, ids.atlas1)!.project_refs).toEqual([{ id: "atlas", name: "Atlas Platform" }]);
});
