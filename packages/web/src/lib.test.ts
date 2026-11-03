import { expect, test } from "bun:test";
import { searchStateFromQuery, searchStateToHash } from "./lib";

test("the browse order round-trips through the URL, frequent by default", () => {
  expect(searchStateFromQuery(new URLSearchParams("")).sort).toBe("frequent");
  const s = searchStateFromQuery(new URLSearchParams("sort=recent&q=x"));
  expect(s.sort).toBe("recent");
  expect(searchStateToHash(s)).toBe("#/search?q=x&sort=recent");
  expect(searchStateToHash({ ...s, sort: "frequent" })).toBe("#/search?q=x");
});
