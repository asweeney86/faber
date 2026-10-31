#!/usr/bin/env bun
/**
 * Build release artifacts: one tarball per platform, checksums, and the Homebrew formula.
 *
 *   bun scripts/release.ts                         every platform this machine can build
 *   bun scripts/release.ts --targets darwin-arm64  just one
 *   bun scripts/release.ts --base-url file:///…    formula pointing at local files (to test brew install)
 *
 * Output (dist/release/):
 *   faber-<version>-<os>-<arch>.tar.gz   bin/faber, share/faber/extension, share/faber/Faber Launcher.app (macOS)
 *   SHA256SUMS
 *   faber.rb                             the formula for the tap (github.com/asweeney86/homebrew-faber)
 *
 * macOS tarballs need a Mac (the launcher is built with swiftc, binaries are ad-hoc signed).
 * CI runs this on a macOS runner for every tag; see .github/workflows/release.yml.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkVersions, renderFormula, TARGETS, type Target } from "./release-lib";

const root = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const version = checkVersions(root);
const out = flag("out") ?? join(root, "dist", "release");
const baseUrl = flag("base-url") ?? `https://github.com/asweeney86/faber/releases/download/v${version}`;
const wanted = (flag("targets")?.split(",") ?? TARGETS.filter((t) => process.platform === "darwin" || !t.startsWith("darwin"))) as Target[];
for (const t of wanted) if (!TARGETS.includes(t)) throw new Error(`Unknown target ${t}; one of ${TARGETS.join(", ")}`);
if (wanted.some((t) => t.startsWith("darwin")) && process.platform !== "darwin") throw new Error("macOS targets must be built on a Mac");

if (!existsSync(join(root, "packages/core/test/fixtures", `v${version}.sqlite.gz`))) {
  console.warn(`! No upgrade fixture for ${version}. Run \`bun scripts/fixture.ts\` and commit it, so later releases are tested against this one.`);
  if (argv.includes("--strict")) process.exit(1);
}

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, env: { ...process.env, ...env } });

rmSync(out, { recursive: true, force: true });
const stage = join(out, "stage");
mkdirSync(stage, { recursive: true });

console.log(`Building Faber ${version} for ${wanted.join(", ")}`);

// Shared pieces: the extension (all platforms) and the universal launcher app (macOS).
const extension = join(stage, "extension");
run("bun", ["packages/extension/build.ts"], { FABER_EXT_OUT: extension });
let launcher: string | null = null;
if (wanted.some((t) => t.startsWith("darwin"))) {
  const macOut = join(stage, "macos");
  run("bun", ["packages/macos/build.ts"], { FABER_MACOS_OUT: macOut, FABER_MACOS_UNIVERSAL: "1" });
  launcher = join(macOut, "Faber Launcher.app");
}

const sums: string[] = [];
const shas: Partial<Record<Target, string>> = {};
for (const target of wanted) {
  const name = `faber-${version}-${target}`;
  const dir = join(stage, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "share", "faber"), { recursive: true });
  const bin = join(dir, "bin", "faber");
  run("bun", ["build", "--compile", "--minify", `--target=bun-${target}`, "packages/daemon/src/cli.ts", "--outfile", bin], { NODE_ENV: "production" });
  // Apple silicon refuses unsigned code; cross-compiled binaries need an (ad-hoc) signature.
  if (target.startsWith("darwin")) run("codesign", ["--force", "--sign", "-", bin]);
  cpSync(extension, join(dir, "share", "faber", "extension"), { recursive: true });
  if (target.startsWith("darwin") && launcher) run("ditto", [launcher, join(dir, "share", "faber", "Faber Launcher.app")]);
  for (const f of ["LICENSE", "README.md"]) cpSync(join(root, f), join(dir, f));
  const tarball = join(out, `${name}.tar.gz`);
  // COPYFILE_DISABLE: no macOS ._ resource files in the archive.
  run("tar", ["-czf", tarball, "-C", stage, name], { COPYFILE_DISABLE: "1" });
  const sha = new Bun.CryptoHasher("sha256").update(new Uint8Array(readFileSync(tarball))).digest("hex");
  shas[target] = sha;
  sums.push(`${sha}  ${name}.tar.gz`);
  console.log(`✓ ${name}.tar.gz`);
}

writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
writeFileSync(join(out, "faber.rb"), renderFormula({ version, baseUrl, shas }));
rmSync(stage, { recursive: true, force: true });
console.log(`\nWrote ${out}`);
