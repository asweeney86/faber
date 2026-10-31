import { describe, expect, test } from "bun:test";
import type { Doc } from "@faber/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LookupCache, iconPaths, isLookupUrl, statusFor, type IconState, type LookupResult } from "./tabstate";

const doc = (over: Partial<Doc> = {}): Doc => ({
  id: "d1",
  source: "gdoc",
  canonical_url: "https://docs.google.com/document/d/x/edit",
  external_id: "x",
  title: "Rate limits",
  has_content: true,
  content_fetched_at: 1,
  content_error: null,
  first_seen_at: 1,
  last_seen_at: 1,
  visit_count: 5,
  pinned: false,
  note: null,
  tags: [],
  enrichment: null,
  queue_status: null,
  ...over,
} as Doc);

describe("statusFor", () => {
  test("saved doc: filled icon, visits and type in the title", () => {
    const enrichment = { doc_type: "design_doc" } as Doc["enrichment"];
    expect(statusFor({ kind: "doc", doc: doc({ enrichment }) })).toEqual({
      state: "saved",
      title: "Saved in Faber · opened 5× · Design doc",
    });
  });

  test("pinned doc: pinned icon and the title says so", () => {
    const s = statusFor({ kind: "doc", doc: doc({ pinned: true, visit_count: 1 }) });
    expect(s.state).toBe("pinned");
    expect(s.title).toBe("Saved in Faber · opened 1× · Pinned");
  });

  test("not saved: outline icon inviting a save", () => {
    expect(statusFor({ kind: "missing" })).toEqual({ state: "unsaved", title: "Not saved — click to save" });
  });

  test.each([
    ["offline", /daemon offline/],
    ["unpaired", /needs approval/],
    ["no-access", /Show saved status on every site/],
    ["not-web", /^Faber$/],
  ] as const)("%s: neutral icon with an explanation", (kind, re) => {
    const s = statusFor({ kind } as LookupResult);
    expect(s.state).toBe("unknown");
    expect(s.title).toMatch(re);
  });
});

describe("iconPaths", () => {
  test.each(["saved", "pinned", "unsaved", "unknown"] as IconState[])("%s points at generated 16/32px PNGs", (state) => {
    const p = iconPaths(state);
    expect(p).toEqual({ "16": `icons/action-${state}-16.png`, "32": `icons/action-${state}-32.png` });
    for (const f of Object.values(p)) expect(existsSync(join(import.meta.dir, "../../static", f))).toBe(true);
  });
});

describe("isLookupUrl", () => {
  test("only http(s) pages are looked up", () => {
    expect(isLookupUrl("https://wiki.example.com/a")).toBe(true);
    expect(isLookupUrl("http://127.0.0.1:8080/")).toBe(true);
    for (const bad of [undefined, "", "chrome://newtab", "file:///x", "about:blank", "chrome-extension://abc/popup.html", "junk"]) {
      expect(isLookupUrl(bad)).toBe(false);
    }
  });
});

describe("LookupCache", () => {
  const setup = () => {
    let t = 0;
    const cache = new LookupCache(30_000, () => t);
    let calls = 0;
    const fetcher = (r: LookupResult) => async () => {
      calls++;
      return r;
    };
    return { cache, fetcher, advance: (ms: number) => (t += ms), calls: () => calls };
  };

  test("caches definite answers for the TTL", async () => {
    const { cache, fetcher, advance, calls } = setup();
    await cache.get("k", fetcher({ kind: "missing" }));
    advance(29_999);
    expect(await cache.get("k", fetcher({ kind: "doc", doc: doc() }))).toEqual({ kind: "missing" });
    expect(calls()).toBe(1);
    advance(1);
    expect((await cache.get("k", fetcher({ kind: "doc", doc: doc() }))).kind).toBe("doc");
    expect(calls()).toBe(2);
  });

  test("de-duplicates concurrent lookups for the same URL", async () => {
    const { cache } = setup();
    let calls = 0;
    let resolve!: (r: LookupResult) => void;
    const slow = () => {
      calls++;
      return new Promise<LookupResult>((r) => (resolve = r));
    };
    const a = cache.get("k", slow);
    const b = cache.get("k", slow);
    resolve({ kind: "missing" });
    expect(await a).toEqual({ kind: "missing" });
    expect(await b).toEqual({ kind: "missing" });
    expect(calls).toBe(1);
  });

  test("does not cache offline or unpaired answers", async () => {
    const { cache, fetcher, calls } = setup();
    await cache.get("k", fetcher({ kind: "offline" }));
    await cache.get("k", fetcher({ kind: "unpaired" }));
    await cache.get("k", fetcher({ kind: "missing" }));
    expect(calls()).toBe(3);
  });

  test("invalidate forces a fresh lookup (after save/pin/tag)", async () => {
    const { cache, fetcher, calls } = setup();
    await cache.get("k", fetcher({ kind: "missing" }));
    cache.invalidate("k");
    expect((await cache.get("k", fetcher({ kind: "doc", doc: doc() }))).kind).toBe("doc");
    expect(calls()).toBe(2);
  });

  test("a failed fetch is not cached and does not wedge the key", async () => {
    const { cache } = setup();
    await expect(cache.get("k", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await cache.get("k", async () => ({ kind: "missing" }))).toEqual({ kind: "missing" });
  });
});
