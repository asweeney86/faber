import { describe, expect, test } from "bun:test";
import { escapeOmnibox, fitTags, isOpenableUrl, relativeTime, snippetParts } from "./format";
import { MAX_DWELL_SECONDS, clampDwell, migrateQueue, normaliseDaemonUrl } from "./storage";
import { clampIndex } from "../popup/util";
import { manifest } from "../../build";

describe("relativeTime", () => {
  const now = Date.UTC(2026, 9, 30, 12);
  test.each([
    [now - 10_000, "just now"],
    [now - 5 * 60_000, "5m ago"],
    [now - 3 * 3600_000, "3h ago"],
    [now - 2 * 86_400_000, "2d ago"],
    [now - 28 * 86_400_000, "4w ago"],
  ])("%p → %s", (ms, label) => expect(relativeTime(ms, now)).toBe(label));

  test("older dates show month and year", () => {
    expect(relativeTime(Date.UTC(2025, 2, 10), now)).toMatch(/2025/);
  });
});

describe("escapeOmnibox", () => {
  test("escapes XML special characters", () => {
    expect(escapeOmnibox(`R&D <plan> "q" 'x'`)).toBe("R&amp;D &lt;plan&gt; &quot;q&quot; &apos;x&apos;");
  });
});

describe("snippetParts", () => {
  test("splits bracketed hits", () => {
    expect(snippetParts("the [rate] limit [design]…")).toEqual([
      { text: "the ", hit: false },
      { text: "rate", hit: true },
      { text: " limit ", hit: false },
      { text: "design", hit: true },
      { text: "…", hit: false },
    ]);
  });
});

describe("config helpers", () => {
  test("normaliseDaemonUrl", () => {
    expect(normaliseDaemonUrl("127.0.0.1:7777/")).toBe("http://127.0.0.1:7777");
    expect(normaliseDaemonUrl(" http://localhost:9000/x ")).toBe("http://localhost:9000");
    expect(normaliseDaemonUrl("http://[::1]:7777")).toBe("http://[::1]:7777");
    expect(normaliseDaemonUrl("")).toBeNull();
    expect(normaliseDaemonUrl("http://")).toBeNull();
  });

  test("normaliseDaemonUrl only accepts this machine", () => {
    expect(normaliseDaemonUrl("http://example.com:7777")).toBeNull();
    expect(normaliseDaemonUrl("192.168.1.10:7777")).toBeNull();
    expect(normaliseDaemonUrl("http://127.0.0.1.evil.com:7777")).toBeNull();
  });

  test("clampDwell", () => {
    expect(clampDwell(-3)).toBe(0);
    expect(clampDwell(4.4)).toBe(4);
    expect(clampDwell(999)).toBe(MAX_DWELL_SECONDS);
    expect(clampDwell(Number.NaN)).toBe(4);
  });
});

describe("manifest", () => {
  test("is MV3 with the expected permissions and no broad host access", () => {
    const m = manifest({ test: false, version: "1.2.3" });
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe("1.2.3");
    expect(m.host_permissions).not.toContain("https://*/*");
    expect(m.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
    expect(m.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(m.omnibox.keyword).toBe("faber");
  });

  test("never runs in incognito and doesn't ask for the broad tabs permission", () => {
    const m = manifest({ test: false, version: "0" });
    expect(m.incognito).toBe("not_allowed");
    expect(m.permissions).not.toContain("tabs");
    expect(m.permissions).toContain("activeTab");
  });

  test("tabs is optional (opt-in) and the toolbar starts neutral", () => {
    const m = manifest({ test: false, version: "0" });
    expect(m.optional_permissions).toEqual(["tabs"]);
    expect(m.action.default_icon["16"]).toBe("icons/action-unknown-16.png");
  });

  test("can follow Google export redirects", () => {
    expect(manifest({ test: false, version: "0" }).host_permissions).toContain("https://*.googleusercontent.com/*");
  });

  test("only the test build pre-grants https loopback", () => {
    expect(manifest({ test: false, version: "0" }).host_permissions).not.toContain("https://127.0.0.1/*");
    expect(manifest({ test: true, version: "0" }).host_permissions).toContain("https://127.0.0.1/*");
  });

  test("test build is labelled", () => {
    expect(manifest({ test: true, version: "0" }).name).toContain("test");
  });
});

describe("clampIndex", () => {
  test("keeps the selection inside the list when it shrinks", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(4, 0)).toBe(0);
  });
});

describe("migrateQueue", () => {
  test("wraps old bare captures, keeps new items, drops junk", () => {
    const q = migrateQueue([{ url: "https://a", ts: 1 }, { id: "x", req: { url: "https://b" }, attempts: 2 }, null, 5]);
    expect(q).toHaveLength(2);
    expect(q[0]!.req).toEqual({ url: "https://a", ts: 1 });
    expect(q[0]!.attempts).toBe(0);
    expect(q[1]).toEqual({ id: "x", req: { url: "https://b" }, attempts: 2 });
    expect(migrateQueue({})).toEqual([]);
  });
});

describe("fitTags", () => {
  test("shows as many whole tags as fit, leaving room for +n", () => {
    expect(fitTags(["a", "b", "c"], 100)).toBe(3);
    expect(fitTags(["activation", "analytics", "growth"], 30)).toBe(1);
    expect(fitTags(["approved", "billing"], 23)).toBe(2);
  });

  test("nothing fits in a tiny budget", () => {
    expect(fitTags(["activation"], 5)).toBe(0);
    expect(fitTags([], 10)).toBe(0);
  });
});

describe("isOpenableUrl", () => {
  test("allows http and https only", () => {
    expect(isOpenableUrl("https://docs.google.com/document/d/x/edit")).toBe(true);
    expect(isOpenableUrl("http://wiki.example.com/a")).toBe(true);
  });

  test("refuses other schemes and junk", () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "data:text/html,hi", "not a url", "", null, undefined]) {
      expect(isOpenableUrl(bad)).toBe(false);
    }
  });
});
