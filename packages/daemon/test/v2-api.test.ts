import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultConfig, recordVisit } from "@faber/core";
import type { Overview, ProjectDetail, ProjectSummary, Settings } from "@faber/shared";
import { DEFAULT_APPEARANCE } from "@faber/shared";
import { AppContext } from "../src/context";
import { seedDemo } from "../src/demo";
import { startServer } from "../src/server";

/** The v2 routes (projects, overview, appearance) and the read-override/Sec-Fetch-Site rules, over HTTP. */

let ctx: AppContext;
let base: string;
let server: ReturnType<typeof startServer>;
const EXT = "chrome-extension://vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv";
const EXT_ID = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv";

beforeAll(async () => {
  const cfg = defaultConfig("/tmp/faber-v2-api-test");
  cfg.db_path = ":memory:";
  cfg.embed = { provider: "fake", model: "fake-embed" };
  cfg.enrich = { provider: "fake", model: "fake-enrich" };
  ctx = new AppContext(cfg);
  await seedDemo(ctx);
  server = startServer(ctx, { port: 0, log: () => {}, autoEnrich: false });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function call<T = unknown>(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, json: json as T };
}

/** A doc whose current enrichment names exactly these projects. */
function docWithProjects(projects: string[], url = `https://example.com/v2/${crypto.randomUUID()}`): string {
  const { row } = recordVisit(ctx.db, { url, title: `Doc for ${projects.join(", ")}` });
  ctx.db.run(
    `INSERT INTO enrichments (doc_id, provider, model, prompt_version, content_hash, summary, doc_type, written_at,
       projects, people, teams, tags, confidence, raw, is_current, created_at)
     VALUES (?, 't', 't', 1, NULL, 's', 'wiki', NULL, ?, '[]', '[]', '[]', 0.9, NULL, 1, ?)`,
    [row.id, JSON.stringify(projects), Date.now()],
  );
  return row.id;
}

describe("GET /api/projects and /api/projects/:id", () => {
  test("lists the demo's projects with summaries", async () => {
    const r = await call<ProjectSummary[]>("GET", "/api/projects");
    expect(r.status).toBe(200);
    expect(r.json.map((p) => p.id).sort()).toEqual(["atlas", "bedrock", "frankfurt", "kickstart"]);
    for (const p of r.json) {
      expect(p.doc_count).toBeGreaterThan(0);
      expect(typeof p.active).toBe("boolean");
      expect(p.top_people.length).toBeLessThanOrEqual(3);
    }
  });

  test("a project's detail matches its summary", async () => {
    const list = (await call<ProjectSummary[]>("GET", "/api/projects")).json;
    const atlas = list.find((p) => p.id === "atlas")!;
    const r = await call<ProjectDetail>("GET", "/api/projects/atlas");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: "atlas", name: atlas.name, doc_count: atlas.doc_count });
    expect(r.json.docs).toHaveLength(atlas.doc_count);
    // Newest first.
    const seen = r.json.docs.map((d) => d.last_seen_at);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  test("names resolve to their project (so ?project=Atlas links work); unknown ids are 404 with a JSON error", async () => {
    for (const id of ["ATLAS", "Atlas", "atlas%20"]) {
      const r = await call<ProjectDetail>("GET", `/api/projects/${id}`);
      expect(r.status).toBe(200);
      expect(r.json.id).toBe("atlas");
    }
    const r = await call<{ error: string }>("GET", `/api/projects/no-such-project`);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("project not found");
  });

  test("unicode ids round-trip through percent-encoding", async () => {
    docWithProjects(["Zürich Launch"]);
    docWithProjects(["東京 ローンチ"]);
    const list = (await call<ProjectSummary[]>("GET", "/api/projects")).json;
    expect(list.map((p) => p.id)).toEqual(expect.arrayContaining(["zürich-launch", "東京-ローンチ"]));
    for (const id of ["zürich-launch", "東京-ローンチ"]) {
      const r = await call<ProjectDetail>("GET", `/api/projects/${encodeURIComponent(id)}`);
      expect(r.status).toBe(200);
      expect(r.json.id).toBe(id);
    }
  });

  test("an encoded slash stays inside the id (404, not a different route); a malformed escape is 400", async () => {
    const slash = await call<{ error: string }>("GET", "/api/projects/a%2Fb");
    expect(slash.status).toBe(404);
    expect(slash.json.error).toBe("project not found");
    // A raw slash is a different path: no such route.
    expect((await call("GET", "/api/projects/a/b")).status).toBe(404);
    const bad = await call<{ error: string }>("GET", "/api/projects/%E0%A4%A");
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("malformed URL");
  });

  test("projects are corrected with POST (create) and PATCH (update); other verbs are 405", async () => {
    for (const m of ["PUT", "DELETE"]) expect((await call(m, "/api/projects")).status).toBe(405);
    for (const m of ["POST", "PUT", "DELETE"]) expect((await call(m, "/api/projects/atlas")).status).toBe(405);
    const made = await call<ProjectDetail>("POST", "/api/projects", { body: { name: "Hand Made" } });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ id: "hand-made", manual: true, doc_count: 0 });
    expect((await call("POST", "/api/projects", { body: { name: "hand  made" } })).status).toBe(409);
    expect((await call("POST", "/api/projects", { body: { name: "" } })).status).toBe(400);
    const renamed = await call<ProjectDetail>("PATCH", "/api/projects/hand-made", { body: { name: "Handmade" } });
    expect(renamed.json.name).toBe("Handmade");
    expect((await call("PATCH", "/api/projects/nope", { body: { name: "x" } })).status).toBe(404);
    expect((await call("DELETE", "/api/projects/hand-made/corrections")).status).toBe(200);
    expect((await call("GET", "/api/projects/hand-made")).status).toBe(404);
  });

  test("document assignment, review, corrections and views over HTTP", async () => {
    const id = docWithProjects(["Loose Doc Project"]);
    let refs = (await call<{ id: string; corrected: boolean }[]>("PUT", `/api/docs/${id}/projects`, { body: { project: "Atlas", in: true } })).json;
    expect(refs.map((r) => r.id).sort()).toEqual(["atlas", "loose-doc"]);
    refs = (await call<{ id: string }[]>("PUT", `/api/docs/${id}/projects`, { body: { project: "Atlas", in: null } })).json;
    expect(refs.map((r) => r.id)).toEqual(["loose-doc"]);
    expect((await call("PUT", `/api/docs/${id}/projects`, { body: {} })).status).toBe(400);
    expect((await call("PUT", `/api/docs/nope/projects`, { body: { project: "Atlas", in: true } })).status).toBe(404);
    const q = (await call<{ items: { id: string }[] }>("GET", "/api/review")).json;
    expect(Array.isArray(q.items)).toBe(true);
    expect((await call("POST", "/api/review/bogus/dismiss")).status).toBe(400);
    expect((await call<{ rules: unknown[]; docs: unknown[] }>("GET", "/api/organize/corrections")).status).toBe(200);
    const v = await call<{ id: string }>("POST", "/api/views", { body: { name: "Mine", spec: { widgets: [{ kind: "recent" }] } } });
    expect(v.status).toBe(200);
    expect((await call("PATCH", "/api/views/my-work", { body: { name: "x" } })).status).toBe(400);
    expect((await call("DELETE", `/api/views/${v.json.id}`)).status).toBe(200);
    expect((await call("GET", `/api/views/${v.json.id}`)).status).toBe(404);
    expect((await call<unknown[]>("GET", "/api/activity/projects")).status).toBe(200);
  });

  test("deleting a project's only doc removes the project", async () => {
    const id = docWithProjects(["Ephemeral Thing"]);
    expect((await call("GET", "/api/projects/ephemeral-thing")).status).toBe(200);
    expect((await call("DELETE", `/api/docs/${id}`)).status).toBe(200);
    expect((await call("GET", "/api/projects/ephemeral-thing")).status).toBe(404);
    expect((await call<ProjectSummary[]>("GET", "/api/projects")).json.some((p) => p.id === "ephemeral-thing")).toBe(false);
  });
});

