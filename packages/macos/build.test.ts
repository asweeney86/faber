import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { infoPlist } from "./build";

const hasSwift = (() => {
  try {
    execFileSync("swiftc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("native macOS launcher", () => {
  test("Info.plist: menu-bar only, local networking only, versioned", () => {
    const p = infoPlist("1.2.3");
    expect(p).toContain("<key>LSUIElement</key><true/>");
    expect(p).toContain("<key>NSAllowsLocalNetworking</key><true/>");
    expect(p).not.toContain("NSAllowsArbitraryLoads");
    expect(p).toContain("<string>dev.faber.launcher</string>");
    expect(p).toContain("<key>CFBundleShortVersionString</key><string>1.2.3</string>");
  });

  test.skipIf(!hasSwift)(
    "the Swift source type-checks",
    () => {
      execFileSync(
        "swiftc",
        ["-typecheck", "-swift-version", "5", join(import.meta.dir, "Sources", "main.swift"), "-framework", "Cocoa", "-framework", "WebKit", "-framework", "Carbon", "-framework", "ServiceManagement"],
        { stdio: "pipe" },
      );
    },
    120_000,
  );
});
