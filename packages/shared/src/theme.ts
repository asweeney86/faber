/**
 * Appearance: Catppuccin flavors, accent colors and density, shared by the web
 * app, the launcher and the extension so every surface looks the same.
 *
 * Components never use palette colors directly. They use semantic tokens
 * (--bg, --text-muted, --accent-solid, ...) that themeTokens() derives from a
 * flavor and an accent. Derived colors are nudged until they meet WCAG AA
 * (text ≥ 4.5:1, control boundaries ≥ 3:1) in every combination; theme.test.ts
 * checks all of them.
 */

export const ACCENTS = [
  "rosewater",
  "flamingo",
  "pink",
  "mauve",
  "red",
  "maroon",
  "peach",
  "yellow",
  "green",
  "teal",
  "sky",
  "sapphire",
  "blue",
  "lavender",
] as const;
export type Accent = (typeof ACCENTS)[number];

type Neutral =
  | "text"
  | "subtext1"
  | "subtext0"
  | "overlay2"
  | "overlay1"
  | "overlay0"
  | "surface2"
  | "surface1"
  | "surface0"
  | "base"
  | "mantle"
  | "crust";
export type Palette = Record<Accent | Neutral, string>;

/** The official Catppuccin palettes (https://catppuccin.com/palette). */
export const FLAVORS = {
  mocha: {
    rosewater: "#f5e0dc", flamingo: "#f2cdcd", pink: "#f5c2e7", mauve: "#cba6f7", red: "#f38ba8", maroon: "#eba0ac", peach: "#fab387",
    yellow: "#f9e2af", green: "#a6e3a1", teal: "#94e2d5", sky: "#89dceb", sapphire: "#74c7ec", blue: "#89b4fa", lavender: "#b4befe",
    text: "#cdd6f4", subtext1: "#bac2de", subtext0: "#a6adc8", overlay2: "#9399b2", overlay1: "#7f849c", overlay0: "#6c7086",
    surface2: "#585b70", surface1: "#45475a", surface0: "#313244", base: "#1e1e2e", mantle: "#181825", crust: "#11111b",
  },
  macchiato: {
    rosewater: "#f4dbd6", flamingo: "#f0c6c6", pink: "#f5bde6", mauve: "#c6a0f6", red: "#ed8796", maroon: "#ee99a0", peach: "#f5a97f",
    yellow: "#eed49f", green: "#a6da95", teal: "#8bd5ca", sky: "#91d7e3", sapphire: "#7dc4e4", blue: "#8aadf4", lavender: "#b7bdf8",
    text: "#cad3f5", subtext1: "#b8c0e0", subtext0: "#a5adcb", overlay2: "#939ab7", overlay1: "#8087a2", overlay0: "#6e738d",
    surface2: "#5b6078", surface1: "#494d64", surface0: "#363a4f", base: "#24273a", mantle: "#1e2030", crust: "#181926",
  },
  frappe: {
    rosewater: "#f2d5cf", flamingo: "#eebebe", pink: "#f4b8e4", mauve: "#ca9ee6", red: "#e78284", maroon: "#ea999c", peach: "#ef9f76",
    yellow: "#e5c890", green: "#a6d189", teal: "#81c8be", sky: "#99d1db", sapphire: "#85c1dc", blue: "#8caaee", lavender: "#babbf1",
    text: "#c6d0f5", subtext1: "#b5bfe2", subtext0: "#a5adce", overlay2: "#949cbb", overlay1: "#838ba7", overlay0: "#737994",
    surface2: "#626880", surface1: "#51576d", surface0: "#414559", base: "#303446", mantle: "#292c3c", crust: "#232634",
  },
  latte: {
    rosewater: "#dc8a78", flamingo: "#dd7878", pink: "#ea76cb", mauve: "#8839ef", red: "#d20f39", maroon: "#e64553", peach: "#fe640b",
    yellow: "#df8e1d", green: "#40a02b", teal: "#179299", sky: "#04a5e5", sapphire: "#209fb5", blue: "#1e66f5", lavender: "#7287fd",
    text: "#4c4f69", subtext1: "#5c5f77", subtext0: "#6c6f85", overlay2: "#7c7f93", overlay1: "#8c8fa1", overlay0: "#9ca0b0",
    surface2: "#acb0be", surface1: "#bcc0cc", surface0: "#ccd0da", base: "#eff1f5", mantle: "#e6e9ef", crust: "#dce0e8",
  },
} as const satisfies Record<string, Palette>;
export type Flavor = keyof typeof FLAVORS;

