import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiRequestError, PbClient } from "./client";

/** PbClient against a recording fake fetch. */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: Call[];
let respond: (c: Call) => Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => Response.json({ ok: true });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body == null ? undefined : String(init.body),
    };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const last = () => calls.at(-1)!;

describe("identifyReads", () => {
  test("off (the web app): GETs are plain GETs without the override header", async () => {
    const c = new PbClient("http://127.0.0.1:7777");
    await c.status();
    expect(last()).toMatchObject({ url: "http://127.0.0.1:7777/api/status", method: "GET", body: undefined });
    expect(last().headers["x-faber-method"]).toBeUndefined();
    expect(last().headers["content-type"]).toBeUndefined();
  });

  test("on (the extension): every read becomes POST + x-faber-method: GET, with no body", async () => {
    const c = new PbClient("http://127.0.0.1:7777", { identifyReads: true });
    const reads: [() => Promise<unknown>, string][] = [
      [c.status, "/api/status"],
      [c.settings, "/api/settings"],
      [c.projects, "/api/projects"],
      [() => c.project("atlas"), "/api/projects/atlas"],
      [c.overview, "/api/overview"],
      [c.digest, "/api/digest"],
      [c.collections, "/api/collections"],
      [c.people, "/api/people"],
      [() => c.facets(), "/api/facets"],
      [() => c.related("d1"), "/api/docs/d1/related"],
      [() => c.pendingContent(["gdoc", "gslides"], 3), "/api/docs/pending-content?limit=3&sources=gdoc,gslides"],
    ];
    for (const [fn, path] of reads) {
      await fn();
      expect(last()).toMatchObject({ url: `http://127.0.0.1:7777${path}`, method: "POST", body: undefined });
      expect(last().headers["x-faber-method"]).toBe("GET");
      expect(last().headers["content-type"]).toBeUndefined();
    }
  });

  test("on: writes keep their method and carry no override header", async () => {
    const c = new PbClient("http://h", { identifyReads: true });
    const writes: [() => Promise<unknown>, string, string][] = [
      [() => c.saveSettings({ appearance: { theme: "latte", dark_flavor: "mocha", accent: "teal", density: "compact" } }), "PUT", "/api/settings"],
      [() => c.search({ q: "x" }), "POST", "/api/search"],
      [() => c.facets({ q: "x" }), "POST", "/api/facets"],
      [() => c.setPinned("d1", true), "PUT", "/api/docs/d1/pin"],
      [() => c.removeTag("d1", "t"), "DELETE", "/api/docs/d1/tags"],
      [() => c.deleteDoc("d1"), "DELETE", "/api/docs/d1"],
      [() => c.reenrich("d1"), "POST", "/api/docs/d1/enrich"],
    ];
    for (const [fn, method, path] of writes) {
      await fn();
      expect(last()).toMatchObject({ method, url: `http://h${path}` });
      expect(last().headers["x-faber-method"]).toBeUndefined();
    }
    // Bodies are JSON with a content type; body-less writes have neither.
    await c.saveSettings({ watchlist: [] });
    expect(last().headers["content-type"]).toBe("application/json");
    expect(JSON.parse(last().body!)).toEqual({ watchlist: [] });
    await c.reenrich("d1");
    expect(last().body).toBeUndefined();
    expect(last().headers["content-type"]).toBeUndefined();
  });

  test("lookup still maps 404 to null when reads are identified", async () => {
    const c = new PbClient("http://h", { identifyReads: true });
    respond = () => Response.json({ error: "not found" }, { status: 404 });
    expect(await c.lookup("https://example.com/a?b=1&c=2")).toBeNull();
    expect(last().method).toBe("POST");
    expect(last().url).toBe(`http://h/api/docs/lookup?url=${encodeURIComponent("https://example.com/a?b=1&c=2")}`);
  });
});

describe("URLs", () => {
  test("a trailing slash on the base URL is dropped; an empty base is same-origin", async () => {
    await new PbClient("http://127.0.0.1:7777/").status();
    expect(last().url).toBe("http://127.0.0.1:7777/api/status");
    await new PbClient().status();
    expect(last().url).toBe("/api/status");
  });

  test("project ids are encoded into one path segment", async () => {
    const c = new PbClient("http://h");
    await c.project("zürich-launch");
    expect(last().url).toBe("http://h/api/projects/z%C3%BCrich-launch");
    await c.project("a/b?c#d");
    expect(last().url).toBe("http://h/api/projects/a%2Fb%3Fc%23d");
    await c.project("東京");
    expect(decodeURIComponent(last().url.split("/").at(-1)!)).toBe("東京");
  });
});

describe("errors", () => {
  test("daemon JSON errors keep their message and code; pairing is recognised", async () => {
    const c = new PbClient("http://h", { identifyReads: true });
    respond = () => Response.json({ error: "approve me", code: "pairing_required", extension_id: "abc" }, { status: 403 });
    const err = await c.settings().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    const e = err as ApiRequestError;
    expect([e.status, e.message, e.code, e.pairingRequired, e.name]).toEqual([403, "approve me", "pairing_required", true, "ApiRequestError"]);
  });

  test("a 403 without the pairing code is not a pairing error", async () => {
    respond = () => Response.json({ error: "forbidden: origin x not allowed" }, { status: 403 });
    const e = (await new PbClient("http://h").status().catch((x: unknown) => x)) as ApiRequestError;
    expect(e.pairingRequired).toBe(false);
    expect(e.message).toBe("forbidden: origin x not allowed");
  });

  test("non-JSON error bodies fall back to the status line", async () => {
    respond = () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
    const e = (await new PbClient("http://h").overview().catch((x: unknown) => x)) as ApiRequestError;
    expect(e.status).toBe(502);
    expect(e.message).toBe("502 Bad Gateway");
    expect(e.code).toBeUndefined();
  });

  test("lookup rethrows anything that isn't a 404", async () => {
    respond = () => Response.json({ error: "boom" }, { status: 500 });
    await expect(new PbClient("http://h").lookup("https://x.example")).rejects.toThrow("boom");
  });

  test("network failures propagate unchanged", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(new PbClient("http://h", { identifyReads: true }).projects()).rejects.toThrow("Failed to fetch");
  });
});
