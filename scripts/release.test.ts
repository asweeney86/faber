import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersions, nextVersion, releaseNotes, renderFormula, setVersion, versionsIn } from "./release-lib";

const root = join(import.meta.dir, "..");

test("every package and the daemon agree on the version", () => {
  expect(() => checkVersions(root)).not.toThrow();
  expect(Object.keys(versionsIn(root))).toEqual(expect.arrayContaining(["package.json", "packages/daemon/src/version.ts", "packages/extension/package.json"]));
});

test("setVersion updates every file, and checkVersions notices a straggler", async () => {
  const copy = mkdtempSync(join(tmpdir(), "faber-version-"));
  cpSync(join(root, "package.json"), join(copy, "package.json"));
  for (const p of ["daemon", "extension", "core"]) cpSync(join(root, "packages", p, "package.json"), join(copy, "packages", p, "package.json"));
  cpSync(join(root, "packages/daemon/src/version.ts"), join(copy, "packages/daemon/src/version.ts"));
  setVersion(copy, "1.2.3");
  expect(checkVersions(copy)).toBe("1.2.3");
  await Bun.write(join(copy, "packages/core/package.json"), JSON.stringify({ name: "@faber/core", version: "1.2.2" }));
  expect(() => checkVersions(copy)).toThrow(/disagree[\s\S]*1\.2\.2  packages\/core\/package\.json/);
  expect(() => setVersion(copy, "banana")).toThrow();
  expect(() => setVersion(copy, "1.2.3-rc.1")).toThrow(); // Chrome can't load it
});

describe("Homebrew formula", () => {
  const shas = { "darwin-arm64": "a".repeat(64), "darwin-x64": "b".repeat(64), "linux-x64": "c".repeat(64), "linux-arm64": "d".repeat(64) };
  const f = renderFormula({ version: "1.2.3", baseUrl: "https://example.com/v1.2.3", shas });

  test("has a url and sha for each platform", () => {
    expect(f).toContain(`version "1.2.3"`);
    expect(f).toContain(`on_macos do\n    on_arm do\n      url "https://example.com/v1.2.3/faber-1.2.3-darwin-arm64.tar.gz"\n      sha256 "${"a".repeat(64)}"`);
    expect(f).toContain(`on_intel do\n      url "https://example.com/v1.2.3/faber-1.2.3-linux-x64.tar.gz"`);
  });

  test("runs the service from the stable opt path and restarts it only on failure", () => {
    expect(f).toContain(`run [opt_bin/"faber", "serve"]`);
    expect(f).toContain(`FABER_SERVICE: "1"`);
    expect(f).toContain("keep_alive successful_exit: false");
  });

  test("leaves out platforms that weren't built", () => {
    const mac = renderFormula({ version: "1.2.3", baseUrl: "x", shas: { "darwin-arm64": "a".repeat(64) } });
    expect(mac).not.toContain("on_linux");
    expect(mac).not.toContain("on_intel");
    expect(() => renderFormula({ version: "1.2.3", baseUrl: "x", shas: {} })).toThrow();
  });

  test("is valid Ruby", () => {
    const ruby = Bun.spawnSync(["ruby", "-c", "-e", f]);
    if (ruby.exitCode === null) return; // no ruby here
    expect(ruby.stdout.toString()).toContain("Syntax OK");
  });
});

test("nextVersion bumps patch, minor and major, and refuses anything not newer", () => {
  expect(nextVersion("0.1.3", "patch")).toBe("0.1.4");
  expect(nextVersion("0.1.3", "minor")).toBe("0.2.0");
  expect(nextVersion("0.1.3", "major")).toBe("1.0.0");
  expect(nextVersion("0.1.3", "v0.3.0")).toBe("0.3.0");
  expect(() => nextVersion("0.1.3", "0.1.3")).toThrow("isn't newer");
  expect(() => nextVersion("0.1.3", "0.0.9")).toThrow("isn't newer");
  expect(() => nextVersion("0.1.3", "0.2")).toThrow("isn't patch");
});

test("releaseNotes turns merged PR titles into bullets", () => {
  expect(releaseNotes(["Make search fast (#10)", "Release 0.1.3", "Fix the queue", ""])).toEqual(["- Make search fast", "- Fix the queue"]);
});
