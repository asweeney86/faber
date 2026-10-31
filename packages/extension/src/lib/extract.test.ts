import { describe, expect, test } from "bun:test";
import { cleanPageText } from "./extract";

describe("cleanPageText", () => {
  test("collapses whitespace and blank-line runs", () => {
    const raw = "  Title  \r\n\r\n\r\n\tPara   one here \n   \n\nPara two\n\n";
    expect(cleanPageText(raw)).toBe("Title\n\nPara one here\n\nPara two");
  });

  test("keeps single line breaks inside a block", () => {
    expect(cleanPageText("a\nb\nc")).toBe("a\nb\nc");
  });

  test("returns empty string for whitespace-only input", () => {
    expect(cleanPageText(" \n\t\n ")).toBe("");
  });

  test("caps the length", () => {
    expect(cleanPageText("abcdef", 4)).toBe("abcd");
  });
});