describe("GET /api/overview", () => {
  test("counts agree with the other endpoints", async () => {
    const o = (await call<Overview>("GET", "/api/overview")).json;
    const projects = (await call<ProjectSummary[]>("GET", "/api/projects")).json;
    const collections = (await call<unknown[]>("GET", "/api/collections")).json;
    const status = (await call<{ docs: number }>("GET", "/api/status")).json;
    expect(o.projects).toBe(projects.length);
    expect(o.collections).toBe(collections.length);
    expect(o.docs).toBe(status.docs);
    expect(o.new_projects).toBeLessThanOrEqual(o.projects);
    expect(o.people).toBeGreaterThan(0);
  });

  test("activity items are newest first and project items point at real projects", async () => {
    const o = (await call<Overview>("GET", "/api/overview")).json;
    expect(o.activity.length).toBeGreaterThan(0);
    const at = o.activity.map((a) => a.at);
    expect([...at].sort((a, b) => b - a)).toEqual(at);
    for (const a of o.activity.filter((x) => x.kind === "project")) {
      expect((await call("GET", `/api/projects/${encodeURIComponent(a.project_id!)}`)).status).toBe(200);
    }
  });
});

describe("appearance over HTTP", () => {
  const LATTE = { theme: "latte", dark_flavor: "macchiato", accent: "teal", density: "compact" } as const;

  test("an appearance-only PUT leaves the watchlist as it was, and vice versa", async () => {
    const before = (await call<Settings>("GET", "/api/settings")).json;
    const r = await call<Settings>("PUT", "/api/settings", { body: { appearance: LATTE } });
    expect(r.status).toBe(200);
    expect(r.json.appearance).toEqual(LATTE);
    expect(r.json.watchlist).toEqual(before.watchlist);

    const wl = before.watchlist.map((x) => (x.id === "gslides" ? { ...x, enabled: !x.enabled } : x));
    const r2 = await call<Settings>("PUT", "/api/settings", { body: { watchlist: wl } });
    expect(r2.json.appearance).toEqual(LATTE);
    expect(r2.json.watchlist.find((x) => x.id === "gslides")!.enabled).toBe(!before.watchlist.find((x) => x.id === "gslides")!.enabled);
    await call("PUT", "/api/settings", { body: { watchlist: before.watchlist, appearance: DEFAULT_APPEARANCE } });
  });

  test("invalid appearance values are normalised, not rejected", async () => {
    const r = await call<Settings>("PUT", "/api/settings", { body: { appearance: { theme: 7, accent: "<b>", density: ["compact"], dark_flavor: "latte" } } });
    expect(r.status).toBe(200);
    expect(r.json.appearance).toEqual(DEFAULT_APPEARANCE);
  });

  test("an empty or non-object body is a 400 and changes nothing", async () => {
    const before = (await call<Settings>("GET", "/api/settings")).json;
    expect((await call("PUT", "/api/settings", { body: {} })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { body: "[1,2]" })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { body: "null" })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { body: "{not json" })).status).toBe(400);
    expect((await call<Settings>("GET", "/api/settings")).json).toEqual(before);
  });

  // Regression: a prototype-key theme used to be stored and then break every surface (fixed in 78786ce).
  test("PUT appearance.theme = \"constructor\" is normalised to the default", async () => {
    const r = await call<Settings>("PUT", "/api/settings", { body: { appearance: { ...DEFAULT_APPEARANCE, theme: "constructor" } } });
    try {
      expect(r.json.appearance.theme).toBe(DEFAULT_APPEARANCE.theme);
    } finally {
      await call("PUT", "/api/settings", { body: { appearance: DEFAULT_APPEARANCE } });
    }
  });
});

