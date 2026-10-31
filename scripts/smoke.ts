#!/usr/bin/env bun
/**
 * Test a release tarball the way a user gets it: unpack, run, set up, upgrade.
 *
 *   bun scripts/smoke.ts dist/release/faber-0.1.0-darwin-arm64.tar.gz
 *   bun scripts/smoke.ts <new.tar.gz> --upgrade-from <old.tar.gz>
 *
 * Everything runs in a throwaway home on a spare port, with the offline fake AI providers.
 * With --upgrade-from, the old release writes real data first; the new one must keep all
 * of it, and the old one must still open the data afterwards (rolling back must work too).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const tarball = argv[0];
const fromIdx = argv.indexOf("--upgrade-from");
const fromTarball = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;
if (!tarball) {
  console.error("usage: bun scripts/smoke.ts <faber-*.tar.gz> [--upgrade-from <older faber-*.tar.gz>]");
  process.exit(2);
}

const work = realpathSync(mkdtempSync(join(tmpdir(), "faber-smoke-")));
const home = join(work, "home");
const port = 7790 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, FABER_HOME: home, FABER_APPS_DIR: join(work, "Applications"), NO_COLOR: "1" };
delete (env as Record<string, string | undefined>).FABER_SERVICE;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

function unpack(file: string, into: string): string {
  spawnSync("mkdir", ["-p", into]);
  const r = spawnSync("tar", ["-xzf", file, "-C", into]);
  if (r.status !== 0) throw new Error(`couldn't unpack ${file}`);
  const [top] = readdirSync(into);
  return join(into, top!);
}

function faber(root: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(join(root, "bin", "faber"), args, { env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

async function serve(root: string): Promise<ChildProcess> {
  const proc = spawn(join(root, "bin", "faber"), ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) return proc;
    } catch {}
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error(`daemon didn't start:\n${log}`);
}

async function stop(proc: ChildProcess) {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.once("exit", r));
}

const status = async () => (await (await fetch(`${base}/api/status`)).json()) as { version: string; docs: number; enriched: number };

function setupHome() {
  spawnSync("mkdir", ["-p", home]);
  writeFileSync(
    join(home, "config.toml"),
    `[daemon]\nport = ${port}\n[embed]\nprovider = "fake"\nmodel = "fake-embed"\n[enrich]\nprovider = "fake"\nmodel = "fake-enrich"\n`,
  );
}

/** Chrome's id for an unpacked folder (see packages/daemon/src/install/setup.ts). */
const extId = (path: string) =>
  [...createHash("sha256").update(path).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

const newRoot = unpack(tarball, join(work, "new"));
const version = faber(newRoot, ["version"]).out.trim();
setupHome();

if (fromTarball) {
  // ---- upgrade, laid out like Homebrew: Cellar/faber/<v> kegs and an opt/faber symlink ----
  const prefix = join(work, "prefix");
  const keg = (v: string) => join(prefix, "Cellar", "faber", v);
  const link = (v: string) => {
    spawnSync("mkdir", ["-p", join(prefix, "opt")]);
    spawnSync("rm", ["-f", join(prefix, "opt", "faber")]);
    spawnSync("ln", ["-s", keg(v), join(prefix, "opt", "faber")]);
  };
  const oldRoot = unpack(fromTarball, join(work, "old"));
  const oldVersion = faber(oldRoot, ["version"]).out.trim();
  console.log(`Upgrade ${oldVersion} → ${version} in ${work}`);
  if (oldVersion === version) {
    console.log(`Both tarballs are ${version}: nothing to upgrade.`);
    process.exit(0);
  }
  spawnSync("mkdir", ["-p", join(prefix, "Cellar", "faber")]);
  spawnSync("cp", ["-R", oldRoot, keg(oldVersion)]);
  link(oldVersion);
  const opt = join(prefix, "opt", "faber");

  check("old release seeds demo data", faber(opt, ["demo"]).code === 0);
  check("old release sets up the extension", faber(opt, ["setup", "--yes", "--no-service", "--no-ai", "--no-launcher", "--no-open"]).code === 0);

  // A stand-in for launchd's KeepAlive { SuccessfulExit = false }: restart on any non-zero exit.
  let child: ChildProcess | null = null;
  let supervising = true;
  const restarts: number[] = [];
  const supervise = () => {
    child = spawn(join(opt, "bin", "faber"), ["serve"], { env: { ...env, FABER_SERVICE: "1", FABER_UPGRADE_POLL_MS: "300" }, stdio: "ignore" });
    child.once("exit", (code) => {
      restarts.push(code ?? -1);
      if (supervising && code !== 0) setTimeout(supervise, 200);
    });
  };
  supervise();
  const until = async (pred: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await pred()) return true;
      } catch {}
      await Bun.sleep(200);
    }
    return false;
  };
  check("old daemon starts", await until(async () => (await status()).version === oldVersion, 15_000));
  const before = await status();

  // brew upgrade: install the new keg, then repoint opt/.
  spawnSync("cp", ["-R", newRoot, keg(version)]);
  link(version);
  check("the running daemon restarts itself into the new version", await until(async () => (await status()).version === version, 20_000), `exits: ${restarts.join(",")}`);
  check("it asked to be restarted (exit 75), not stopped", restarts[0] === 75, `exits: ${restarts.join(",")}`);
  const after = await status();
  check("no documents lost", after.docs === before.docs, `${before.docs} → ${after.docs}`);
  check("no enrichments lost", after.enriched === before.enriched, `${before.enriched} → ${after.enriched}`);
  const manifest = JSON.parse(await Bun.file(join(home, "extension", "manifest.json")).text()) as { version: string };
  check("the installed extension was updated to the new version", manifest.version === version, manifest.version);
  const search = faber(opt, ["search", "gateway", "--json"]);
  check("search works on upgraded data", search.code === 0 && (JSON.parse(search.out) as { hits: unknown[] }).hits.length > 0, search.out.slice(0, 300));
  supervising = false;
  if (child) await stop(child);

  // Roll back: the old version must still open the upgraded data.
  link(oldVersion);
  const back = faber(opt, ["status"]);
  check("the old release still opens the upgraded data (rollback)", back.code === 0 && back.out.includes(`docs      ${before.docs}`), back.out);
} else {
  // ---- a fresh install ----
  console.log(`Smoke test ${version} in ${work}`);
  check("faber version", /^\d+\.\d+\.\d+/.test(version), version);
  check("faber help", faber(newRoot, ["help"]).out.includes("faber setup"));
  check("bundles the extension", existsSync(join(newRoot, "share", "faber", "extension", "manifest.json")));
  if (process.platform === "darwin") {
    const app = join(newRoot, "share", "faber", "Faber Launcher.app");
    check("bundles the launcher app", existsSync(join(app, "Contents", "MacOS", "FaberLauncher")));
    check("the launcher app is signed", spawnSync("codesign", ["--verify", "--deep", app]).status === 0);
    check("the binary is signed", spawnSync("codesign", ["--verify", join(newRoot, "bin", "faber")]).status === 0);
  }
  check("faber demo", faber(newRoot, ["demo"]).code === 0);

  const d = await serve(newRoot);
  const s = await status();
  check("daemon serves the API", s.version === version && s.docs > 0, JSON.stringify(s));
  for (const path of ["/", "/launcher", "/favicon.ico"]) {
    const res = await fetch(base + path);
    check(`daemon serves ${path}`, res.ok && (path === "/favicon.ico" || (await res.text()).includes("<script")));
  }
  const page = await (await fetch(base + "/")).text();
  for (const asset of page.match(/(?:src|href)="(\/[^"]+)"/g) ?? []) {
    const url = asset.replace(/^(src|href)="|"$/g, "");
    check(`asset ${url}`, (await fetch(base + url)).ok);
  }
  const search = faber(newRoot, ["search", "gateway", "--json"]);
  check("CLI search", search.code === 0 && (JSON.parse(search.out) as { hits: unknown[] }).hits.length > 0);

  const setup = faber(newRoot, ["setup", "--yes", "--no-service", "--no-ai", "--no-launcher", "--no-open"]);
  check("faber setup (non-interactive)", setup.code === 0 && setup.out.includes("Load unpacked"), setup.out);
  const ext = join(home, "extension");
  check("setup installs the extension in the data home", existsSync(join(ext, "manifest.json")));
  const listed = faber(newRoot, ["extensions"]).out;
  check("setup pre-approves exactly that copy", listed.includes(extId(realpathSync(ext))), listed);
  const doctor = faber(newRoot, ["doctor"]);
  check("faber doctor runs", doctor.out.includes(`Daemon running at ${base}`), doctor.out);
  await stop(d);
}

console.log(failures ? `\n${failures} check(s) failed (files kept in ${work})` : "\nSMOKE OK");
if (!failures) spawnSync("rm", ["-rf", work]);
process.exit(failures ? 1 : 0);
