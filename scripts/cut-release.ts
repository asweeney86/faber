#!/usr/bin/env bun
/**
 * Cut a release, interactively:
 *
 *   npm run release
 *
 * Checks that main is clean, up to date and passing CI, shows what changed since the last
 * release, and offers the next minor version (or patch, major, or one you type). Then it
 * sets the version, saves the upgrade fixture, runs the type check and tests, commits,
 * tags, pushes, and follows the release workflow (build, GitHub release, Homebrew) to the end.
 * Nothing changes until you confirm; if a local step fails, the version bump is undone.
 *
 * Without a terminal (scripts, CI): bun scripts/cut-release.ts <patch|minor|major|x.y.z> --yes
 */
import * as p from "@clack/prompts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { checkVersions, nextVersion, releaseNotes } from "./release-lib";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const given = args.find((a) => !a.startsWith("--"));
const yes = args.includes("--yes");
const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const ansi = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
const bold = ansi(1, 22);
const dim = ansi(2, 22);
const cyan = ansi(36, 39);
const badge = (s: string) => (color ? `\x1b[46m\x1b[30m${s}\x1b[39m\x1b[49m` : s);

/** Run a command quietly; resolves with its stdout, rejects with the tail of its output. */
async function sh(cmd: string, cmdArgs: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...cmdArgs], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    const tail = `${stdout}${stderr}`.trim().split("\n").slice(-30).join("\n");
    throw new Error(tail || `${cmd} ${cmdArgs.join(" ")} exited with ${code}`);
  }
  return stdout.trim();
}

const stop = (message: string, code = 1): never => {
  p.cancel(message);
  process.exit(code);
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One step with a spinner: ✓ and `done` (or the label) when it works; ✗, the error and stop when not. */
async function step<T>(label: string, run: (s: ReturnType<typeof p.spinner>) => Promise<T>, done?: (r: T) => string, onFail?: () => void): Promise<T> {
  const s = p.spinner();
  s.start(label);
  try {
    const r = await run(s);
    s.stop(done ? done(r) : label);
    return r;
  } catch (e) {
    s.error(label);
    onFail?.();
    p.log.error(message(e));
    return stop(onFail ? "Release stopped. The version bump was undone." : "Release stopped. Nothing changed.");
  }
}

console.log();
p.intro(badge(" Faber release "));

// ---- Where we are ----
type Ci = { databaseId: number; status: string; conclusion: string; url: string };
const ciFor = async (sha: string) =>
  (JSON.parse(await sh("gh", ["run", "list", "--workflow", "ci.yml", "--commit", sha, "--limit", "1", "--json", "databaseId,status,conclusion,url"])) as Ci[])[0];

const { current, lastTag, notes } = await step(
  "Checking main",
  async (s) => {
    if ((await sh("git", ["branch", "--show-current"])) !== "main") throw new Error("Not on main. Switch with: git checkout main");
    if (await sh("git", ["status", "--porcelain"])) throw new Error("There are uncommitted changes. Commit or stash them first.");
    await sh("git", ["fetch", "--quiet", "--tags", "origin"]);
    const head = await sh("git", ["rev-parse", "HEAD"]);
    if (head !== (await sh("git", ["rev-parse", "origin/main"]))) throw new Error("main differs from origin/main. Pull (or push) first.");
    const lastTag = await sh("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"]);
    const notes = releaseNotes((await sh("git", ["log", "--format=%s", `${lastTag}..HEAD`])).split("\n"));
    if (!notes.length) throw new Error(`Nothing to release: no commits since ${lastTag}.`);

    let ci = await ciFor(head);
    if (!ci) throw new Error("CI hasn't run on this commit yet. Try again in a minute.");
    if (ci.status !== "completed") {
      s.message(`Waiting for CI on ${head.slice(0, 7)} ${dim(ci.url)}`);
      await sh("gh", ["run", "watch", String(ci.databaseId), "--interval", "10"]).catch(() => {});
      ci = (await ciFor(head))!;
    }
    if (ci.conclusion !== "success") throw new Error(`CI didn't pass on this commit (${ci.conclusion}): ${ci.url}`);
    return { current: checkVersions(root), head, lastTag, notes };
  },
  (r) => `main is clean, up to date, and CI passed ${dim(`(${r.head.slice(0, 7)})`)}`,
);

p.note(notes.join("\n"), `${notes.length} change${notes.length === 1 ? "" : "s"} since ${lastTag}`);

