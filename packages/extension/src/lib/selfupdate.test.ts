import { expect, test } from "bun:test";
import { shouldReload } from "./selfupdate";

const base = { installType: "development", manifestVersion: "0.1.0", daemonVersion: "0.2.0", reloadedFor: null };

test("an unpacked extension reloads when the daemon is a different version", () => {
  expect(shouldReload(base)).toBe(true);
});

test("but only once per daemon version, so a copy that wasn't replaced can't loop", () => {
  expect(shouldReload({ ...base, reloadedFor: "0.2.0" })).toBe(false);
  expect(shouldReload({ ...base, reloadedFor: "0.1.5" })).toBe(true);
});

test("not when versions match, the daemon is unreachable, or it came from the store", () => {
  expect(shouldReload({ ...base, daemonVersion: "0.1.0" })).toBe(false);
  expect(shouldReload({ ...base, daemonVersion: null })).toBe(false);
  expect(shouldReload({ ...base, installType: "normal" })).toBe(false);
});
