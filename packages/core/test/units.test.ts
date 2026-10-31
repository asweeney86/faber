import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_TOML, defaultConfig, isLocalUrl, migrateLegacyHome, resolveApiKey } from "../src/config";
import { coerceEnrichment } from "../src/enrich/schema";
import { priorityFor } from "../src/enrich/queue";
import { makeChat, makeEmbedder, makeEnricher, RemoteProviderRefused } from "../src/providers";
import { extractJsonObject, stripThinking } from "../src/providers/types";
import { FakeEmbedder } from "../src/providers/fake";
import { chunkText } from "../src/search/chunk";
import { toFtsQuery } from "../src/search/hybrid";
import { VectorIndex } from "../src/search/vectors";
import { seriesKey } from "../src/meetings";
import { testConfig } from "./helpers";

describe("chunkText", () => {
  test("empty text gives no chunks", () => {
    expect(chunkText("  \n\n ", 100, 10)).toEqual([]);
  });

  test("packs paragraphs up to the chunk size and respects the cap", () => {
    const paras = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} ${"x".repeat(80)}`).join("\n\n");
    const chunks = chunkText(paras, 300, 5);
    expect(chunks.length).toBe(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    expect(chunks[0]).toStartWith("Paragraph 0");
  });

  test("hard-splits a single huge paragraph (CSV dumps) with a fixed overlap", () => {
    const text = "abcdefghij".repeat(600);
    const chunks = chunkText(text, 500, 100);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    // stride = 500 - 75 overlap
    expect(chunks.length).toBe(Math.ceil((text.length - 500) / 425) + 1);
    expect(chunks[1]!.slice(0, 75)).toBe(chunks[0]!.slice(-75));
  });
});

describe("coerceEnrichment", () => {
  const base = {
    summary: " A doc. ",
    doc_type: "design_doc",
    written_at: "2026-04-14T00:00:00Z",
    projects: ["Atlas", "Atlas", " "],
    people: ["Maya Chen"],
    teams: [],
    tags: ["Rate Limits", "pricing", "pricing"],
    confidence: 0.8,
  };

  test("trims, dedupes, normalises tags and dates", () => {
    const e = coerceEnrichment(base);
    expect(e.summary).toBe("A doc.");
    expect(e.projects).toEqual(["Atlas"]);
    expect(e.tags).toEqual(["rate-limits", "pricing"]);
    expect(e.written_at).toBe("2026-04-14");
  });

  test("normalises partial dates and rejects junk dates", () => {
    expect(coerceEnrichment({ ...base, written_at: "2025-07" }).written_at).toBe("2025-07");
    expect(coerceEnrichment({ ...base, written_at: "2025" }).written_at).toBe("2025-01");
    expect(coerceEnrichment({ ...base, written_at: "last spring" }).written_at).toBeNull();
  });

  test("throws on schema violations", () => {
    expect(() => coerceEnrichment({ ...base, doc_type: "novel" })).toThrow();
    expect(() => coerceEnrichment({ ...base, confidence: 3 })).toThrow();
  });
});

describe("model output helpers", () => {
  test("extractJsonObject finds JSON in prose and fences", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! {"a": {"b": 2}} hope that helps')).toEqual({ a: { b: 2 } });
    expect(() => extractJsonObject("no json here")).toThrow();
  });

  test("stripThinking removes a leading think block", () => {
    expect(stripThinking("<think>hmm</think>\n\nAnswer [1]")).toBe("Answer [1]");
    expect(stripThinking("Answer")).toBe("Answer");
  });
});

describe("config and privacy guard", () => {
  test("defaults are local Qwen with remote providers blocked", () => {
    const cfg = defaultConfig("/tmp/x");
    expect(cfg.enrich).toMatchObject({ provider: "ollama", model: "qwen3:8b" });
    expect(cfg.embed).toMatchObject({ provider: "ollama", model: "qwen3-embedding" });
    expect(cfg.privacy.allow_remote).toBe(false);
    expect(cfg.daemon.allowed_extension_ids).toEqual([]);
  });

  test("remote providers are refused unless allow_remote is set", () => {
    const cfg = testConfig({ enrich: { provider: "anthropic", model: "claude-opus-5-5" } });
    expect(() => makeEnricher(cfg)).toThrow(RemoteProviderRefused);
    expect(() => makeChat(cfg)).toThrow(RemoteProviderRefused);
    const remoteOllama = testConfig({ embed: { provider: "ollama", model: "m", base_url: "http://gpu-box:11434" } });
    expect(() => makeEmbedder(remoteOllama)).toThrow(RemoteProviderRefused);
    const allowed = testConfig({ enrich: { provider: "anthropic", model: "claude-opus-5-5", api_key: "sk-test" } });
    allowed.privacy = { allow_remote: true };
    expect(makeEnricher(allowed).provider).toBe("anthropic");
  });

  test("local openai-compatible servers are allowed; anthropic cannot embed", () => {
    const cfg = testConfig({ embed: { provider: "openai-compatible", model: "m", base_url: "http://localhost:1234/v1" } });
    expect(makeEmbedder(cfg).provider).toBe("openai-compatible");
    const bad = testConfig({ embed: { provider: "anthropic", model: "x" } });
    bad.privacy = { allow_remote: true };
    expect(() => makeEmbedder(bad)).toThrow(/cannot produce embeddings/);
  });

  test("validateConfig rejects wrong types instead of guessing", async () => {
    const { validateConfig, ConfigError } = await import("../src/config");
    const bad = testConfig();
    (bad.privacy as { allow_remote: unknown }).allow_remote = "false";
    expect(() => validateConfig(bad)).toThrow(ConfigError);
    const badProvider = testConfig({ enrich: { provider: "openai" as never, model: "x" } });
    expect(() => validateConfig(badProvider)).toThrow(/enrich.provider/);
    expect(() => validateConfig(testConfig())).not.toThrow();
    const lan = testConfig();
    lan.daemon = { ...lan.daemon, host: "0.0.0.0" };
    expect(() => validateConfig(lan)).toThrow(/loopback/);
  });

  test("validateFilters and clampLimit", async () => {
    const { validateFilters, clampLimit, ValidationError } = await import("../src/search/filters");
    expect(validateFilters({ tag: ["a"], pinned: true, junk: 1 })).toEqual({ tag: ["a"], pinned: true });
    expect(validateFilters({})).toBeUndefined();
    expect(validateFilters({ tag: [] })).toBeUndefined();
    expect(() => validateFilters({ source: ["dropbox"] })).toThrow(ValidationError);
    expect(() => validateFilters({ doc_type: "prd" })).toThrow(ValidationError);
    expect(() => validateFilters({ seen_after: "yesterday" })).toThrow(ValidationError);
    expect(() => validateFilters([1])).toThrow(ValidationError);
    expect(clampLimit(-1, 20, 200)).toBe(1);
    expect(clampLimit("abc", 20, 200)).toBe(20);
    expect(clampLimit(1e9, 20, 200)).toBe(200);
    expect(clampLimit("15", 20, 200)).toBe(15);
  });

  test("ask falls back to the enrich provider", () => {
    expect(makeChat(testConfig()).provider).toBe("fake");
  });

  test("helpers", () => {
    process.env.FABER_TEST_KEY = "secret";
    expect(resolveApiKey("$FABER_TEST_KEY")).toBe("secret");
    expect(resolveApiKey("literal")).toBe("literal");
    expect(resolveApiKey(undefined)).toBeUndefined();
    expect(isLocalUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLocalUrl("http://[::1]:1")).toBe(true);
    expect(isLocalUrl("https://api.example.com")).toBe(false);
    expect(isLocalUrl("garbage")).toBe(false);
  });
});

describe("VectorIndex", () => {
  test("ranks documents by best chunk and supports removal", async () => {
    const e = new FakeEmbedder();
    const idx = new VectorIndex(e.model);
    idx.setDoc("a", await e.embed(["rate limits token bucket gateway", "unrelated lunch menu"]));
    idx.setDoc("b", await e.embed(["holiday party planning snacks"]));
    const [q] = await e.embed(["gateway rate limits"]);
    expect(idx.search(q!, 2)[0]!.doc_id).toBe("a");
    expect(idx.searchChunks(q!, 1)[0]).toMatchObject({ doc_id: "a", ix: 0 });
    expect(idx.searchChunks(q!, 5, new Set(["b"])).every((h) => h.doc_id === "b")).toBe(true);
    expect(idx.vectorsFor("a").length).toBe(2);
    idx.removeDoc("a");
    expect(idx.size).toBe(1);
    expect(idx.search(q!, 2).map((h) => h.doc_id)).toEqual(["b"]);
  });

  test("rejects mismatched dimensions with a helpful message and ignores bad queries", () => {
    const idx = new VectorIndex("m");
    idx.setDoc("a", [new Float32Array([1, 0, 0])]);
    expect(() => idx.setDoc("b", [new Float32Array([1, 0])])).toThrow(/reindex/);
    expect(idx.search(new Float32Array([1, 0]), 3)).toEqual([]);
  });
});

test("toFtsQuery quotes terms and drops punctuation", () => {
  expect(toFtsQuery('rate-limit "design" (v2)')).toBe('"rate-limit"* OR "design"* OR "v2"*');
  expect(toFtsQuery("  ? ! ")).toBe("");
  expect(toFtsQuery("a")).toBe("");
});

test("priorityFor favours pinned, frequent and recent docs", () => {
  const now = Date.now();
  expect(priorityFor(10, now, false)).toBeGreaterThan(priorityFor(1, now, false));
  expect(priorityFor(1, now, false)).toBeGreaterThan(priorityFor(1, now - 300 * 86400000, false));
  expect(priorityFor(1, now - 300 * 86400000, true)).toBeGreaterThan(priorityFor(50, now, false));
});

test("seriesKey collapses dated occurrences of a recurring meeting", () => {
  expect(seriesKey("Billing v2 sync")).toBe("billing v2 sync");
  expect(seriesKey("Billing v2 sync — 4/10")).toBe("billing v2 sync");
  expect(seriesKey("Billing v2 sync (Thursday, Apr 10)")).toBe("billing v2 sync");
  expect(seriesKey("Standup #42")).toBe("standup");
  expect(seriesKey("  !!! ")).toBe("");
});

describe("migrateLegacyHome (Power Bookmark → Faber)", () => {
  const legacyHome = () => {
    const root = mkdtempSync(join(tmpdir(), "faber-migrate-"));
    const legacy = join(root, ".powerbookmark");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "config.toml"), "# mine\n");
    for (const f of ["powerbookmark.sqlite", "powerbookmark.sqlite-wal", "powerbookmark.sqlite-shm"]) writeFileSync(join(legacy, f), f);
    return { root, legacy, home: join(root, ".faber") };
  };

  test("moves the database (with -wal/-shm) and config, then removes the old directory", () => {
    const { legacy, home } = legacyHome();
    expect(migrateLegacyHome(home, legacy)).toBe(true);
    expect(readFileSync(join(home, "faber.sqlite"), "utf8")).toBe("powerbookmark.sqlite");
    expect(readFileSync(join(home, "faber.sqlite-wal"), "utf8")).toBe("powerbookmark.sqlite-wal");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe("# mine\n");
    expect(existsSync(legacy)).toBe(false);
  });

  test("an untouched default config in the new home is replaced by the old one", () => {
    const { legacy, home } = legacyHome();
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), DEFAULT_CONFIG_TOML);
    migrateLegacyHome(home, legacy);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe("# mine\n");
  });

  test("never touches a new home that already has a database", () => {
    const { legacy, home } = legacyHome();
    mkdirSync(home);
    writeFileSync(join(home, "faber.sqlite"), "new");
    expect(migrateLegacyHome(home, legacy)).toBe(false);
    expect(readFileSync(join(home, "faber.sqlite"), "utf8")).toBe("new");
    expect(existsSync(join(legacy, "powerbookmark.sqlite"))).toBe(true);
  });

  test("no-op without old data", () => {
    const root = mkdtempSync(join(tmpdir(), "faber-migrate-"));
    expect(migrateLegacyHome(join(root, ".faber"), join(root, ".powerbookmark"))).toBe(false);
    expect(existsSync(join(root, ".faber"))).toBe(false);
  });
});
