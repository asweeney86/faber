/**
 * Global shortcuts: the Mac launcher's system-wide hotkey (which Faber sets) and the browser
 * extension's shortcut (which Chrome owns; Faber only shows it).
 *
 * A shortcut is stored as a canonical string like "cmd+shift+space": modifiers in a fixed
 * order, then one key. packages/macos/Sources/main.swift (Hotkey.parse) reads the same format.
 */

export interface Shortcuts {
  /** The Mac launcher's hotkey. null = the default (or whatever the app already has). */
  launcher: string | null;
  /** What the Mac app actually registered, as it last reported. */
  launcher_active: { label: string; ok: boolean; at: number } | null;
  /** The extension's launcher shortcut as Chrome has it ("" = none assigned), as last reported. */
  browser: { label: string; at: number } | null;
}

export const DEFAULT_SHORTCUTS: Shortcuts = { launcher: null, launcher_active: null, browser: null };
export const DEFAULT_LAUNCHER_HOTKEY = "option+space";

const MODIFIERS = ["cmd", "ctrl", "option", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];
const MOD_ALIASES: Record<string, Modifier> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  opt: "option",
  option: "option",
  alt: "option",
  shift: "shift",
};
const MOD_SYMBOL: Record<Modifier, string> = { cmd: "⌘", ctrl: "⌃", option: "⌥", shift: "⇧" };

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGITS = "0123456789".split("");
const FKEYS = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);
const ARROWS = ["left", "right", "up", "down"];
const KEYS = new Set([...LETTERS, ...DIGITS, ...FKEYS, ...ARROWS, "space"]);
const KEY_LABEL: Record<string, string> = { space: "Space", left: "←", right: "→", up: "↑", down: "↓" };

/**
 * "Alt + Shift + K" → "option+shift+k". One key, modifiers in a fixed order; at least one
 * modifier unless the key is an F-key. Anything else is null.
 */
export function normaliseShortcut(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const raw of input.toLowerCase().split("+")) {
    const part = raw.trim();
    if (!part) return null;
    const mod = MOD_ALIASES[part];
    if (mod) mods.add(mod);
    else if (KEYS.has(part) && key === null) key = part;
    else return null;
  }
  if (!key || (mods.size === 0 && !FKEYS.includes(key))) return null;
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
}

/** "cmd+shift+space" → "⌘⇧Space". */
export function shortcutLabel(shortcut: string): string {
  const parts = shortcut.split("+");
  const key = parts.pop() ?? "";
  return parts.map((m) => MOD_SYMBOL[m as Modifier] ?? "").join("") + (KEY_LABEL[key] ?? key.toUpperCase());
}

/**
 * A keydown as a shortcut, for "press the new shortcut" recorders. Uses `code`, not `key`,
 * so ⌥K is "option+k" rather than "˚". null while only modifiers are held, or for keys we
 * can't register.
 */
export function shortcutFromEvent(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  let key: string | null = null;
  const m = /^(?:Key([A-Z])|Digit(\d)|(F\d{1,2})|Arrow(Left|Right|Up|Down)|(Space))$/.exec(e.code);
  if (m) key = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5])!.toLowerCase();
  if (!key) return null;
  const mods = [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "option", e.shiftKey && "shift"].filter(Boolean);
  return normaliseShortcut([...mods, key].join("+"));
}

/** Shortcuts macOS (or every app) already uses: registering them would break something. */
const RESERVED: Record<string, string> = {
  "cmd+space": "Spotlight uses ⌘Space",
  "ctrl+space": "macOS uses ⌃Space to switch input sources",
  "cmd+q": "⌘Q quits apps",
  "cmd+w": "⌘W closes windows",
  "cmd+c": "⌘C is Copy",
  "cmd+v": "⌘V is Paste",
  "cmd+x": "⌘X is Cut",
  "cmd+z": "⌘Z is Undo",
  "cmd+a": "⌘A is Select All",
  "cmd+tab": "⌘Tab switches apps",
};

/** Why a shortcut is a bad idea, or null if it's fine. */
export function shortcutWarning(shortcut: string): string | null {
  return RESERVED[shortcut] ?? null;
}

export function normaliseShortcuts(input: unknown): Shortcuts {
  const s = (input && typeof input === "object" ? input : {}) as Partial<Shortcuts>;
  const active = s.launcher_active;
  const browser = s.browser;
  return {
    launcher: normaliseShortcut(s.launcher),
    launcher_active:
      active && typeof active === "object" && typeof active.label === "string" && active.label.length <= 32
        ? { label: active.label, ok: active.ok === true, at: Number(active.at) || 0 }
        : null,
    browser:
      browser && typeof browser === "object" && typeof browser.label === "string" && browser.label.length <= 32
        ? { label: browser.label, at: Number(browser.at) || 0 }
        : null,
  };
}
