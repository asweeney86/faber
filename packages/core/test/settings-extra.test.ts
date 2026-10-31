import { describe, expect, test } from "bun:test";
import { BUILTIN_RULES, DEFAULT_APPEARANCE, type Appearance, type WatchRule } from "@faber/shared";
import { openDatabase } from "../src/db";
import { getSettings, saveSettings, SettingsValidationError } from "../src/settings";

/** PUT /api/settings semantics: any subset; omitted sections are left as they are. */

const fresh = () => openDatabase(":memory:");
const LATTE: Appearance = { theme: "latte", dark_flavor: "frappe", accent: "teal", density: "compact" };
const custom = (over: Partial<WatchRule> = {}): WatchRule => ({
  id: "c1",
  label: "Wiki",
  pattern: "wiki.example.com",
  extractor: "generic",
  enabled: true,
  builtin: false,
  ...over,
});
const withGslides = (db: ReturnType<typeof fresh>, on: boolean) => getSettings(db).watchlist.map((r) => (r.id === "gslides" ? { ...r, enabled: on } : r));

describe("partial updates", () => {
  test("defaults before anything is saved", () => {
    const db = fresh();
    const s = getSettings(db);
    expect(s.appearance).toEqual(DEFAULT_APPEARANCE);
    expect(s.watchlist.map((r) => r.id)).toEqual(BUILTIN_RULES.map((r) => r.id));
  });

  test("an appearance-only save leaves the watchlist alone", () => {
    const db = fresh();
    saveSettings(db, { watchlist: [...withGslides(db, true), custom()] });
    const before = getSettings(db).watchlist;
    const after = saveSettings(db, { appearance: LATTE });
    expect(after.appearance).toEqual(LATTE);
    expect(after.watchlist).toEqual(before);
    expect(getSettings(db).watchlist).toEqual(before);
  });

  test("a watchlist-only save leaves the appearance alone", () => {
    const db = fresh();
    saveSettings(db, { appearance: LATTE });
    const after = saveSettings(db, { watchlist: withGslides(db, true) });
    expect(after.appearance).toEqual(LATTE);
    expect(after.watchlist.find((r) => r.id === "gslides")?.enabled).toBe(true);
  });

  test("both at once are both saved", () => {
    const db = fresh();
    const s = saveSettings(db, { appearance: LATTE, watchlist: [...withGslides(db, true), custom()] });
    expect(s.appearance).toEqual(LATTE);
    expect(s.watchlist.some((r) => r.id === "c1")).toBe(true);
  });

  test("an empty update, null or a non-object is refused", () => {
    const db = fresh();
    for (const bad of [{}, null, undefined, "x", 1, { other: true }, { watchlist: undefined, appearance: undefined }]) {
      expect(() => saveSettings(db, bad as never)).toThrow(SettingsValidationError);
    }
  });

  test("a non-array watchlist is refused and changes nothing", () => {
    const db = fresh();
    saveSettings(db, { watchlist: [custom()] });
    expect(() => saveSettings(db, { watchlist: { id: "x" } as never })).toThrow(SettingsValidationError);
    expect(getSettings(db).watchlist.some((r) => r.id === "c1")).toBe(true);
  });

  // Regression (fixed): saveSettings writes the appearance before validating the watchlist, so a request
  // the API rejects with 400 still changes the theme. (packages/core/src/settings.ts saveSettings:
  // putSetting("appearance") runs before saveWatchlist() throws; no transaction.)
  test("a rejected update (bad watchlist) does not save its appearance either", () => {
    const db = fresh();
    expect(() => saveSettings(db, { appearance: LATTE, watchlist: [custom({ pattern: "not a host!" })] })).toThrow(SettingsValidationError);
    expect(getSettings(db).appearance).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("appearance normalisation", () => {
  test("unknown values fall back field by field", () => {
    const db = fresh();
    const s = saveSettings(db, { appearance: { theme: "solarized", dark_flavor: "latte", accent: "rainbow", density: "cosy" } as never });
    expect(s.appearance).toEqual(DEFAULT_APPEARANCE);
    // Valid fields are kept even when others are not.
    const t = saveSettings(db, { appearance: { theme: "frappe", accent: "nope" } as never });
    expect(t.appearance).toEqual({ ...DEFAULT_APPEARANCE, theme: "frappe" });
  });

  test("latte is not a dark flavor; system is a theme but not a dark flavor", () => {
    const db = fresh();
    expect(saveSettings(db, { appearance: { ...LATTE, dark_flavor: "latte" } }).appearance.dark_flavor).toBe("mocha");
    expect(saveSettings(db, { appearance: { ...LATTE, dark_flavor: "system" as never } }).appearance.dark_flavor).toBe("mocha");
    expect(saveSettings(db, { appearance: { ...LATTE, theme: "system" } }).appearance.theme).toBe("system");
  });

  test("a partial appearance object is completed with defaults (not merged with the stored one)", () => {
    const db = fresh();
    saveSettings(db, { appearance: LATTE });
    const s = saveSettings(db, { appearance: { density: "compact" } as never });
    expect(s.appearance).toEqual({ ...DEFAULT_APPEARANCE, density: "compact" });
  });

  test("appearance: null resets to the defaults", () => {
    const db = fresh();
    saveSettings(db, { appearance: LATTE });
    expect(saveSettings(db, { appearance: null as never }).appearance).toEqual(DEFAULT_APPEARANCE);
  });

  test("extra keys are dropped and nothing else is stored", () => {
    const db = fresh();
    const s = saveSettings(db, { appearance: { ...LATTE, evil: "<script>" } as never });
    expect(Object.keys(s.appearance).sort()).toEqual(["accent", "dark_flavor", "density", "theme"]);
  });

  test("a corrupt stored value reads back as the defaults", () => {
    const db = fresh();
    db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('appearance', '"garbage"', 0)`);
    expect(getSettings(db).appearance).toEqual(DEFAULT_APPEARANCE);
  });

  // Regression: `v in FLAVORS` used to accept Object.prototype keys (fixed in 78786ce).
  test("prototype keys are not themes", () => {
    const db = fresh();
    for (const theme of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(saveSettings(db, { appearance: { ...LATTE, theme } as never }).appearance.theme).toBe(DEFAULT_APPEARANCE.theme);
    }
  });
});

describe("watchlist rules", () => {
  test("built-in rules only take `enabled` from input", () => {
    const db = fresh();
    const tampered = BUILTIN_RULES.map((b) => ({ ...b, label: "HACKED", pattern: "evil.example.com", extractor: "generic" as const, enabled: true }));
    const s = saveSettings(db, { watchlist: tampered });
    for (const b of BUILTIN_RULES) {
      const r = s.watchlist.find((x) => x.id === b.id)!;
      expect(r).toEqual({ ...b, enabled: true });
    }
  });

  test("omitted built-ins go back to their defaults; omitted custom rules are removed", () => {
    const db = fresh();
    saveSettings(db, { watchlist: [...withGslides(db, true), custom()] });
    const s = saveSettings(db, { watchlist: [] });
    expect(s.watchlist.find((r) => r.id === "gslides")?.enabled).toBe(BUILTIN_RULES.find((r) => r.id === "gslides")!.enabled);
    expect(s.watchlist.some((r) => r.id === "c1")).toBe(false);
  });

  test("custom rules are normalised: pattern, label length, extractor and builtin flag", () => {
    const db = fresh();
    const s = saveSettings(db, {
      watchlist: [custom({ pattern: "  HTTPS://Wiki.Example.com/Team/  ", label: "L".repeat(200), extractor: "gdoc", builtin: true })],
    });
    const r = s.watchlist.find((x) => x.id === "c1")!;
    expect(r.builtin).toBe(false);
    expect(r.extractor).toBe("generic");
    expect(r.label).toHaveLength(80);
    expect(r.pattern).not.toMatch(/^https?:|\s|\/$/i);
  });

  test("a custom rule without a label is labelled by its pattern", () => {
    const db = fresh();
    const s = saveSettings(db, { watchlist: [custom({ label: "" })] });
    expect(s.watchlist.find((x) => x.id === "c1")!.label).toBe("wiki.example.com");
  });

  test("validation: missing id, duplicate id, bad pattern, duplicate pattern after normalising", () => {
    const db = fresh();
    const bad: WatchRule[][] = [
      [custom({ id: "" })],
      [custom(), custom()],
      [custom({ pattern: "com" })],
      [custom({ pattern: "not a host!" })],
      [custom(), custom({ id: "c2", pattern: "HTTP://WIKI.example.com/" })],
    ];
    for (const wl of bad) expect(() => saveSettings(db, { watchlist: wl })).toThrow(SettingsValidationError);
    expect(getSettings(db).watchlist.filter((r) => !r.builtin)).toEqual([]);
  });
});
