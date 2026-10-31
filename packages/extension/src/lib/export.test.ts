import { describe, expect, test } from "bun:test";
import { BUILTIN_RULES, normaliseWatchlist } from "@faber/shared";
import { MAX_EXPORT_CHARS, classifyExportHead, cleanExportText, enabledGoogleSources, exportNetworkError, readTextCapped } from "./export";

const EXPORT = "https://docs.google.com/document/d/abc/export?format=txt";
const head = (status: number, contentType: string | null = "text/plain; charset=utf-8", finalUrl = EXPORT) => ({ status, contentType, finalUrl });

describe("classifyExportHead", () => {
  test("plain text and CSV are worth reading", () => {
    expect(classifyExportHead(head(200))).toBeNull();
    expect(classifyExportHead(head(200, "text/csv"))).toBeNull();
    expect(classifyExportHead(head(200, null))).toBeNull();
    expect(classifyExportHead(head(200, "text/plain", ""))).toBeNull();
  });

  test.each([
    [401, false],
    [403, false],
    [404, false],
    [400, false],
  ])("HTTP %i is a permanent error", (status, transient) => {
    expect(classifyExportHead(head(status))).toMatchObject({ ok: false, transient });
  });

  test.each([408, 500, 502, 503])("HTTP %i is transient (not reported to the daemon)", (status) => {
    expect(classifyExportHead(head(status))).toMatchObject({ ok: false, transient: true });
  });

  test("429 is transient and flags rate limiting", () => {
    expect(classifyExportHead(head(429))).toMatchObject({ ok: false, transient: true, rateLimited: true });
  });

  test("a redirect to the sign-in page is a permanent error", () => {
    expect(classifyExportHead(head(200, "text/html", "https://accounts.google.com/ServiceLogin?x"))).toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringMatching(/Not signed in/),
    });
  });

  test("an HTML body is an error even with 200", () => {
    expect(classifyExportHead(head(200, "text/html; charset=utf-8"))).toMatchObject({ ok: false, transient: false });
  });
});

describe("cleanExportText", () => {
  test("strips the BOM, normalises newlines and trims", () => {
    expect(cleanExportText("﻿Title\r\nBody\r\n\n")).toBe("Title\nBody");
  });

  test("caps very long text", () => {
    expect(cleanExportText("x".repeat(MAX_EXPORT_CHARS + 10))).toHaveLength(MAX_EXPORT_CHARS);
  });
});

function streamOf(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe("readTextCapped", () => {
  test("reads a whole small body", async () => {
    expect(await readTextCapped(streamOf(["hello ", "world"]), 100)).toEqual({ text: "hello world", truncated: false });
  });

  test("stops early and cancels the download once the cap is reached", async () => {
    let cancelled = false;
    let pulled = 0;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(enc.encode("abcdefghij"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await readTextCapped(body, 25);
    expect(r).toEqual({ text: "abcdefghijabcdefghijabcde", truncated: true });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  test("decodes multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("café ☕");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 4));
        c.enqueue(bytes.slice(4));
        c.close();
      },
    });
    expect((await readTextCapped(body, 100)).text).toBe("café ☕");
  });

  test("handles a missing body", async () => {
    expect(await readTextCapped(null, 10)).toEqual({ text: "", truncated: false });
  });
});

describe("exportNetworkError", () => {
  test("network errors are transient with a readable message", () => {
    expect(exportNetworkError(new TypeError("Failed to fetch"))).toEqual({
      ok: false,
      transient: true,
      error: "Network error fetching export: Failed to fetch",
    });
  });

  test("timeouts are transient", () => {
    const err = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    expect(exportNetworkError(err)).toMatchObject({ ok: false, transient: true, error: expect.stringMatching(/timed out/) });
  });
});

describe("enabledGoogleSources", () => {
  test("nothing is fetched by default", () => {
    expect(enabledGoogleSources(normaliseWatchlist([]))).toEqual([]);
  });

  test("maps enabled built-in rules to doc sources, ignoring calendar and custom rules", () => {
    const rules = normaliseWatchlist([
      ...BUILTIN_RULES.map((r) => ({ ...r, enabled: r.id !== "gslides" })),
      { id: "c", label: "c", pattern: "wiki.example.com", extractor: "generic", enabled: true, builtin: false },
    ]);
    expect(enabledGoogleSources(rules)).toEqual(["gdoc", "gsheets"]);
  });
});
