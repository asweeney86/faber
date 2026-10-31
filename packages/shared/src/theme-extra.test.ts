import { describe, expect, test } from "bun:test";
import { ACCENTS, APPEARANCE_CACHE_KEY, appearanceController, DEFAULT_APPEARANCE, FLAVORS, normaliseAppearance, type Appearance } from "./theme";

/** Robustness of the appearance controller every surface (app, popup, launcher) boots with. */

function env(cached?: string, opts: { throwOnGet?: boolean; throwOnSet?: boolean; dark?: boolean } = {}) {
  const props: Record<string, string> = {};
  const root = { style: { setProperty: (k: string, v: string) => void (props[k] = v), colorScheme: "" }, dataset: {} as Record<string, string | undefined> };
  const store: Record<string, string> = cached === undefined ? {} : { [APPEARANCE_CACHE_KEY]: cached };
  const storage = {
    getItem: (k: string) => {
      if (opts.throwOnGet) throw new Error("SecurityError");
      return store[k] ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      store[k] = v;
    },
  };
  const media = { matches: opts.dark ?? true, addEventListener: () => {} };
  return { root, props, store, storage, media };
}

describe("appearanceController", () => {
  test("no cache: the defaults paint (Mocha, dark)", () => {
    const e = env();
    const c = appearanceController(e);
    expect(c.get()).toEqual(DEFAULT_APPEARANCE);
    expect(e.root.dataset).toMatchObject({ flavor: "mocha", mode: "dark", density: "comfortable" });
    expect(e.props["--bg"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test("a corrupt or hostile cache falls back to the defaults instead of breaking the page", () => {
    for (const cached of ["{not json", "null", "42", '"latte"', "[]", JSON.stringify({ theme: "solarized", accent: "nope" })]) {
      const e = env(cached);
      expect(() => appearanceController(e)).not.toThrow();
      expect(e.root.dataset.flavor).toBe("mocha");
    }
  });

  test("storage that throws (blocked cookies, quota) is tolerated", () => {
    const e = env(undefined, { throwOnGet: true, throwOnSet: true });
    const c = appearanceController(e);
    expect(() => c.set({ ...DEFAULT_APPEARANCE, theme: "latte" })).not.toThrow();
    expect(e.root.dataset.flavor).toBe("latte");
  });

  test("no storage and no matchMedia (e.g. a worker-like context) still works; system means dark", () => {
    const e = env();
    const c = appearanceController({ root: e.root, storage: null, media: null });
    c.set({ ...DEFAULT_APPEARANCE, theme: "system", dark_flavor: "frappe" });
    expect(e.root.dataset.flavor).toBe("frappe");
  });

  test("set() normalises what it is given before caching and applying it", () => {
    const e = env();
    const c = appearanceController(e);
    c.set({ theme: "nope", dark_flavor: "latte", accent: "chartreuse", density: "tiny" } as unknown as Appearance);
    expect(c.get()).toEqual(DEFAULT_APPEARANCE);
    expect(JSON.parse(e.store[APPEARANCE_CACHE_KEY]!)).toEqual(DEFAULT_APPEARANCE);
  });

  test("subscribers hear every change until they unsubscribe", () => {
    const e = env();
    const c = appearanceController(e);
    const heard: string[] = [];
    const off = c.subscribe((r) => heard.push(r.flavor));
    c.set({ ...DEFAULT_APPEARANCE, theme: "latte" });
    c.set({ ...DEFAULT_APPEARANCE, theme: "frappe" });
    off();
    c.set({ ...DEFAULT_APPEARANCE, theme: "macchiato" });
    expect(heard).toEqual(["latte", "frappe"]);
  });

  test("every flavor x accent combination resolves to hex tokens", () => {
    for (const theme of Object.keys(FLAVORS) as (keyof typeof FLAVORS)[]) {
      for (const accent of ACCENTS) {
        const e = env();
        appearanceController(e).set({ ...DEFAULT_APPEARANCE, theme, accent });
        expect(Object.values(e.props).filter((v) => v.startsWith("#")).every((v) => /^#[0-9a-f]{6}$/i.test(v))).toBe(true);
      }
    }
  });

  // Regression: a cached theme of "constructor"/"toString" used to survive normalisation and
  // make applyAppearance throw at startup, so no surface could boot (fixed in 78786ce).
  test("a cached prototype-key theme doesn't crash the controller", () => {
    for (const theme of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(normaliseAppearance({ theme }).theme).toBe(DEFAULT_APPEARANCE.theme);
      const e = env(JSON.stringify({ ...DEFAULT_APPEARANCE, theme }));
      expect(() => appearanceController(e)).not.toThrow();
    }
  });
});
