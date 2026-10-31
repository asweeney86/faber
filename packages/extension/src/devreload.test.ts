import { expect, test } from "bun:test";
import { isStale } from "./devreload";

test("reload only when the dev server reports a different, real build", () => {
  expect(isStale("b2", "b1")).toBe(true);
  expect(isStale("b1", "b1")).toBe(false);
  expect(isStale("", "b1")).toBe(false);
});
