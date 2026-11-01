import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultConfig, FakeEmbedder, FakeEnricher, recordVisit, runQueue, setContent, VectorIndex } from "@faber/core";
import type { ModelsState } from "@faber/shared";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppContext } from "../src/context";
import { ModelChangeError, ModelManager } from "../src/models";
import { startServer } from "../src/server";

/** A stand-in for Ollama: lists models, "downloads" them, and embeds text. */
function fakeOllama() {
  const models = new Set(["qwen3:4b", "qwen3-embedding:latest", "qwen3-embedding:0.6b"]);
  const embedded: string[] = [];
  let failNext = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/tags") return Response.json({ models: [...models].map((name) => ({ name })) });
      if (path === "/api/pull") {
        const { model } = (await req.json()) as { model: string };
        if (failNext) {
          failNext = false;
          return new Response(`${JSON.stringify({ error: "pull model manifest: file does not exist" })}\n`);
        }
        const lines = [{ status: "pulling manifest" }, { status: "downloading", total: 100, completed: 50 }, { status: "downloading", total: 100, completed: 100 }, { status: "success" }];
        const body = new ReadableStream({
          async start(c) {
            for (const l of lines) {
              c.enqueue(new TextEncoder().encode(`${JSON.stringify(l)}\n`));
              await Bun.sleep(20);
            }
            models.add(model);
            c.close();
          },
        });
        return new Response(body);
      }
      if (path === "/api/embed") {
        const { input } = (await req.json()) as { input: string[] };
        embedded.push(...input);
        return Response.json({ embeddings: input.map((t) => Array.from({ length: 8 }, (_, i) => Math.sin(t.length + i))) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, models, embedded, failPull: () => (failNext = true), stop: () => server.stop(true) };
}

describe("choosing models", () => {
  let ollama: ReturnType<typeof fakeOllama>;
  let home: string;
  let ctx: AppContext;

  beforeAll(async () => {
    ollama = fakeOllama();
    home = mkdtempSync(join(tmpdir(), "faber-models-"));
    const cfg = defaultConfig(home);
    cfg.db_path = ":memory:";
    cfg.enrich = { provider: "ollama", model: "qwen3:4b", base_url: ollama.url };
    cfg.embed = { provider: "ollama", model: "qwen3-embedding", base_url: ollama.url };
    writeFileSync(join(home, "config.toml"), `[enrich]\nprovider = "ollama"\nmodel = "qwen3:4b"\n\n[embed] # search\nprovider = "ollama"\nmodel = "qwen3-embedding"\n`);
    ctx = new AppContext(cfg);
    // Two documents enriched earlier (by other models), as on an existing install.
    const deps = { db: ctx.db, cfg, enricher: new FakeEnricher(), embedder: new FakeEmbedder(), index: new VectorIndex("fake-embed") };
    for (const n of [1, 2]) {
      const { row } = recordVisit(ctx.db, { url: `https://wiki.example.com/doc-${n}`, title: `Doc ${n}` });
      setContent(ctx.db, row.id, `Notes for Project Atlas, part ${n}. The rollout plan is written down here.`, { title: `Doc ${n}` });
    }
    await runQueue(deps);
  });
  afterAll(() => {
    ollama.stop();
    ctx.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("shows what's in use, the choices, and what's downloaded", async () => {
    const s = await new ModelManager(ctx).state();
    expect(s.ollama_reachable).toBe(true);
    expect(s.enrich).toMatchObject({ provider: "ollama", model: "qwen3:4b", editable: true, installed: true });
    expect(s.enrich.choices.map((c) => [c.id, c.installed])).toEqual([
      ["qwen3:4b", true],
      ["qwen3:8b", false],
    ]);
    expect(s.embed.choices.find((c) => c.id === "qwen3-embedding")?.installed).toBe(true); // pulled as :latest
    expect(s.summaries_from_other_models).toBe(2);
    expect(s.reindex_remaining).toBe(2); // their vectors came from another model
  });

  test("a downloaded model is switched to at once, and saved to config.toml", async () => {
    const m = new ModelManager(ctx);
    const before = ctx.enricher;
    await (await m.change({ kind: "embed", model: "qwen3-embedding:0.6b" })).done;
    expect(ctx.cfg.embed.model).toBe("qwen3-embedding:0.6b");
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml).toContain('[embed] # search\nprovider = "ollama"\nmodel = "qwen3-embedding:0.6b"');
    expect(toml).toContain('model = "qwen3:4b"'); // the other section is untouched
    expect(ctx.embedder.model).toBe("qwen3-embedding:0.6b");
    expect(ctx.enricher).toBe(before);
  });

  test("a missing model is downloaded first, with progress, then switched to", async () => {
    const m = new ModelManager(ctx);
    const { done } = await m.change({ kind: "enrich", model: "qwen3:8b" });
    expect((await m.state()).pull).toMatchObject({ kind: "enrich", model: "qwen3:8b", error: null });
    expect(ctx.cfg.enrich.model).toBe("qwen3:4b"); // not yet
    await expect(m.change({ kind: "embed", model: "qwen3-embedding" })).rejects.toThrow("Still downloading");
    await done;
    const s = await m.state();
    expect(s.pull).toBeNull();
    expect(s.enrich).toMatchObject({ model: "qwen3:8b", installed: true });
    expect(ctx.enricher.model).toBe("qwen3:8b");
  });

  test("a failed download says why and leaves the model alone", async () => {
    const m = new ModelManager(ctx);
    ollama.failPull();
    await (await m.change({ kind: "enrich", model: "no-such-model:1b" })).done;
    const s = await m.state();
    expect(s.pull?.error).toContain("file does not exist");
    expect(s.enrich.model).toBe("qwen3:8b");
    m.dismissPullError();
    expect((await m.state()).pull).toBeNull();
  });

  test("bad names and non-local providers are refused", async () => {
    const m = new ModelManager(ctx);
    await expect(m.change({ kind: "enrich", model: "rm -rf /" })).rejects.toBeInstanceOf(ModelChangeError);
    await expect(m.change({ kind: "nope" as "enrich", model: "qwen3:4b" })).rejects.toBeInstanceOf(ModelChangeError);
    ctx.cfg.enrich.provider = "anthropic";
    try {
      await expect(m.change({ kind: "enrich", model: "qwen3:4b" })).rejects.toThrow("config.toml");
      expect((await m.state()).enrich.editable).toBe(false);
    } finally {
      ctx.cfg.enrich.provider = "ollama";
    }
  });
});

describe("the models API", () => {
  let ollama: ReturnType<typeof fakeOllama>;
  let home: string;
  let ctx: AppContext;
  let server: ReturnType<typeof startServer>;
  let base: string;
  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as T };
  };

  beforeAll(async () => {
    ollama = fakeOllama();
    home = mkdtempSync(join(tmpdir(), "faber-models-api-"));
    const cfg = defaultConfig(home);
    cfg.db_path = ":memory:";
    cfg.enrich = { provider: "fake", model: "fake-enrich" };
    cfg.embed = { provider: "ollama", model: "qwen3-embedding", base_url: ollama.url };
    writeFileSync(join(home, "config.toml"), `[embed]\nmodel = "qwen3-embedding"\n`);
    ctx = new AppContext(cfg);
    for (const n of [1, 2, 3]) {
      const { row } = recordVisit(ctx.db, { url: `https://wiki.example.com/api-${n}`, title: `API doc ${n}` });
      setContent(ctx.db, row.id, `Frankfurt launch checklist, item ${n}. Data residency sign-off is pending.`, { title: `API doc ${n}` });
    }
    server = startServer(ctx, { port: 0, tickMs: 100, log: () => {} });
    base = `http://127.0.0.1:${server.port}`;
    await Bun.sleep(300); // the queue enriches (fake) and embeds (fake Ollama)
  });
  afterAll(() => {
    server.stop(true);
    ollama.stop();
    ctx.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("switching the search model re-indexes every document in the background, without the LLM", async () => {
    expect((await call<ModelsState>("GET", "/api/models")).json.reindex_remaining).toBe(0);
    ollama.embedded.length = 0;
    const r = await call<ModelsState>("PUT", "/api/models", { kind: "embed", model: "qwen3-embedding:0.6b" });
    expect(r.status).toBe(200);
    expect(r.json.embed.model).toBe("qwen3-embedding:0.6b");
    for (let i = 0; i < 50 && (await call<ModelsState>("GET", "/api/models")).json.reindex_remaining > 0; i++) await Bun.sleep(100);
    expect((await call<ModelsState>("GET", "/api/models")).json.reindex_remaining).toBe(0);
    expect(ollama.embedded.some((t) => t.includes("Frankfurt launch checklist"))).toBe(true);
    const n = ctx.db.query<{ n: number }, [string]>(`SELECT COUNT(DISTINCT doc_id) n FROM chunks WHERE embed_model = ?`).get("qwen3-embedding:0.6b")!.n;
    expect(n).toBe(3);
    // Summaries were reused: still one enrichment per doc.
    expect(ctx.db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM enrichments`).get()!.n).toBe(3);
  });

  test("models are the user's to change: not an extension's, and not with a bad name", async () => {
    const ext = { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" };
    expect((await call("PUT", "/api/models", { kind: "embed", model: "qwen3-embedding" }, ext)).status).toBe(403);
    const bad = await call<{ error: string }>("PUT", "/api/models", { kind: "embed", model: "../../etc" });
    expect(bad.status).toBe(400);
    const fixed = await call<{ error: string }>("PUT", "/api/models", { kind: "enrich", model: "qwen3:4b" });
    expect(fixed.status).toBe(400);
    expect(fixed.json.error).toContain("config.toml");
  });

  test("re-summarise queues documents whose summary came from another model", async () => {
    ctx.cfg.enrich.model = "fake-enrich-2";
    try {
      const r = await call<{ queued: number }>("POST", "/api/models/resummarise");
      expect(r.json.queued).toBe(3);
    } finally {
      ctx.cfg.enrich.model = "fake-enrich";
    }
  });
});