export const FLAVOR_LABELS: Record<Flavor, string> = { mocha: "Catppuccin Mocha", macchiato: "Catppuccin Macchiato", frappe: "Catppuccin Frappé", latte: "Catppuccin Latte" };
export const DARK_FLAVORS: Flavor[] = ["mocha", "macchiato", "frappe"];

export type ThemeChoice = Flavor | "system";
export type Density = "comfortable" | "compact";

export interface Appearance {
  /** A flavor, or "system": Latte when the OS is light, `dark_flavor` when it is dark. */
  theme: ThemeChoice;
  /** The dark flavor used by "system". */
  dark_flavor: Flavor;
  accent: Accent;
  density: Density;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: "mocha", dark_flavor: "mocha", accent: "mauve", density: "comfortable" };

/** Coerce stored or user input into a valid Appearance (unknown values fall back to defaults). */
export function normaliseAppearance(input: unknown): Appearance {
  const a = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof Appearance, unknown>>;
  const isFlavor = (v: unknown): v is Flavor => typeof v === "string" && Object.hasOwn(FLAVORS, v);
  return {
    theme: a.theme === "system" || isFlavor(a.theme) ? a.theme : DEFAULT_APPEARANCE.theme,
    dark_flavor: isFlavor(a.dark_flavor) && DARK_FLAVORS.includes(a.dark_flavor) ? a.dark_flavor : DEFAULT_APPEARANCE.dark_flavor,
    accent: ACCENTS.includes(a.accent as Accent) ? (a.accent as Accent) : DEFAULT_APPEARANCE.accent,
    density: a.density === "compact" ? "compact" : "comfortable",
  };
}

export function resolveFlavor(a: Appearance, prefersDark: boolean): Flavor {
  if (a.theme !== "system") return a.theme;
  return prefersDark ? a.dark_flavor : "latte";
}

// ---------- color math ----------

type RGB = [number, number, number];

