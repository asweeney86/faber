/**
 * Functional test of the real native launcher: builds the app, starts a seeded daemon,
 * and runs `FaberLauncher --selftest`, which drives the app itself (hotkey events,
 * keystrokes through AppKit into the page, the bridge, navigation rules, a web process
 * crash) and prints PASS/FAIL lines. Midway it asks us to stop and restart the daemon.
 *
 * It puts a real panel on screen and takes focus for ~30s, so it only runs when asked:
 *   bun run test:macos        (FABER_MACOS_UI=1 bun test packages/macos)
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const here = import.meta.dir;
const root = join(here, "..", "..");
const enabled = process.platform === "darwin" && process.env.FABER_MACOS_UI === "1";
const PORT = Number(process.env.FABER_MACOS_TEST_PORT ?? 7798);
const base = `http://127.0.0.1:${PORT}`;

setDefaultTimeout(240_000);

async function startDaemon(): Promise<Subprocess> {
  const proc = Bun.spawn(["bun", join(root, "e2e", "fixtures", "serve.ts")], {
    env: { ...process.env, FABER_E2E_PORT: String(PORT) },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/launcher`)).ok) return proc;
    } catch {}
    await Bun.sleep(200);
  }
  proc.kill();
  throw new Error("daemon didn't start");
}

test.skipIf(!enabled)("the native launcher works end to end (--selftest)", async () => {
  const out = join(here, "build", "test");
  mkdirSync(out, { recursive: true });
  execFileSync("bun", [join(here, "build.ts")], { env: { ...process.env, FABER_MACOS_OUT: out }, stdio: "inherit" });

  let daemon = await startDaemon();
  const shots = join(out, "shots");
  mkdirSync(shots, { recursive: true });
  const app = Bun.spawn([join(out, "Faber Launcher.app", "Contents", "MacOS", "FaberLauncher"), "--daemon", base, "--selftest", "--selftest-shots", shots], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const lines: string[] = [];
  try {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of app.stdout) {
      buf += decoder.decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lines.push(line);
        console.log(`  ${line}`);
        if (line === "PAUSE stop-daemon") {
          daemon.kill();
          await daemon.exited;
          app.stdin.write("\n");
          app.stdin.flush();
        } else if (line === "PAUSE start-daemon") {
          daemon = await startDaemon();
          app.stdin.write("\n");
          app.stdin.flush();
        }
      }
    }
    const code = await app.exited;
    const failed = lines.filter((l) => l.startsWith("FAIL"));
    expect(failed).toEqual([]);
    expect(lines.filter((l) => l.startsWith("PASS")).length).toBeGreaterThan(30);
    expect(lines).toContain("SELFTEST OK");
    expect(code).toBe(0);
  } finally {
    app.kill();
    daemon.kill();
  }
});
