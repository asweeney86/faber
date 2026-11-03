#!/usr/bin/env bun
/**
 * Cut a release: bump the version, snapshot the upgrade fixture, check everything, commit,
 * tag and push. The tag starts .github/workflows/release.yml, which builds macOS and Linux,
 * publishes the GitHub release and updates the Homebrew tap; this waits for it.
 *
 *   npm run release:dry-run           what the next release would contain; changes nothing
 *   npm run release                   next patch version (0.1.3 → 0.1.4)
 *   npm run release minor             or major, or an exact version like 0.2.0
 *   bun scripts/cut-release.ts [patch|minor|major|x.y.z] [--dry-run] [--yes] [--no-wait]
 *
 * (Through npm, flags need a "--" first: npm run release -- minor --no-wait. npm keeps
 * --dry-run for itself otherwise, which is why the dry run has its own script.)
 *
 * Refuses unless you're on an up-to-date, clean main whose CI passed. If a check fails
 * before anything is pushed, the version bump is undone.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkVersions, nextVersion, releaseNotes } from "./release-lib";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const bump = args.find((a) => !a.startsWith("--")) ?? "patch";
const dryRun = flag("--dry-run");

const out = (cmd: string, cmdArgs: string[]) => execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8" }).trim();
const run = (cmd: string, cmdArgs: string[]) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed`);
};
const step = (s: string) => console.log(`\n▸ ${s}`);
const fail = (s: string): never => {
  console.error(`\n✗ ${s}`);
  process.exit(1);
};
/** A precondition: stops a real release; a dry run notes it and carries on, so it shows the whole plan. */
const need = (ok: boolean, s: string) => {
  if (ok) return;
  if (!dryRun) fail(s);
  console.log(`  ! would stop here: ${s}`);
};

// ---- Checks: nothing has changed yet ----
step("Checking main");
need(out("git", ["branch", "--show-current"]) === "main", "Not on main. Switch with: git checkout main");
need(!out("git", ["status", "--porcelain"]), "There are uncommitted changes. Commit or stash them first.");
run("git", ["fetch", "--quiet", "--tags", "origin"]);
const head = out("git", ["rev-parse", "HEAD"]);
need(head === out("git", ["rev-parse", "origin/main"]), "This commit isn't origin/main. Pull (or push) first.");

const current = checkVersions(root);
const version = nextVersion(current, bump);
const tag = `v${version}`;
if (out("git", ["tag", "--list", tag])) fail(`${tag} already exists.`);
const lastTag = out("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"]);
const notes = releaseNotes(out("git", ["log", "--format=%s", `${lastTag}..HEAD`]).split("\n"));
if (!notes.length) fail(`Nothing to release: no commits since ${lastTag}.`);

step("Checking CI on this commit");
const ciRun = () =>
  JSON.parse(out("gh", ["run", "list", "--workflow", "ci.yml", "--commit", head, "--limit", "1", "--json", "databaseId,status,conclusion,url"]))[0] as
    | { databaseId: number; status: string; conclusion: string; url: string }
    | undefined;
let ci = ciRun();
if (ci && ci.status !== "completed" && !dryRun) {
  console.log(`CI is still running; waiting for it: ${ci.url}`);
  spawnSync("gh", ["run", "watch", String(ci.databaseId), "--exit-status"], { cwd: root, stdio: "ignore" });
  ci = ciRun();
}
need(!!ci, "CI hasn't run on this commit yet. Wait for it, then try again.");
if (ci) need(ci.conclusion === "success", `CI hasn't passed on this commit (${ci.status === "completed" ? ci.conclusion : ci.status}): ${ci.url}`);

const message = `Release ${version}\n\n${notes.join("\n")}\n`;
console.log(`\nRelease ${current} → ${version} (${tag}), changes since ${lastTag}:\n${notes.join("\n")}`);
if (dryRun) {
  console.log("\nDry run: nothing changed.");
  process.exit(0);
}
if (!flag("--yes")) {
  const answer = prompt(`\nCommit, tag and push ${tag}? [y/N]`);
  if (!/^y(es)?$/i.test(answer ?? "")) fail("Stopped; nothing changed.");
}

// ---- Bump and check locally; undone if anything fails ----
const fixture = join(root, "packages/core/test/fixtures", `v${version}.sqlite.gz`);
const undo = () => {
  execFileSync("git", ["checkout", "--", "."], { cwd: root });
  rmSync(fixture, { force: true });
};
try {
  step(`Setting the version to ${version}`);
  run("bun", ["scripts/version.ts", version]);
  step("Saving the upgrade fixture");
  run("bun", ["scripts/fixture.ts"]);
  if (!existsSync(fixture)) throw new Error(`No fixture at ${fixture}`);
  step("Type check");
  run("bun", ["run", "typecheck"]);
  step("Tests");
  run("bun", ["run", "test"]);
} catch (e) {
  undo();
  fail(`${e instanceof Error ? e.message : e}. The version bump was undone.`);
}

// ---- Publish ----
step(`Committing and tagging ${tag}`);
run("git", ["add", "-A"]);
run("git", ["commit", "--quiet", "-m", message]);
run("git", ["tag", tag]);
step("Pushing");
run("git", ["push", "--quiet", "origin", "main"]);
run("git", ["push", "--quiet", "origin", tag]);

if (flag("--no-wait")) {
  console.log(`\n✓ Pushed ${tag}. The release workflow builds and publishes it.`);
  process.exit(0);
}
step("Waiting for the release workflow (builds macOS and Linux, publishes, updates Homebrew)");
let rel: { databaseId: number; url: string } | undefined;
for (let i = 0; i < 30 && !rel; i++) {
  await Bun.sleep(4000);
  rel = JSON.parse(out("gh", ["run", "list", "--workflow", "release.yml", "--branch", tag, "--limit", "1", "--json", "databaseId,url"]))[0];
}
if (!rel) fail(`The release workflow didn't start for ${tag}. Check GitHub Actions.`);
console.log(rel!.url);
const watched = spawnSync("gh", ["run", "watch", String(rel!.databaseId), "--exit-status", "--interval", "15"], { cwd: root, stdio: "ignore" });
if (watched.status !== 0) fail(`The release workflow failed: ${rel!.url}\nFix it, then re-run it for the same tag from GitHub Actions (workflow_dispatch with tag ${tag}).`);
console.log(`\n✓ Faber ${version} is out: ${out("gh", ["release", "view", tag, "--json", "url", "-q", ".url"])}`);
