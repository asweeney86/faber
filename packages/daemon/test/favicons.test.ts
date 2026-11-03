import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultConfig, recordVisit } from "@faber/core";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppContext } from "../src/context";
import { Favicons, iconLinks, sniffImage, type Fetcher } from "../src/favicons";
import { startServer } from "../src/server";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 1, 0, 16, 16]);

/** A pretend internet: a few sites, and a log of what was asked for. */
function fakeWeb(pages: Record<string, { type: string; body: string | Uint8Array; status?: number }>) {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    const p = pages[url];
    if (!p) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(p.body, { status: p.status ?? 200, headers: { "content-type": p.type } });
  };
  return { fetcher, asked };
}

describe("finding a site's icon", () => {
  test("link tags: SVG first, then a small PNG, then apple-touch; relative URLs resolve", () => {
    const html = `<html><head>
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" sizes="192x192" href="/big.png">
      <link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
      <link href='/icon.svg' rel='icon' type='image/svg+xml'>
      <link rel="stylesheet" href="/x.css">
    </head><body><link rel="icon" href="/body.png"></body></html>`;
    expect(iconLinks(html, "https://example.com/docs/page")).toEqual([
      "https://example.com/icon.svg",
      "https://example.com/docs/favicon-32.png",
      "https://example.com/big.png",
      "https://example.com/apple.png",
    ]);
    expect(iconLinks(`<link rel="icon" href="javascript:alert(1)">`, "https://example.com/")).toEqual([]);
  });

  test("images are recognised by their bytes, not the server's word", () => {
    expect(sniffImage(PNG, "text/html")).toBe("image/png");
    expect(sniffImage(ICO, null)).toBe("image/x-icon");
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml")).toBe("image/svg+xml");
    expect(sniffImage(new TextEncoder().encode("<!doctype html><title>404</title>"), "image/x-icon")).toBeNull();
  });

  test("fetches from the site itself once, caches it, and remembers sites without one", async () => {
    const home = mkdtempSync(join(tmpdir(), "faber-fav-"));
    try {
      const web = fakeWeb({
        "https://blog.example.com/": { type: "text/html", body: `<head><link rel="icon" href="/static/fav.png"></head>` },
        "https://blog.example.com/static/fav.png": { type: "image/png", body: PNG },
        "https://plain.example.com/favicon.ico": { type: "image/x-icon", body: ICO },
      });
      const fav = new Favicons(home, web.fetcher);
      const [a, b] = await Promise.all([fav.get("https://blog.example.com/posts/1"), fav.get("https://blog.example.com/posts/2")]);
      expect(a).toEqual({ type: "image/png", bytes: PNG });
      expect(b).toEqual(a);
      expect(web.asked.filter((u) => u.startsWith("https://blog.example.com"))).toEqual(["https://blog.example.com/", "https://blog.example.com/static/fav.png"]);

      expect((await fav.get("https://plain.example.com/a"))?.type).toBe("image/x-icon");
      expect(await fav.get("https://none.example.com/a")).toBeNull();

      // A new instance (a daemon restart) reads the cache instead of asking again.
      web.asked.length = 0;
      const again = new Favicons(home, web.fetcher);
      expect(await again.get("https://blog.example.com/x")).toEqual(a);
      expect(await again.get("https://none.example.com/b")).toBeNull();
      expect(web.asked).toEqual([]);
      expect(existsSync(join(home, "favicons", "blog.example.com.icon"))).toBe(true);

      expect(await fav.get("file:///etc/passwd")).toBeNull();
      expect(await fav.get("not a url")).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("GET /api/docs/:id/favicon", () => {
  let home: string;
  let ctx: AppContext;
  let server: ReturnType<typeof startServer>;
  let base: string;
  const web = fakeWeb({ "https://news.example.org/favicon.ico": { type: "image/x-icon", body: ICO } });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "faber-fav-api-"));
    const cfg = defaultConfig(home);
    cfg.db_path = ":memory:";
    cfg.embed = { provider: "fake", model: "fake-embed" };
    cfg.enrich = { provider: "fake", model: "fake-enrich" };
    ctx = new AppContext(cfg);
    server = startServer(ctx, { port: 0, autoEnrich: false, log: () => {}, fetchFavicon: web.fetcher });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
    ctx.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("serves the site's icon for web pages in the library, and nothing for other docs", async () => {
    const page = recordVisit(ctx.db, { url: "https://news.example.org/story/42", title: "A story" }).row;
    const res = await fetch(`${base}/api/docs/${page.id}/favicon`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ICO);

    const gdoc = recordVisit(ctx.db, { url: "https://docs.google.com/document/d/1FavTestAbcdefghijklmnopqrstuv/edit", title: "Doc" }).row;
    expect((await fetch(`${base}/api/docs/${gdoc.id}/favicon`)).status).toBe(204);
    expect((await fetch(`${base}/api/docs/nope/favicon`)).status).toBe(404);
    // Another website can't use the daemon to fetch things.
    expect((await fetch(`${base}/api/docs/${page.id}/favicon`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(web.asked.every((u) => u.startsWith("https://news.example.org/"))).toBe(true);
  });
});