export function hexToRgb(c: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) throw new Error(`not a hex color: ${c}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

/** Mix `b` into `a` by t (0 = a, 1 = b), in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [hexToRgb(a), hexToRgb(b)];
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

function luminance(c: string): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(c);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Move `fg` toward `toward` in small steps until it reaches `min` contrast against every background. */
export function ensureContrast(fg: string, bgs: string[], min: number, toward: string): string {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(fg, toward, t);
    if (bgs.every((bg) => contrast(c, bg) >= min)) return c;
  }
  return toward;
}

const alpha = (c: string, a: number) => {
  const [r, g, b] = hexToRgb(c);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

// ---------- tokens ----------

/** Badge colors per document type: each type gets a palette color. */
export const DOC_TYPE_COLORS: Record<string, Accent | "overlay1"> = {
  prd: "green",
  design_doc: "mauve",
  meeting_notes: "blue",
  postmortem: "red",
  okrs: "peach",
  roadmap: "teal",
  deck: "yellow",
  spreadsheet: "green",
  runbook: "pink",
  policy: "lavender",
  research: "flamingo",
  status_update: "sapphire",
  other: "overlay1",
};

/**
 * Every semantic token for a flavor and accent, as CSS custom property values
 * (names without the leading "--").
 */
export function themeTokens(flavor: Flavor, accent: Accent): Record<string, string> {
  const p: Palette = FLAVORS[flavor];
  const dark = flavor !== "latte";
  const strongest = dark ? "#ffffff" : "#000000";

  // Dark: a deep page (toward mantle) with lifted cards (toward surface0), as in the design.
  // Light (Latte): base page, near-white cards.
  const bg = dark ? mix(p.base, p.mantle, 0.8) : p.base;
  const bgElev = dark ? mix(p.base, p.surface0, 0.72) : mix(p.base, "#ffffff", 0.7);
  const bgSidebar = dark ? mix(p.base, p.mantle, 0.45) : p.mantle;
  const bgHover = dark ? mix(p.surface0, p.surface1, 0.3) : mix(p.base, p.surface0, 0.45);
  const bgActive = dark ? mix(p.surface0, p.surface1, 0.6) : mix(p.base, p.surface0, 0.75);
  const bgSunken = dark ? mix(p.base, p.surface0, 0.45) : mix(p.base, p.mantle, 0.6);
  const surfaces = [bg, bgElev, bgSidebar, bgHover, bgActive, bgSunken];

  const text = ensureContrast(p.text, surfaces, 7, strongest);
  const textOn = (c: string, extra: string[] = [], min = 4.5) => ensureContrast(c, [...surfaces, ...extra], min, text);

  // Accent: a fill (buttons, selection) and a text color, both AA in this flavor.
  const raw = p[accent];
  const onCandidates = [FLAVORS.mocha.crust, "#ffffff"];
  let accentSolid = raw;
  let onAccent = onCandidates[0]!;
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(raw, dark ? "#ffffff" : p.text, t);
    const on = onCandidates.reduce((best, o) => (contrast(o, c) > contrast(best, c) ? o : best));
    if (contrast(on, c) >= 4.5 && contrast(c, bgElev) >= 3 && contrast(c, bg) >= 3) {
      accentSolid = c;
      onAccent = on;
      break;
    }
  }
  // Hover moves away from the label color, so it only gains contrast.
  const accentSolidHover = mix(accentSolid, onAccent === "#ffffff" ? "#000000" : "#ffffff", 0.14);
  const accentSoft = mix(bgElev, raw, dark ? 0.16 : 0.12);
  const bgSelected = mix(bgElev, raw, dark ? 0.24 : 0.18);
  const accentText = textOn(raw, [accentSoft, bgSelected]);

  const status = (c: string) => {
    const soft = mix(bgElev, c, dark ? 0.16 : 0.12);
    return { fg: textOn(c, [soft]), soft };
  };
  const danger = status(p.red);
  const success = status(p.green);
  const warning = status(dark ? p.yellow : p.peach);
  const info = status(p.blue);

  const mark = mix(bgElev, p.yellow, dark ? 0.38 : 0.45);

  const tokens: Record<string, string> = {
    "bg": bg,
    "bg-sidebar": bgSidebar,
    "bg-elev": bgElev,
    "bg-hover": bgHover,
    "bg-active": bgActive,
    "bg-sunken": bgSunken,
    "bg-selected": bgSelected,
    "border": dark ? mix(p.surface0, p.surface1, 0.3) : mix(p.base, p.surface0, 0.85),
    "border-strong": p.surface1,
    "border-control": ensureContrast(p.overlay0, [bg, bgElev, bgSunken], 3, text),
    "text": text,
    "text-2": textOn(p.subtext1, [bgSelected]),
    "text-muted": textOn(p.subtext0, [bgSelected]),
    "text-faint": textOn(p.overlay2),
    "text-decor": dark ? p.surface2 : p.surface1,
    "accent-raw": raw,
    "accent": accentSolid,
    "accent-hover": accentSolidHover,
    "accent-soft": accentSoft,
    "accent-text": accentText,
    "accent-ring": alpha(raw, dark ? 0.5 : 0.4),
    "accent-solid": accentSolid,
    "accent-solid-hover": accentSolidHover,
    "on-accent": onAccent,
    "brand-ribbon": dark ? "#d69cf1" : "#a86bd8",
    "switch-off": dark ? p.surface1 : p.surface0,
    "switch-off-border": ensureContrast(p.overlay1, [bg, bgElev], 3, text),
    "danger": danger.fg,
    "danger-soft": danger.soft,
    "success": success.fg,
    "success-soft": success.soft,
    "warning": warning.fg,
    "warning-soft": warning.soft,
    "info": info.fg,
    "info-soft": info.soft,
    "mark": mark,
    "mark-text": ensureContrast(text, [mark], 4.5, strongest),
    "src-gdoc": p.blue,
    "src-gslides": p.yellow,
    "src-gsheets": p.green,
    "src-url": p.overlay1,
    "shadow-sm": dark ? "0 1px 2px rgba(0, 0, 0, 0.3)" : "0 1px 2px rgba(20, 20, 40, 0.05)",
    "shadow": dark ? "0 1px 3px rgba(0, 0, 0, 0.35)" : "0 1px 3px rgba(20, 20, 40, 0.06), 0 1px 2px rgba(20, 20, 40, 0.04)",
    "shadow-lg": dark ? "0 18px 50px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.3)" : "0 12px 40px rgba(20, 20, 40, 0.16), 0 2px 8px rgba(20, 20, 40, 0.06)",
    "scrim": dark ? "rgba(0, 0, 0, 0.55)" : "rgba(40, 40, 60, 0.32)",
  };
  // Raw palette colors, for decorative marks only (folder tints, bars). Never for text.
  for (const a of ACCENTS) tokens[`c-${a}`] = p[a];
  for (const [type, color] of Object.entries(DOC_TYPE_COLORS)) {
    const c = p[color];
    const soft = mix(bgElev, c, dark ? 0.18 : 0.14);
    tokens[`type-${type}-bg`] = soft;
    tokens[`type-${type}-fg`] = ensureContrast(c, [soft], 4.5, text);
  }
  return tokens;
}

export interface ResolvedAppearance {
  flavor: Flavor;
  dark: boolean;
  density: Density;
  tokens: Record<string, string>;
}

export function resolveAppearance(a: Appearance, prefersDark: boolean): ResolvedAppearance {
  const flavor = resolveFlavor(a, prefersDark);
  return { flavor, dark: flavor !== "latte", density: a.density, tokens: themeTokens(flavor, a.accent) };
}

/** Swatch colors to preview a flavor (as in the theme picker): mauve, blue, pink, yellow. */
export function flavorSwatches(flavor: Flavor): string[] {
  const p = FLAVORS[flavor];
  return [p.mauve, p.blue, p.pink, p.yellow];
}

/** The parts of a document element we touch (keeps this module free of DOM types). */
export interface ThemeRoot {
  style: { setProperty(name: string, value: string): void; colorScheme: string };
  dataset: Record<string, string | undefined>;
}

/** Apply an appearance: tokens as inline custom properties, plus data-flavor/mode/density for CSS. */
export function applyAppearance(root: ThemeRoot, a: Appearance, prefersDark: boolean): ResolvedAppearance {
  const r = resolveAppearance(a, prefersDark);
  for (const [k, v] of Object.entries(r.tokens)) root.style.setProperty(`--${k}`, v);
  root.dataset.flavor = r.flavor;
  root.dataset.mode = r.dark ? "dark" : "light";
  root.dataset.density = r.density;
  root.style.colorScheme = r.dark ? "dark" : "light";
  return r;
}

export const APPEARANCE_CACHE_KEY = "faber:appearance";

export interface AppearanceEnv {
  root: ThemeRoot;
  /** localStorage, when available: caches the choice so the next load paints correctly at once. */
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
  /** matchMedia("(prefers-color-scheme: dark)"), when available. */
  media?: { matches: boolean; addEventListener(type: "change", fn: () => void): void } | null;
}

/**
 * Keep a page's appearance current: apply the cached choice immediately (no
 * flash), follow OS light/dark changes for "system", and re-apply whenever
 * `set` is called (after loading or saving settings).
 */
export function appearanceController(env: AppearanceEnv) {
  let current = DEFAULT_APPEARANCE;
  try {
    const cached = env.storage?.getItem(APPEARANCE_CACHE_KEY);
    if (cached) current = normaliseAppearance(JSON.parse(cached));
  } catch {
    /* storage unavailable or corrupt */
  }
  // Never let a bad stored value blank the page: fall back to the default.
  const safeApply = () => {
    try {
      return applyAppearance(env.root, current, env.media?.matches ?? true);
    } catch {
      current = DEFAULT_APPEARANCE;
      return applyAppearance(env.root, current, env.media?.matches ?? true);
    }
  };
  let resolved = safeApply();
  const listeners = new Set<(r: ResolvedAppearance) => void>();
  const apply = () => {
    resolved = safeApply();
    for (const l of listeners) l(resolved);
  };
  env.media?.addEventListener("change", apply);
  return {
    get: () => current,
    resolved: () => resolved,
    set(a: Appearance) {
      current = normaliseAppearance(a);
      apply();
      // Cache only what applied cleanly.
      try {
        env.storage?.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(current));
      } catch {
        /* storage unavailable */
      }
    },
    subscribe(fn: (r: ResolvedAppearance) => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
