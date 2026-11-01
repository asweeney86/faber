import { expect, test } from "bun:test";
import { shortcutReport, shortcutText } from "./shortcut";

test("Chrome's shortcut text, or null when none is assigned", () => {
  expect(shortcutText({ shortcut: "⇧⌘K" })).toBe("⇧⌘K");
  expect(shortcutText({ shortcut: "" })).toBeNull();
  expect(shortcutText({})).toBeNull();
  expect(shortcutText(undefined)).toBeNull();
});

test("a shortcut is reported to the daemon once, and again when it or the daemon changes", () => {
  const first = shortcutReport("⇧⌘K", "http://127.0.0.1:7777", null);
  expect(first).toEqual({ key: "http://127.0.0.1:7777|⇧⌘K", label: "⇧⌘K" });
  expect(shortcutReport("⇧⌘K", "http://127.0.0.1:7777", first!.key)).toBeNull();
  expect(shortcutReport("⌥⌘J", "http://127.0.0.1:7777", first!.key)?.label).toBe("⌥⌘J");
  expect(shortcutReport("⇧⌘K", "http://127.0.0.1:7788", first!.key)).not.toBeNull();
  expect(shortcutReport(null, "http://127.0.0.1:7777", first!.key)?.label).toBe("");
});