// ---- Which version ----
async function chooseVersion(): Promise<string> {
  if (given) {
    try {
      const v = nextVersion(current, given);
      p.log.step(`Version ${bold(v)}`);
      return v;
    } catch (e) {
      return stop(message(e));
    }
  }
  if (!interactive) return stop("Not in a terminal: pass the version and --yes, e.g. bun scripts/cut-release.ts minor --yes");
  const choice = await p.select({
    message: `Next version ${dim(`(now ${current})`)}`,
    initialValue: "minor",
    options: [
      { value: "minor", label: nextVersion(current, "minor"), hint: "minor: new features" },
      { value: "patch", label: nextVersion(current, "patch"), hint: "patch: fixes only" },
      { value: "major", label: nextVersion(current, "major"), hint: "major: breaking changes" },
      { value: "other", label: "Something else…" },
    ],
  });
  if (p.isCancel(choice)) return stop("Cancelled. Nothing changed.", 0);
  if (choice !== "other") return nextVersion(current, choice);
  const typed = await p.text({
    message: "Version",
    placeholder: nextVersion(current, "minor"),
    validate: (v) => {
      try {
        nextVersion(current, (v ?? "").trim());
      } catch (e) {
        return message(e);
      }
    },
  });
  if (p.isCancel(typed)) return stop("Cancelled. Nothing changed.", 0);
  return nextVersion(current, typed.trim());
}
const version = await chooseVersion();
const tag = `v${version}`;
if (await sh("git", ["tag", "--list", tag])) stop(`${tag} already exists.`);

if (!yes) {
  if (!interactive) stop("Not in a terminal: add --yes to release without asking.");
  const ok = await p.confirm({ message: `Release ${bold(tag)}? This commits, tags and pushes to main.` });
  if (p.isCancel(ok) || !ok) stop("Cancelled. Nothing changed.", 0);
}

// ---- Local steps: undone if any fails (or on Ctrl+C) ----
const fixture = join(root, "packages/core/test/fixtures", `v${version}.sqlite.gz`);
const undo = () => {
  Bun.spawnSync(["git", "checkout", "--", "."], { cwd: root });
  rmSync(fixture, { force: true });
};
const onInterrupt = () => {
  undo();
  p.cancel("Interrupted. The version bump was undone.");
  process.exit(130);
};
process.on("SIGINT", onInterrupt);

await step(`Setting the version to ${version}`, () => sh("bun", ["scripts/version.ts", version]), undefined, undo);
await step("Saving the upgrade fixture", () => sh("bun", ["scripts/fixture.ts"]), () => `Saved the upgrade fixture ${dim(`v${version}.sqlite.gz`)}`, undo);
await step("Type check", () => sh("bun", ["run", "typecheck"]), () => "Type check passed", undo);
await step(
  "Running the tests",
  async () => {
    const proc = Bun.spawn(["bun", "run", "test"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [o, e, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const all = `${o}${e}`;
    if (code !== 0) {
      const failures = all.split("\n").filter((l) => /\(fail\)/.test(l));
      throw new Error((failures.length ? failures : all.split("\n").slice(-30)).join("\n"));
    }
    return /(\d+) pass/.exec(all)?.[1] ?? "all";
  },
  (n) => `Tests passed ${dim(`(${n})`)}`,
  undo,
);

// ---- Publish ----
process.off("SIGINT", onInterrupt);
await step(`Committing and tagging ${tag}`, async () => {
  await sh("git", ["add", "-A"]);
  await sh("git", ["commit", "--quiet", "-m", `Release ${version}\n\n${notes.join("\n")}\n`]);
  await sh("git", ["tag", tag]);
});
await step("Pushing to GitHub", async () => {
  await sh("git", ["push", "--quiet", "origin", "main"]);
  await sh("git", ["push", "--quiet", "origin", tag]);
});

const run = await step(
  "Starting the release workflow",
  async () => {
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(4000);
      const r = (JSON.parse(await sh("gh", ["run", "list", "--workflow", "release.yml", "--branch", tag, "--limit", "1", "--json", "databaseId,url"])) as { databaseId: number; url: string }[])[0];
      if (r) return r;
    }
    throw new Error(`The release workflow didn't start for ${tag}. Check GitHub Actions.`);
  },
  (r) => `Release workflow started ${dim(r.url)}`,
);

const s = p.spinner({ indicator: "timer" });
s.start(`Building macOS and Linux, publishing, updating Homebrew ${dim("(Ctrl+C stops watching; the release carries on)")}`);
try {
  await sh("gh", ["run", "watch", String(run.databaseId), "--exit-status", "--interval", "15"]);
  s.stop("Built, published, and Homebrew updated");
} catch {
  s.error("The release workflow failed");
  p.log.error(`${run.url}\nFix it, then re-run the workflow for ${tag} from GitHub Actions (Run workflow, tag ${tag}).`);
  process.exit(1);
}

const url = await sh("gh", ["release", "view", tag, "--json", "url", "-q", ".url"]).catch(() => run.url);
p.outro(`${bold(`Faber ${version} is out`)} ${cyan(url)}\n   ${dim("Upgrade with: brew upgrade faber")}`);
