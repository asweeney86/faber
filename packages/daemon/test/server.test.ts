import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultConfig } from "@faber/core";
import type { CaptureResponse, CollectionExport, Doc, DocDetail, SearchResponse, Settings } from "@faber/shared";
import { AppContext } from "../src/context";
import { checkRequest, effectiveMethod, extensionIdOf, originAllowed } from "../src/security";
import { startServer } from "../src/server";
import { seedDemo } from "../src/demo";

const GDOC = "https://docs.google.com/document/d/1HttpTestAbcdefghijklmnopqrstuv/edit";

describe("security", () => {
  const opts = { port: 7777 };
  const req = (headers: Record<string, string>, method = "GET") => new Request("http://127.0.0.1:7777/api/status", { method, headers });

  test("origins: the UI and extensions pass, websites do not", () => {
    expect(originAllowed("http://127.0.0.1:7777", opts)).toBe(true);
    expect(originAllowed("http://localhost:7777", opts)).toBe(true);
    expect(originAllowed("http://localhost:8080", opts)).toBe(false);
    expect(originAllowed("chrome-extension://abcdef", opts)).toBe(true);
    expect(extensionIdOf("chrome-extension://abcdef")).toBe("abcdef");
    expect(extensionIdOf("https://abcdef.com")).toBeNull();
    expect(originAllowed("https://evil.com", opts)).toBe(false);
    expect(originAllowed("garbage", opts)).toBe(false);
  });

  test("requests: DNS rebinding, opaque and cross-site requests are refused", () => {
    expect(checkRequest(req({ host: "127.0.0.1:7777" }), opts).ok).toBe(true);
    expect(checkRequest(req({ host: "evil.com:7777" }), opts).ok).toBe(false);
    expect(checkRequest(req({ host: "[::1]:7777" }), opts).ok).toBe(true);
    expect(checkRequest(req({ origin: "null" }), opts).ok).toBe(false);
    expect(checkRequest(req({ "sec-fetch-site": "cross-site" }, "POST"), opts).ok).toBe(false);
    expect(checkRequest(req({ origin: "chrome-extension://abc" }, "POST"), opts)).toEqual({ ok: true, origin: "chrome-extension://abc" });
  });

  test("an unidentifiable extension GET (no Origin, Sec-Fetch-Site: none) is refused; navigations are not", () => {
    // What Chrome sends for a GET from an extension page with host permission: no Origin header.
    const extGet = req({ "sec-fetch-site": "none", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
    expect(checkRequest(extGet, opts).ok).toBe(false);
    // Typing the URL into the address bar.
    expect(checkRequest(req({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }), opts).ok).toBe(true);
    // The web app itself, and curl.
    expect(checkRequest(req({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }), opts).ok).toBe(true);
    expect(checkRequest(req({}), opts).ok).toBe(true);
  });

  test("x-faber-method turns a POST into a GET, and only into a GET", () => {
    const post = (h: Record<string, string>) => new Request("http://127.0.0.1:7777/api/settings", { method: "POST", headers: h });
    expect(effectiveMethod(post({ "x-faber-method": "GET" }))).toBe("GET");
    expect(effectiveMethod(post({ "x-faber-method": "get" }))).toBe("GET");
    expect(effectiveMethod(post({ "x-faber-method": "DELETE" }))).toBe("POST");
    expect(effectiveMethod(new Request("http://127.0.0.1:7777/x", { method: "PUT", headers: { "x-faber-method": "GET" } }))).toBe("PUT");
  });
});

describe("HTTP API", () => {
  let ctx: AppContext;
  let base: string;
  let server: ReturnType<typeof startServer>;

  beforeAll(async () => {
    const cfg = defaultConfig("/tmp/faber-http-test");
    cfg.db_path = ":memory:";
    cfg.embed = { provider: "fake", model: "fake-embed" };
    cfg.enrich = { provider: "fake", model: "fake-enrich" };
    ctx = new AppContext(cfg);
    await seedDemo(ctx);
    server = startServer(ctx, { port: 0, log: () => {} });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as T };
  };

  test("status reports counts and providers", async () => {
    const { status, json } = await call<{ docs: number; providers: { ask: string }; embedder_ok: boolean }>("GET", "/api/status");
    expect(status).toBe(200);
    expect(json.docs).toBe(12);
    expect(json.providers.ask).toBe("fake/fake-enrich");
    expect(json.embedder_ok).toBe(true);
  });

  test("capture → needs content → post content → enriched → searchable", async () => {
    const cap = await call<CaptureResponse>("POST", "/api/capture", { url: GDOC, title: "Quokka migration plan - Google Docs" });
    expect(cap.status).toBe(200);
    expect(cap.json.needs_content).toBe(true);
    const id = cap.json.doc_id;

    const pending = await call<{ doc_id: string }[]>("GET", "/api/docs/pending-content?sources=gdoc&limit=50");
    expect(pending.json.map((p) => p.doc_id)).toContain(id);
    expect((await call<unknown[]>("GET", "/api/docs/pending-content?sources=")).json).toEqual([]);

    const posted = await call<{ changed: boolean }>("POST", `/api/docs/${id}/content`, { content: "Quokka migration: move the zebra cluster to Kubernetes." });
    expect(posted.json.changed).toBe(true);
    for (let i = 0; i < 50 && !(await call<Doc>("GET", `/api/docs/${id}`)).json.enrichment; i++) await Bun.sleep(20);

    const again = await call<CaptureResponse>("POST", "/api/capture", { url: GDOC.replace("/edit", "/view") });
    expect(again.json).toEqual({ doc_id: id, needs_content: false });

    const s = await call<SearchResponse>("POST", "/api/search", { q: "zebra cluster" });
    expect(s.json.hits[0]!.doc.id).toBe(id);
    const lookup = await call<Doc>("GET", `/api/docs/lookup?url=${encodeURIComponent(GDOC)}`);
    expect(lookup.json).toMatchObject({ id, title: "Quokka migration plan", visit_count: 2 });
  });

  test("capture with content (generic page) and a meeting link", async () => {
    const url = "https://wiki.example.com/team/oncall";
    const cap = await call<CaptureResponse>("POST", "/api/capture", {
      url,
      title: "On-call wiki",
      content: "Pager rotation for the platform team.",
      meeting: { title: "Platform weekly 10/3", url: "https://calendar.google.com/event?eid=1" },
    });
    expect(cap.json.needs_content).toBe(false);
    const doc = await call<DocDetail>("GET", `/api/docs/${cap.json.doc_id}`);
    expect(doc.json.has_content).toBe(true);
    expect(doc.json.meetings[0]!.title).toBe("Platform weekly 10/3");
  });

  test("add a bookmark by hand: with text, note, tags, pin and collection; re-adding updates", async () => {
    const coll = (await call<{ id: string }>("POST", "/api/collections", { name: "Manual adds" })).json;
    const url = "https://docs.google.com/document/d/1ManualAddAbcdefghijklmnopqr/edit";
    const r = await call<{ doc: Doc; created: boolean; needs_content: boolean }>("POST", "/api/docs", {
      url,
      title: "Hand-added plan",
      content: "The narwhal rollout plan for next quarter.",
      note: "from a colleague",
      tags: ["Hand Picked"],
      pinned: true,
      collection_id: coll.id,
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ created: true, needs_content: false });
    expect(r.json.doc).toMatchObject({ title: "Hand-added plan", note: "from a colleague", pinned: true, has_content: true });
    expect(r.json.doc.tags).toContainEqual({ tag: "hand-picked", source: "manual" });
    const detail = (await call<{ items: { doc: Doc }[] }>("GET", `/api/collections/${coll.id}`)).json;
    expect(detail.items.map((i) => i.doc.id)).toContain(r.json.doc.id);
    const again = await call<{ created: boolean; needs_content: boolean }>("POST", "/api/docs", { url: url.replace("/edit", "/view") });
    expect(again.json.created).toBe(false);
    const linkOnly = await call<{ needs_content: boolean }>("POST", "/api/docs", { url: "https://docs.google.com/document/d/1LinkOnlyAbcdefghijklmnopqrs/edit" });
    expect(linkOnly.json.needs_content).toBe(true);
    for (let i = 0; i < 50 && !(await call<Doc>("GET", `/api/docs/${r.json.doc.id}`)).json.enrichment; i++) await Bun.sleep(20);
    expect((await call<SearchResponse>("POST", "/api/search", { q: "narwhal rollout" })).json.hits[0]!.doc.id).toBe(r.json.doc.id);
    expect((await call("POST", "/api/docs", { url: "javascript:x" })).status).toBe(400);
    expect((await call("POST", "/api/docs", { url, tags: [""] })).status).toBe(400);
    expect((await call("POST", "/api/docs", { url, collection_id: "nope" })).status).toBe(404);
  });

  test("capture validation", async () => {
    expect((await call("POST", "/api/capture", { url: "javascript:alert(1)" })).status).toBe(400);
    expect((await call("POST", "/api/capture", {})).status).toBe(400);
    const bad = await fetch(base + "/api/capture", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
  });

  test("notes, pins, tags and their validation", async () => {
    const { json: hits } = await call<SearchResponse>("POST", "/api/search", { q: "rate limit design" });
    const id = hits.hits[0]!.doc.id;
    expect((await call<Doc>("PUT", `/api/docs/${id}/note`, { note: "  key doc  " })).json.note).toBe("key doc");
    expect((await call<Doc>("PUT", `/api/docs/${id}/note`, { note: "" })).json.note).toBeNull();
    expect((await call("PUT", `/api/docs/${id}/note`, { note: 5 })).status).toBe(400);
    expect((await call<Doc>("PUT", `/api/docs/${id}/pin`, { pinned: false })).json.pinned).toBe(false);
    expect((await call("PUT", `/api/docs/${id}/pin`, { pinned: "yes" })).status).toBe(400);
    const tagged = await call<Doc>("POST", `/api/docs/${id}/tags`, { tag: "Must Read" });
    expect(tagged.json.tags).toContainEqual({ tag: "must-read", source: "manual" });
    expect((await call<SearchResponse>("POST", "/api/search", { q: "", filters: { tag: ["must-read"] } })).json.hits[0]!.doc.id).toBe(id);
    expect((await call<Doc>("DELETE", `/api/docs/${id}/tags`, { tag: "must-read" })).json.tags).not.toContainEqual({ tag: "must-read", source: "manual" });
    expect((await call("POST", `/api/docs/${id}/tags`, { tag: "" })).status).toBe(400);
  });

  test("404 and 405 and re-enrich preconditions", async () => {
    expect((await call("GET", "/api/docs/nope")).status).toBe(404);
    expect((await call("GET", "/api/nope")).status).toBe(404);
    expect((await call("PATCH", "/api/status")).status).toBe(405);
    const empty = await call<CaptureResponse>("POST", "/api/capture", { url: "https://docs.google.com/document/d/1NoContentYetAbcdefghijklmnop/edit" });
    expect((await call("POST", `/api/docs/${empty.json.doc_id}/enrich`)).status).toBe(409);
  });

  test("cross-origin requests are refused", async () => {
    const evil = await call("GET", "/api/status", undefined, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const pre = await fetch(base + "/api/capture", { method: "OPTIONS", headers: { origin: "chrome-extension://abcdefghabcdefgh" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("extensions must be paired before they can read anything, and cannot approve themselves", async () => {
    const ext = { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" };
    const blocked = await call<{ code: string; extension_id: string }>("GET", "/api/status", undefined, ext);
    expect(blocked.status).toBe(403);
    expect(blocked.json).toMatchObject({ code: "pairing_required", extension_id: "abcdefghijklmnopabcdefghijklmnop" });
    expect(blocked.headers.get("access-control-allow-origin")).toBe(ext.origin);
    expect((await call("POST", "/api/search", { q: "pricing" }, ext)).status).toBe(403);
    expect((await call("POST", "/api/extensions/abcdefghijklmnopabcdefghijklmnop/approve", undefined, ext)).status).toBe(403);

    const list = (await call<{ id: string; state: string }[]>("GET", "/api/extensions")).json;
    expect(list).toContainEqual(expect.objectContaining({ id: "abcdefghijklmnopabcdefghijklmnop", state: "pending" }));
    expect((await call("POST", "/api/extensions/abcdefghijklmnopabcdefghijklmnop/approve")).status).toBe(200);
    const ok = await call("GET", "/api/status", undefined, ext);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ext.origin);

    // Reads sent the extension way (POST + x-faber-method: GET) are routed as GETs.
    const viaPost = await call<Settings>("POST", "/api/settings", undefined, { ...ext, "x-faber-method": "GET" });
    expect(viaPost.status).toBe(200);
    expect(Array.isArray(viaPost.json.watchlist)).toBe(true);

    expect((await call("DELETE", "/api/extensions/abcdefghijklmnopabcdefghijklmnop")).status).toBe(200);
    expect((await call("GET", "/api/status", undefined, ext)).status).toBe(403);
    expect((await call("POST", "/api/settings", undefined, { ...ext, "x-faber-method": "GET" })).status).toBe(403);
    expect((await call("POST", "/api/extensions/NOT_VALID!/approve")).status).toBe(400);
  });

  test("malformed input is a 400, oversized bodies a 413", async () => {
    expect((await call("GET", "/api/docs/%E0%A4%A")).status).toBe(400);
    expect((await call("POST", "/api/search", { q: "x", filters: { source: "gdoc" } })).status).toBe(400);
    expect((await call("POST", "/api/search", { q: "x", mode: "magic" })).status).toBe(400);
    expect((await call<SearchResponse>("POST", "/api/search", { q: "", limit: -1 })).json.hits.length).toBe(1);
    expect((await call("POST", "/api/search", { q: "", limit: "abc" })).status).toBe(200);
    const big = await fetch(base + "/api/capture", { method: "POST", body: "x".repeat(9 * 1024 * 1024) });
    expect(big.status).toBe(413);
    // Chunked upload with no Content-Length is cut off too.
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("y".repeat(1024 * 1024)));
        c.close();
      },
    });
    const chunked = await fetch(base + "/api/capture", { method: "POST", body: stream });
    expect(chunked.status).toBe(413);
    expect((await call("POST", "/api/ask", { question: "q", filters: { tag: "x" } })).status).toBe(400);
  });

  test("settings round trip and validation", async () => {
    const s = (await call<Settings>("GET", "/api/settings")).json;
    s.watchlist.find((r) => r.id === "gslides")!.enabled = true;
    s.watchlist.push({ id: "w1", label: "Wiki", pattern: "wiki.example.com", extractor: "generic", enabled: true, builtin: false });
    const saved = await call<Settings>("PUT", "/api/settings", s);
    expect(saved.status).toBe(200);
    expect(saved.json.watchlist.find((r) => r.id === "gslides")!.enabled).toBe(true);
    s.watchlist.push({ id: "w2", label: "Bad", pattern: "bad pattern", extractor: "generic", enabled: true, builtin: false });
    expect((await call("PUT", "/api/settings", s)).status).toBe(400);
  });

  test("the launcher hotkey saves through the API, and a bad one is a 400", async () => {
    const saved = await call<Settings>("PUT", "/api/settings", { shortcuts: { launcher: "cmd+shift+space" } });
    expect(saved.status).toBe(200);
    expect(saved.json.shortcuts.launcher).toBe("cmd+shift+space");
    const bad = await call<{ error: string }>("PUT", "/api/settings", { shortcuts: { launcher: "space" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("isn't a shortcut");
    expect((await call<Settings>("GET", "/api/settings")).json.shortcuts.launcher).toBe("cmd+shift+space");
  });

  test("collections: create, pin, export, import, delete", async () => {
    const c = (await call<{ id: string }>("POST", "/api/collections", { name: "HTTP test", query: { q: "postmortem" } })).json;
    const doc = (await call<SearchResponse>("POST", "/api/search", { q: "lunch interviews onboarding" })).json.hits[0]!.doc;
    expect((await call("PUT", `/api/collections/${c.id}/docs/${doc.id}`, { state: "pin" })).status).toBe(200);
    expect((await call("PUT", `/api/collections/${c.id}/docs/${doc.id}`, { state: "query" })).status).toBe(400);
    const detail = (await call<{ items: { state: string }[] }>("GET", `/api/collections/${c.id}`)).json;
    expect(detail.items[0]!.state).toBe("pin");
    expect(detail.items.some((i) => i.state === "query")).toBe(true);
    const file = (await call<CollectionExport>("GET", `/api/collections/${c.id}/export`)).json;
    expect(file.format).toBe("faber/collection");
    expect((await call("DELETE", `/api/collections/${c.id}`)).status).toBe(200);
    expect((await call("GET", `/api/collections/${c.id}`)).status).toBe(404);
    const imp = await call<{ collection_id: string; items: number }>("POST", "/api/collections/import", file);
    expect(imp.json).toMatchObject({ collection_id: c.id, items: file.items.length });
    expect((await call("POST", "/api/collections/import", { format: "x" })).status).toBe(400);
    expect((await call("POST", "/api/collections", { name: "" })).status).toBe(400);
  });

  test("people, meetings, facets, related, digest, ask", async () => {
    const people = (await call<{ id: string; name: string }[]>("GET", "/api/people")).json;
    expect(people.map((p) => p.name)).toContain("Maya Chen");
    const maya = (await call<{ docs: unknown[] }>("GET", `/api/people/${people.find((p) => p.name === "Maya Chen")!.id}`)).json;
    expect(maya.docs.length).toBeGreaterThan(2);
    const meetings = (await call<{ id: string; title: string; doc_count: number }[]>("GET", "/api/meetings")).json;
    const growth = meetings.find((m) => m.title === "Growth weekly")!;
    expect(growth.doc_count).toBe(3);
    expect(((await call<{ docs: unknown[] }>("GET", `/api/meetings/${growth.id}`)).json.docs).length).toBe(3);
    const facets = (await call<{ tags: unknown[] }>("GET", "/api/facets")).json;
    expect(facets.tags.length).toBeGreaterThan(0);
    const okrs = (await call<SearchResponse>("POST", "/api/search", { q: "Growth Q3 OKRs" })).json.hits[0]!.doc;
    const related = (await call<{ reasons: string[] }[]>("GET", `/api/docs/${okrs.id}/related`)).json;
    expect(related.some((r) => r.reasons.some((x) => x.includes("Growth weekly")))).toBe(true);
    const digest = (await call<{ recent: unknown[]; resurfacing: unknown[] }>("GET", "/api/digest")).json;
    expect(digest.recent.length).toBeGreaterThan(0);
    expect(digest.resurfacing.length).toBeGreaterThan(0);
    const answer = (await call<{ answer: string; citations: unknown[] }>("POST", "/api/ask", { question: "what blocked the frankfurt launch" })).json;
    expect(answer.citations.length).toBeGreaterThan(0);
    expect((await call("POST", "/api/ask", { question: "" })).status).toBe(400);
  });

  test("a second daemon on the same port fails instead of sharing it", () => {
    expect(() => startServer(ctx, { port: server.port, log: () => {} })).toThrow();
  });

  test("status reports config path and an issues list", async () => {
    const st = (await call<{ config_path: string; issues: string[]; enricher_ok: boolean }>("GET", "/api/status")).json;
    expect(st.config_path).toEndWith("config.toml");
    expect(st.issues).toEqual([]);
    expect(st.enricher_ok).toBe(true);
  });

  test("captures ignore implausible timestamps and null bodies are 400", async () => {
    const cap = (await call<CaptureResponse>("POST", "/api/capture", { url: "https://example.com/future", ts: 1e308 })).json;
    const doc = (await call<Doc>("GET", `/api/docs/${cap.doc_id}`)).json;
    expect(doc.last_seen_at).toBeLessThanOrEqual(Date.now());
    const nul = await fetch(base + "/api/capture", { method: "POST", body: "null" });
    expect(nul.status).toBe(400);
  });

  test("scoped facets via POST", async () => {
    const f = (await call<{ source: { value: string; count: number }[] }>("POST", "/api/facets", { q: "postmortem gateway outage" })).json;
    const total = f.source.reduce((n, x) => n + x.count, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(12);
  });

  test("delete forgets the doc everywhere", async () => {
    const cap = (await call<CaptureResponse>("POST", "/api/capture", { url: "https://example.com/forget", content: "forgettable walrus" })).json;
    for (let i = 0; i < 50 && ctx.index.vectorsFor(cap.doc_id).length === 0; i++) await Bun.sleep(20);
    expect((await call("DELETE", `/api/docs/${cap.doc_id}`)).status).toBe(200);
    expect((await call("GET", `/api/docs/${cap.doc_id}`)).status).toBe(404);
    expect(ctx.index.vectorsFor(cap.doc_id)).toEqual([]);
    expect((await call<SearchResponse>("POST", "/api/search", { q: "walrus" })).json.hits).toEqual([]);
  });
});