describe("x-faber-method and Sec-Fetch-Site", () => {
  beforeAll(async () => {
    expect((await call("POST", `/api/extensions/${EXT_ID}/approve`)).status).toBe(200);
  });

  test("POST + x-faber-method: GET serves the read, for every new read route", async () => {
    for (const path of ["/api/projects", "/api/projects/atlas", "/api/overview", "/api/settings"]) {
      const plain = await call("GET", path);
      const over = await call("POST", path, { headers: { "x-faber-method": "GET" } });
      expect(over.status).toBe(200);
      expect(over.json).toEqual(plain.json);
    }
  });

  test("an overridden read never writes, even with a body", async () => {
    const before = (await call<Settings>("GET", "/api/settings")).json;
    const r = await call<Settings>("POST", "/api/settings", {
      headers: { "x-faber-method": "GET" },
      body: { appearance: { theme: "latte", dark_flavor: "mocha", accent: "red", density: "compact" }, watchlist: [] },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(before);
    expect((await call<Settings>("GET", "/api/settings")).json).toEqual(before);
  });

  test("only GET can be requested; other override values leave the POST as it is", async () => {
    for (const m of ["PUT", "DELETE", "PATCH", "OPTIONS", ""]) {
      expect((await call("POST", "/api/settings", { headers: { "x-faber-method": m }, body: { appearance: DEFAULT_APPEARANCE } })).status).toBe(405);
    }
    // Overriding on a non-POST does nothing either.
    expect((await call("PUT", "/api/projects", { headers: { "x-faber-method": "GET" } })).status).toBe(405);
    expect((await call("DELETE", "/api/overview", { headers: { "x-faber-method": "GET" } })).status).toBe(405);
  });

  test("a paired extension's overridden read gets CORS headers; the preflight allows the header", async () => {
    const pre = await call("OPTIONS", "/api/projects", {
      headers: { origin: EXT, "access-control-request-method": "POST", "access-control-request-headers": "x-faber-method" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-faber-method");
    expect(pre.headers.get("access-control-allow-origin")).toBe(EXT);

    const r = await call<ProjectSummary[]>("POST", "/api/projects", { headers: { origin: EXT, "x-faber-method": "GET", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(EXT);
    expect(r.json.length).toBeGreaterThan(0);
  });

  test("an unpaired extension's overridden read is refused with pairing_required", async () => {
    const other = "chrome-extension://wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww";
    const r = await call<{ code: string }>("POST", "/api/overview", { headers: { origin: other, "x-faber-method": "GET" } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("pairing_required");
    await call("DELETE", "/api/extensions/wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww");
  });

  test("Sec-Fetch-Site: none without an Origin is refused for any method except navigations", async () => {
    const h = { "sec-fetch-site": "none", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
    for (const [m, path] of [
      ["GET", "/api/projects"],
      ["GET", "/api/overview"],
      ["GET", "/api/settings"],
      ["POST", "/api/projects"],
      ["PUT", "/api/settings"],
    ] as const) {
      const r = await call<{ error: string }>(m, path, { headers: m === "POST" ? { ...h, "x-faber-method": "GET" } : h, body: m === "PUT" ? { appearance: DEFAULT_APPEARANCE } : undefined });
      expect(r.status).toBe(403);
      expect(r.json.error).toContain("x-faber-method");
    }
    const nav = await call("GET", "/api/projects", { headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    expect(nav.status).toBe(200);
  });

  test("a website can't use the override to read: its Origin is refused first", async () => {
    const r = await call("POST", "/api/projects", { headers: { origin: "https://evil.example", "x-faber-method": "GET" } });
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("dismissed extension requests", () => {
  const id = "dddddddddddddddddddddddddddddddd";
  const ext = { origin: `chrome-extension://${id}` };
  test("a dismissed request stays refused without coming back as pending; approve or forget undo it", async () => {
    expect((await call("GET", "/api/status", { headers: ext })).status).toBe(403);
    let list = (await call<{ id: string; state: string }[]>("GET", "/api/extensions")).json;
    expect(list.find((x) => x.id === id)?.state).toBe("pending");

    expect((await call("POST", `/api/extensions/${id}/dismiss`)).status).toBe(200);
    // It calls again: still refused, and not pending again.
    expect((await call("GET", "/api/status", { headers: ext })).status).toBe(403);
    list = (await call<{ id: string; state: string }[]>("GET", "/api/extensions")).json;
    expect(list.find((x) => x.id === id)?.state).toBe("dismissed");
    // An extension can't dismiss (or approve) itself.
    expect((await call("POST", `/api/extensions/${id}/dismiss`, { headers: ext })).status).toBe(403);

    expect((await call("POST", `/api/extensions/${id}/approve`)).status).toBe(200);
    expect((await call("GET", "/api/status", { headers: ext })).status).toBe(200);
    expect((await call("DELETE", `/api/extensions/${id}`)).status).toBe(200);
    expect((await call("GET", "/api/status", { headers: ext })).status).toBe(403);
    list = (await call<{ id: string; state: string }[]>("GET", "/api/extensions")).json;
    expect(list.find((x) => x.id === id)?.state).toBe("pending"); // forgotten → a new request
  });
});
