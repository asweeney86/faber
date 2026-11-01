import { expect, test } from "bun:test";
import { normaliseShortcut, normaliseShortcuts, shortcutFromEvent, shortcutLabel, shortcutWarning } from "./shortcuts";

test("shortcuts are made canonical: aliases, case, spaces, modifier order", () => {
  expect(normaliseShortcut("Shift + Command + Space")).toBe("cmd+shift+space");
  expect(normaliseShortcut("alt+ctrl+K")).toBe("ctrl+option+k");
  expect(normaliseShortcut("meta+7")).toBe("cmd+7");
  expect(normaliseShortcut("opt+left")).toBe("option+left");
  expect(normaliseShortcut("f5")).toBe("f5");
  expect(normaliseShortcut("shift+f12")).toBe("shift+f12");
});

test("anything that isn't modifiers plus one key is refused", () => {
  for (const bad of ["k", "space", "cmd", "cmd+shift", "cmd+k+j", "cmd++k", "cmd+enter", "cmd+f13", "hyper+k", "", 7, null, "x".repeat(100)]) {
    expect(normaliseShortcut(bad)).toBeNull();
  }
});

test("labels use the Mac symbols, in the same order as the app", () => {
  expect(shortcutLabel("option+space")).toBe("⌥Space");
  expect(shortcutLabel("cmd+shift+k")).toBe("⌘⇧K");
  expect(shortcutLabel("ctrl+option+7")).toBe("⌃⌥7");
  expect(shortcutLabel("cmd+left")).toBe("⌘←");
  expect(shortcutLabel("f5")).toBe("F5");
});

const ev = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("a recorded key press becomes a shortcut (by physical key, so ⌥K isn't '˚')", () => {
  expect(shortcutFromEvent(ev("KeyK", { altKey: true }))).toBe("option+k");
  expect(shortcutFromEvent(ev("Space", { metaKey: true, shiftKey: true }))).toBe("cmd+shift+space");
  expect(shortcutFromEvent(ev("Digit3", { ctrlKey: true }))).toBe("ctrl+3");
  expect(shortcutFromEvent(ev("ArrowUp", { metaKey: true }))).toBe("cmd+up");
  expect(shortcutFromEvent(ev("F6"))).toBe("f6");
});

test("modifiers alone, bare keys and unsupported keys aren't shortcuts yet", () => {
  expect(shortcutFromEvent(ev("ShiftLeft", { shiftKey: true }))).toBeNull();
  expect(shortcutFromEvent(ev("KeyK"))).toBeNull();
  expect(shortcutFromEvent(ev("Enter", { metaKey: true }))).toBeNull();
});

test("shortcuts macOS already uses get a warning", () => {
  expect(shortcutWarning("cmd+space")).toContain("Spotlight");
  expect(shortcutWarning("cmd+q")).not.toBeNull();
  expect(shortcutWarning("cmd+shift+space")).toBeNull();
});

test("stored shortcuts are cleaned up: bad hotkeys and reports are dropped", () => {
  expect(normaliseShortcuts(null)).toEqual({ launcher: null, launcher_active: null, browser: null });
  expect(normaliseShortcuts({ launcher: "nonsense", launcher_active: { label: 3 }, browser: "⌘⇧K" })).toEqual({ launcher: null, launcher_active: null, browser: null });
  expect(normaliseShortcuts({ launcher: "Alt+Space", launcher_active: { label: "⌥Space", ok: true, at: 5 }, browser: { label: "⇧⌘K", at: 6 } })).toEqual({
    launcher: "option+space",
    launcher_active: { label: "⌥Space", ok: true, at: 5 },
    browser: { label: "⇧⌘K", at: 6 },
  });
});
