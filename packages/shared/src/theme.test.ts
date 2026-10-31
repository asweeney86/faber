import { describe, expect, test } from "bun:test";
import {
  ACCENTS,
  APPEARANCE_CACHE_KEY,
  appearanceController,
  contrast,
  DEFAULT_APPEARANCE,
  DOC_TYPE_COLORS,
  FLAVORS,
  mix,
  normaliseAppearance,
  resolveFlavor,
  themeTokens,
  type Flavor,
} from "./theme";

const TEXT_PAIRS: [string, string][] = [
  ["text", "bg"],
  ["text", "bg-elev"],
  ["text", "bg-sidebar"],
  ["text", "bg-selected"],
  ["text-2", "bg-elev"],
  ["text-2", "bg-hover"],
  ["text-2", "bg-selected"],
  ["text-muted", "bg"],
  ["text-muted", "bg-elev"],
  ["text-muted", "bg-hover"],
  ["text-muted", "bg-active"],
  ["text-muted", "bg-sunken"],
  ["text-muted", "bg-sidebar"],
  ["text-muted", "bg-selected"],
  ["text-faint", "bg"],
  ["text-faint", "bg-elev"],
  ["accent-text", "bg"],
  ["accent-text", "bg-elev"],
  ["accent-text", "accent-soft"],
  ["accent-text", "bg-selected"],
  ["on-accent", "accent-solid"],
  ["on-accent", "accent-solid-hover"],
  ["danger", "bg-elev"],
  ["danger", "danger-soft"],
  ["success", "bg-elev"],
  ["success", "success-soft"],
  ["warning", "bg-elev"],
  ["warning", "warning-soft"],
  ["info", "info-soft"],
  ["mark-text", "mark"],
];
const BOUNDARY_PAIRS: [string, string][] = [
  ["border-control", "bg-elev"],
  ["border-control", "bg"],
  ["switch-off-border", "bg-elev"],
  ["accent-solid", "bg-elev"],
  ["accent-solid", "bg"],
];

const combos = (Object.keys(FLAVORS) as Flavor[]).flatMap((f) => ACCENTS.map((a) => [f, a] as const));

describe.each(combos)("%s / %s", (flavor, accent) => {
  const t = themeTokens(flavor, accent);
  test("text pairs ≥ 4.5:1 and control boundaries ≥ 3:1", () => {
    for (const [fg, bg] of TEXT_PAIRS) expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const [fg, bg] of BOUNDARY_PAIRS) expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    for (const type of Object.keys(DOC_TYPE_COLORS)) {
      expect(contrast(t[`type-${type}-fg`]!, t[`type-${type}-bg`]!), type).toBeGreaterThanOrEqual(4.5);
    }
  });
});

test("dark flavors keep Catppuccin's own colors where they already pass", () => {
  const t = themeTokens("mocha", "mauve");
  expect(t["bg-sidebar"]).toBe(mix(FLAVORS.mocha.base, FLAVORS.mocha.mantle, 0.45));
  expect(t.text).toBe(FLAVORS.mocha.text);
  expect(t["accent-solid"]).toBe(FLAVORS.mocha.mauve);
});

test("normaliseAppearance falls back to defaults on bad input", () => {
  expect(normaliseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  expect(normaliseAppearance({ theme: "solarized", accent: "chartreuse", density: "tiny", dark_flavor: "latte" })).toEqual(DEFAULT_APPEARANCE);
  expect(normaliseAppearance({ theme: "latte", accent: "teal", density: "compact" })).toEqual({ ...DEFAULT_APPEARANCE, theme: "latte", accent: "teal", density: "compact" });
});

test("names inherited from Object.prototype are not flavors", () => {
  for (const theme of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    expect(normaliseAppearance({ theme }).theme).toBe("mocha");
    expect(normaliseAppearance({ dark_flavor: theme }).dark_flavor).toBe("mocha");
  }
});

test("a corrupt cached appearance falls back to the default instead of throwing", () => {
  const props: Record<string, string> = {};
  const root = { style: { setProperty: (k: string, v: string) => void (props[k] = v), colorScheme: "" }, dataset: {} as Record<string, string | undefined> };
  const store: Record<string, string> = { [APPEARANCE_CACHE_KEY]: '{"theme":"constructor","accent":"__proto__"}' };
  const c = appearanceController({ root, storage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => void (store[k] = v) }, media: null });
  expect(c.get().theme).toBe("mocha");
  expect(root.dataset.flavor).toBe("mocha");
});

test("system follows the OS: Latte when light, the chosen dark flavor when dark", () => {
  const a = { ...DEFAULT_APPEARANCE, theme: "system" as const, dark_flavor: "frappe" as const };
  expect(resolveFlavor(a, false)).toBe("latte");
  expect(resolveFlavor(a, true)).toBe("frappe");
});

test("the controller applies the cached choice at once, caches updates and follows the OS", () => {
  const props: Record<string, string> = {};
  const root = { style: { setProperty: (k: string, v: string) => void (props[k] = v), colorScheme: "" }, dataset: {} as Record<string, string | undefined> };
  const store: Record<string, string> = { [APPEARANCE_CACHE_KEY]: JSON.stringify({ theme: "system", accent: "teal", density: "compact" }) };
  let onChange = () => {};
  const media = { matches: false, addEventListener: (_: "change", fn: () => void) => void (onChange = fn) };
  const c = appearanceController({ root, storage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => void (store[k] = v) }, media });
  expect(root.dataset).toMatchObject({ flavor: "latte", mode: "light", density: "compact" });
  expect(props["--bg"]).toBe(FLAVORS.latte.base);
  media.matches = true;
  onChange();
  expect(root.dataset.flavor).toBe("mocha");
  expect(root.style.colorScheme).toBe("dark");
  c.set({ ...c.get(), theme: "macchiato" });
  expect(root.dataset.flavor).toBe("macchiato");
  expect(JSON.parse(store[APPEARANCE_CACHE_KEY]!).theme).toBe("macchiato");
});
