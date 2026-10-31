import { describe, expect, test } from "bun:test";
import {
  BUILTIN_RULES,
  cleanGoogleTitle,
  matchWatchRule,
  normaliseWatchlist,
  originPatternsFor,
  parseGoogleUrl,
  parsePattern,
  patternMatches,
  type WatchRule,
} from "../src";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";

describe("parseGoogleUrl", () => {
  test("recognises docs, slides and sheets and canonicalises them", () => {
    expect(parseGoogleUrl(`https://docs.google.com/document/d/${ID}/edit#heading=h.1`)).toEqual({
      kind: "gdoc",
      id: ID,
      canonicalUrl: `https://docs.google.com/document/d/${ID}/edit`,
      exportUrl: `https://docs.google.com/document/d/${ID}/export?format=txt`,
      authuser: null,
    });
    expect(parseGoogleUrl(`https://docs.google.com/presentation/d/${ID}/edit#slide=id.p`)?.exportUrl).toBe(
      `https://docs.google.com/presentation/d/${ID}/export/txt`,
    );
    expect(parseGoogleUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=0`)?.exportUrl).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`,
    );
  });

  test("multi-account /u/N/ and ?authuser= keep the account for exports but not identity", () => {
    const ref = parseGoogleUrl(`https://docs.google.com/document/u/1/d/${ID}/view`)!;
    expect(ref.canonicalUrl).toBe(`https://docs.google.com/document/d/${ID}/edit`);
    expect(ref.authuser).toBe(1);
    expect(ref.exportUrl).toBe(`https://docs.google.com/document/d/${ID}/export?format=txt&authuser=1`);
    expect(parseGoogleUrl(`https://docs.google.com/presentation/d/${ID}/edit?authuser=2`)!.exportUrl).toBe(
      `https://docs.google.com/presentation/d/${ID}/export/txt?authuser=2`,
    );
    expect(parseGoogleUrl(`https://docs.google.com/document/d/${ID}/edit?authuser=evil`)!.authuser).toBeNull();
    expect(parseGoogleUrl(`https://docs.google.com/document/u/0/d/${ID}/edit`)!.exportUrl).not.toContain("authuser");
  });

  test("rejects other hosts, other paths and garbage", () => {
    expect(parseGoogleUrl(`https://evil.com/document/d/${ID}/edit`)).toBeNull();
    expect(parseGoogleUrl("https://docs.google.com/forms/d/abc/edit")).toBeNull();
    expect(parseGoogleUrl("https://docs.google.com/document/d/short/edit")).toBeNull();
    expect(parseGoogleUrl("not a url")).toBeNull();
  });
});

test("cleanGoogleTitle strips the product suffix only", () => {
  expect(cleanGoogleTitle("Q3 plan - Google Docs")).toBe("Q3 plan");
  expect(cleanGoogleTitle("Deck - Google Slides")).toBe("Deck");
  expect(cleanGoogleTitle("Plan - Google Sheets ")).toBe("Plan");
  expect(cleanGoogleTitle("Docs - Google Docs review")).toBe("Docs - Google Docs review");
  expect(cleanGoogleTitle(undefined)).toBe("");
});

describe("watch patterns", () => {
  test("parsePattern accepts hosts, wildcards and paths; rejects junk", () => {
    expect(parsePattern("wiki.example.com")).toEqual({ host: "wiki.example.com", wildcard: false, pathPrefix: "" });
    expect(parsePattern("*.Atlassian.net/wiki/")).toEqual({ host: "atlassian.net", wildcard: true, pathPrefix: "/wiki" });
    expect(parsePattern("https://github.com/my-org")).toEqual({ host: "github.com", wildcard: false, pathPrefix: "/my-org" });
    expect(parsePattern("")).toBeNull();
    expect(parsePattern("not a host!")).toBeNull();
    expect(parsePattern("*")).toBeNull();
  });

  test("patternMatches respects host, wildcard and path boundaries", () => {
    expect(patternMatches("github.com/my-org", "https://github.com/my-org/repo/pull/1")).toBe(true);
    expect(patternMatches("github.com/my-org", "https://github.com/my-org-evil/repo")).toBe(false);
    expect(patternMatches("*.atlassian.net", "https://acme.atlassian.net/wiki")).toBe(true);
    expect(patternMatches("*.atlassian.net", "https://atlassian.net/")).toBe(true);
    expect(patternMatches("*.atlassian.net", "https://notatlassian.net/")).toBe(false);
    expect(patternMatches("wiki.example.com", "https://sub.wiki.example.com/")).toBe(false);
    expect(patternMatches("example.com", "ftp://example.com/")).toBe(false);
    expect(patternMatches("docs.google.com/document", `https://docs.google.com/document/u/2/d/${ID}/edit`)).toBe(true);
  });

  test("matchWatchRule only returns enabled rules and prefers built-ins", () => {
    const rules: WatchRule[] = [
      { id: "custom", label: "All Google", pattern: "docs.google.com", extractor: "generic", enabled: true, builtin: false },
      ...BUILTIN_RULES.map((r) => ({ ...r, enabled: r.id === "gdocs" })),
    ];
    expect(matchWatchRule(`https://docs.google.com/document/d/${ID}/edit`, rules)?.id).toBe("gdocs");
    expect(matchWatchRule(`https://docs.google.com/presentation/d/${ID}/edit`, rules)?.id).toBe("custom");
    expect(matchWatchRule("https://example.com/", rules)).toBeNull();
    expect(matchWatchRule(`https://docs.google.com/document/d/${ID}/edit`, BUILTIN_RULES)).toBeNull();
  });

  test("originPatternsFor builds Chrome match patterns", () => {
    expect(originPatternsFor("*.example.com/x")).toEqual(["https://*.example.com/*", "http://*.example.com/*"]);
    expect(originPatternsFor("bad host!")).toEqual([]);
  });

  test("normaliseWatchlist keeps built-ins, user toggles and valid custom rules", () => {
    const out = normaliseWatchlist([
      { id: "gdocs", label: "x", pattern: "evil.com", extractor: "generic", enabled: true, builtin: false },
      { id: "wiki", label: "Wiki", pattern: "wiki.example.com", extractor: "gdocs", enabled: true, builtin: true },
      { id: "junk", label: "Junk", pattern: "!!", extractor: "generic", enabled: true, builtin: false },
    ]);
    expect(out.map((r) => r.id)).toEqual(["gdocs", "gslides", "gsheets", "gcal", "wiki"]);
    expect(out[0]).toMatchObject({ pattern: "docs.google.com/document", enabled: true, builtin: true });
    expect(out[4]).toMatchObject({ builtin: false, extractor: "generic" });
    expect(normaliseWatchlist(null).every((r) => !r.enabled)).toBe(true);
  });
});

test("suggested capture sources are valid, distinct custom-site patterns", async () => {
  const { SUGGESTED_SOURCES, parsePattern, normalisePattern } = await import("../src/watchlist");
  for (const s of SUGGESTED_SOURCES) expect(parsePattern(s.pattern)).not.toBeNull();
  expect(new Set(SUGGESTED_SOURCES.map((s) => normalisePattern(s.pattern))).size).toBe(SUGGESTED_SOURCES.length);
});
