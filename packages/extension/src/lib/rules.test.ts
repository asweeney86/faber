import { describe, expect, test } from "bun:test";
import { normaliseWatchlist, type WatchRule } from "@faber/shared";
import { validateNewPattern } from "./rules";

const custom = (pattern: string, label = "Wiki"): WatchRule => ({ id: `c-${pattern}`, label, pattern, extractor: "generic", enabled: true, builtin: false });

describe("validateNewPattern", () => {
  const rules = normaliseWatchlist([custom("wiki.example.com/team")]);

  test("normalises what the user typed", () => {
    expect(validateNewPattern(" HTTPS://GitHub.com/My-Org/ ", rules)).toEqual({ ok: true, pattern: "github.com/my-org", host: "github.com" });
    expect(validateNewPattern("*.atlassian.net", rules)).toMatchObject({ ok: true, pattern: "*.atlassian.net" });
  });

  test("rejects junk and whole top-level domains", () => {
    for (const bad of ["", "not a host!", "com", "*.com", "http://"]) {
      expect(validateNewPattern(bad, rules).ok).toBe(false);
    }
  });

  test("catches duplicates after normalisation, naming the existing rule", () => {
    const r = validateNewPattern("https://Wiki.Example.com/team/", rules);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Wiki") });
  });

  test("a different path on the same host is not a duplicate", () => {
    expect(validateNewPattern("wiki.example.com/other", rules).ok).toBe(true);
  });

  test("built-in Google rules count as existing", () => {
    expect(validateNewPattern("docs.google.com/document", rules).ok).toBe(false);
  });
});
