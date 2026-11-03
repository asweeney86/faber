import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultConfig, recordVisit } from "@faber/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppContext } from "../src/context";
import { startServer } from "../src/server";

describe("opens and browse order over HTTP", () => {
  let home: string;
  let ctx: AppContext;
  let server: ReturnType<typeof startServer>;
  let base: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "faber-open-"));
    const cfg = defaultConfig(home);
    cfg.db_path = ":memory:";
    cfg.embed = { provider: "fake", model: "fake-embed" };
    cfg.enrich = { provider: "fake", model: "fake-enrich" };
    cfg.privacy.favicons = false;
    ctx = new AppContext(cfg);
    server = startServer(ctx, { port: 0, autoEnrich: false, log: () => {} });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
    ctx.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("opening a doc from Faber is recorded, and sort is validated", async () => {
    const page = recordVisit(ctx.db, { url: "https://news.example.org/story/43", title: "Another" }).row;
    const before = page.visit_count;
    expect((await fetch(`${base}/api/docs/${page.id}/open`, { method: "POST" })).status).toBe(200);
    const doc = (await (await fetch(`${base}/api/docs/${page.id}`)).json()) as { visit_count: number };
    expect(doc.visit_count).toBe(before + 1);
    expect((await fetch(`${base}/api/docs/nope/open`, { method: "POST" })).status).toBe(404);

    const post = (body: unknown) => fetch(`${base}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ q: "", sort: "random" })).status).toBe(400);
    expect((await post({ q: "", sort: "recent" })).status).toBe(200);
  });
});
