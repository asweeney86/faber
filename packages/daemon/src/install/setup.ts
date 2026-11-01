/**
 * `faber setup`: everything after `brew install faber`, in one guided pass. Safe to run
 * again at any time; each step checks what's already done and only does the rest.
 *
 *   1. Local AI: Ollama installed and running, models pulled (a lighter one on <16 GB Macs)
 *   2. The daemon as a background service (starts at login, restarts after upgrades)
 *   3. The Chrome extension, copied to a stable folder and pre-approved for this daemon
 *   4. The native launcher (macOS) in ~/Applications, optionally opened at login
 *   5. What to watch, and an optional import of recent Google docs from Chrome history
 *
 * `faber doctor` runs the same checks without changing anything; `faber uninstall` undoes 2–4.
 */
import { createHash } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import {
  approveExtension,
  askConfig,
  configHome,
  DB_FILE,
  getSettings,
  hasModel,
  importChromeHistory,
  listChromeProfiles,
  listExtensions,
  loadConfig,
  ollamaModels,
  removeExtension,
  saveSettings,
  setConfigValue,
  SCHEMA_VERSION,
  type ChromeProfile,
  type Config,
  type ProviderConfig,
} from "@faber/core";
import type { Database } from "bun:sqlite";
import { VERSION } from "../version";
import { appVersion, extensionVersion, syncExtension, syncLauncher } from "./assets";
import { detectLayout, extensionInstallPath, launcherInstallPath, type Layout } from "./layout";
import { MODEL_CHOICES, sameModel } from "@faber/shared";
import { detectOllama, findBrew, gb, LOW_MEMORY_BYTES, pullModel, startOllama, waitFor } from "./ollama";
import { installService, serviceInstalled, serviceKind, uninstallService } from "./service";

/** Chrome's id for an unpacked extension: the first 128 bits of sha256(path), as hex digits mapped 0-f → a-p. */
export function chromeExtensionId(path: string): string {
  const hex = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// ---------- terminal I/O ----------

export interface Io {
  interactive: boolean;
  line(text?: string): void;
  /** Rewrite the current line (progress bars). */
  status(text: string): void;
  confirm(question: string, def: boolean): Promise<boolean>;
  /** Pick one of `options`; returns its index. */
  choose(question: string, options: string[], def: number): Promise<number>;
  /** Resolves when the user presses Enter (never, when not interactive); cancel() stops waiting. */
  enter(): { done: Promise<void>; cancel(): void };
  /** Stop reading the terminal, so the process can exit. */
  close(): void;
}

const color = (code: number) => (s: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const yellow = color(33);
const red = color(31);
const dim = color(2);
const bold = color(1);

export const OK = green("✓");
export const WARN = yellow("!");
export const FAIL = red("✗");

export function terminalIo(assumeYes: boolean): Io {
  const interactive = !assumeYes && !!process.stdin.isTTY;
  // One reader for every prompt. A waiter that gave up (e.g. "press Enter to skip" once
  // Chrome connected) is removed, so it can't swallow the answer to the next question.
  let rl: Interface | null = null;
  const waiters: ((line: string) => void)[] = [];
  const queued: string[] = [];
  const ensureReader = () => {
    if (rl) return;
    rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      const w = waiters.shift();
      if (w) w(line);
      else queued.push(line);
    });
    rl.on("close", () => {
      for (const w of waiters.splice(0)) w("");
    });
  };
  const waitLine = (): { line: Promise<string>; cancel(): void } => {
    ensureReader();
    const q = queued.shift();
    if (q !== undefined) return { line: Promise.resolve(q), cancel() {} };
    let resolve!: (l: string) => void;
    const line = new Promise<string>((r) => (resolve = r));
    waiters.push(resolve);
    return {
      line,
      cancel() {
        const i = waiters.indexOf(resolve);
        if (i >= 0) waiters.splice(i, 1);
      },
    };
  };
  const nextLine = () => waitLine().line;
  let statusShown = false;
  const clearStatus = () => {
    if (statusShown) process.stdout.write("\r\x1b[2K");
    statusShown = false;
  };
  return {
    interactive,
    line(text = "") {
      clearStatus();
      console.log(text);
    },
    status(text) {
      if (!process.stdout.isTTY) return;
      process.stdout.write(`\r\x1b[2K${text}`);
      statusShown = true;
    },
    async confirm(question, def) {
      clearStatus();
      if (!interactive) return def;
      process.stdout.write(`  ${bold("?")} ${question} ${dim(def ? "[Y/n]" : "[y/N]")} `);
      const a = (await nextLine()).trim().toLowerCase();
      return a === "" ? def : a.startsWith("y");
    },
    async choose(question, options, def) {
      clearStatus();
      if (!interactive) return def;
      console.log(`  ${bold("?")} ${question}`);
      options.forEach((o, i) => console.log(`    ${dim(`${i + 1}.`)} ${o}`));
      for (;;) {
        process.stdout.write(`    ${dim(`Number [${def + 1}]:`)} `);
        const a = (await nextLine()).trim();
        if (a === "") return def;
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      }
    },
    enter() {
      if (!interactive) return { done: new Promise<void>(() => {}), cancel() {} };
      const w = waitLine();
      return { done: w.line.then(() => {}), cancel: w.cancel };
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}

// ---------- the host system (stubbed in tests) ----------

export interface Host {
  platform: NodeJS.Platform;
  /** `open` on macOS, xdg-open on Linux. */
  open(target: string, extra?: string[]): boolean;
  copy(text: string): boolean;
  run(cmd: string, args: string[]): number;
  hasChrome(): boolean;
  chromeProfiles(): ChromeProfile[];
}

export const realHost: Host = {
  platform: process.platform,
  open(target, extra = []) {
    if (process.platform !== "darwin") return spawnSync("xdg-open", [target], { stdio: "ignore" }).status === 0;
    // open [options] <target> [--args app arguments...]: the target goes before --args.
    const i = extra.indexOf("--args");
    const [options, appArgs] = i >= 0 ? [extra.slice(0, i), extra.slice(i)] : [extra, []];
    return spawnSync("open", [...options, target, ...appArgs], { stdio: "ignore" }).status === 0;
  },
  copy(text) {
    const cmd = process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
    return spawnSync(cmd[0]!, cmd.slice(1), { input: text, stdio: ["pipe", "ignore", "ignore"] }).status === 0;
  },
  run(cmd, args) {
    return spawnSync(cmd, args, { stdio: "inherit" }).status ?? 1;
  },
  hasChrome() {
    if (process.platform === "darwin") return existsSync("/Applications/Google Chrome.app") || existsSync(join(homedir(), "Applications/Google Chrome.app"));
    return spawnSync("sh", ["-c", "command -v google-chrome || command -v google-chrome-stable"], { stdio: "ignore" }).status === 0;
  },
  chromeProfiles() {
    try {
      return listChromeProfiles();
    } catch {
      return [];
    }
  },
};

// ---------- shared checks ----------

const daemonUrl = (cfg: Config) => `http://${cfg.daemon.host.includes(":") ? `[${cfg.daemon.host}]` : cfg.daemon.host}:${cfg.daemon.port}`;
const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

export async function daemonVersion(cfg: Config): Promise<string | null> {
  try {
    const res = await fetch(`${daemonUrl(cfg)}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function ollamaBase(cfg: Config): string | null {
  const pcs = [cfg.embed, cfg.enrich, askConfig(cfg)].filter((p) => p.provider === "ollama");
  return pcs.length ? (pcs[0]!.base_url ?? "http://127.0.0.1:11434") : null;
}

function ollamaWanted(cfg: Config): string[] {
  const pcs: ProviderConfig[] = [cfg.enrich, cfg.embed, askConfig(cfg)].filter((p) => p.provider === "ollama");
  return [...new Set(pcs.map((p) => p.model))];
}

/** The approved extension that is this install's copy, if Chrome has used it. */
function extensionState(db: Database, home: string): { id: string; approved: boolean; lastSeen: number | null } {
  const dir = extensionInstallPath(home);
  const id = chromeExtensionId(existsSync(dir) ? realpathSync(dir) : dir);
  const entry = listExtensions(db).find((e) => e.id === id);
  return { id, approved: entry?.state === "approved" || entry?.state === "config", lastSeen: entry?.last_seen_at ?? null };
}

/** Write one value into config.toml (keeping comments) and return the reloaded config. */
function editConfig(cfg: Config, section: string, key: string, value: string): Config {
  const path = join(cfg.home, "config.toml");
  writeFileSync(path, setConfigValue(readFileSync(path, "utf8"), section, key, value));
  return loadConfig();
}

// ---------- setup ----------

export interface SetupOptions {
  service: boolean;
  ai: boolean;
  extension: boolean;
  launcher: boolean;
  open: boolean;
}

export interface SetupDeps {
  io: Io;
  host: Host;
  layout: Layout;
  db: Database;
  cfg: Config;
}

/** Returns true when everything needed for a working install is in place. */
export async function runSetup(deps: SetupDeps, opts: SetupOptions): Promise<boolean> {
  const { io, host, layout, db } = deps;
  let cfg = deps.cfg;
  let ok = true;
  io.line(`${bold(`Faber ${VERSION}`)} ${dim(`· data in ${tilde(cfg.home)}`)}`);

  // 1. Local AI
  if (opts.ai) {
    io.line();
    io.line(bold("Local AI"));
    const r = await setupAi(deps, cfg);
    cfg = r.cfg;
    ok &&= r.ok;
  }

  // 2. Background service
  io.line();
  io.line(bold("Faber daemon"));
  const customHome = !!process.env.FABER_HOME;
  const running = await daemonVersion(cfg);
  if (opts.service && !customHome && serviceKind(layout) !== "none") {
    try {
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
      const msg = installService(layout, { home: cfg.home, env, logFile: join(cfg.home, "logs", "daemon.log") });
      const up = await waitFor(async () => (await daemonVersion(cfg)) === VERSION, 20_000);
      if (up) io.line(`  ${OK} Running at ${daemonUrl(cfg)} ${dim(`(${msg})`)}`);
      else {
        const v = await daemonVersion(cfg);
        ok = false;
        io.line(
          v
            ? `  ${FAIL} Another Faber (${v}) is answering on port ${cfg.daemon.port}. Stop it (e.g. close the terminal running \`faber serve\`), then run \`faber setup\` again.`
            : `  ${FAIL} The service didn't come up. See ${tilde(serviceKind(layout) === "brew" ? join(layout.brewPrefix!, "var", "log", "faber.log") : join(cfg.home, "logs", "daemon.log"))}, or run \`faber serve\` to see why.`,
        );
      }
    } catch (err) {
      ok = false;
      io.line(`  ${FAIL} ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (running) {
    io.line(`  ${OK} Running at ${daemonUrl(cfg)}${running === VERSION ? "" : ` (version ${running})`}`);
  } else {
    io.line(`  ${WARN} Not running as a service${customHome ? " (FABER_HOME is set)" : ""}. Start it with: faber serve`);
  }

  // 3. Chrome extension
  if (opts.extension) {
    io.line();
    io.line(bold("Chrome extension"));
    ok = (await setupExtension(deps, cfg, opts.open)) && ok;
  }

  // 4. Native launcher
  if (opts.launcher && host.platform === "darwin") {
    io.line();
    io.line(bold("Launcher (⌥Space)"));
    await setupLauncher(deps, cfg);
  }

  // 5. Sources
  io.line();
  io.line(bold("Your documents"));
  await setupSources(deps);

  io.line();
  const up = (await daemonVersion(cfg)) !== null;
  if (ok && up) {
    io.line(`${OK} ${bold("Faber is ready.")} Open ${daemonUrl(cfg)}${host.platform === "darwin" && opts.launcher ? ", or press ⌥Space anywhere" : ""}.`);
    if (opts.open && io.interactive) host.open(daemonUrl(cfg));
  } else if (ok) {
    io.line(`${OK} ${bold("Set up.")} Start Faber with \`faber serve\`, then open ${daemonUrl(cfg)}.`);
  } else {
    io.line(`${WARN} Almost there: fix the items marked ${FAIL} above, then run \`faber setup\` again (or \`faber doctor\` to check).`);
  }
  return ok;
}

async function setupAi(deps: SetupDeps, cfg: Config): Promise<{ ok: boolean; cfg: Config }> {
  const { io, host } = deps;
  const base = ollamaBase(cfg);
  if (!base) {
    io.line(`  ${OK} Using ${cfg.enrich.provider}/${cfg.enrich.model} (no Ollama needed)`);
    return { ok: true, cfg };
  }
  let models = await ollamaModels(base);
  if (!models) {
    let install = detectOllama();
    if (install.kind === "missing") {
      if (install.brew && (await io.confirm("Ollama runs the AI models on this computer. Install it with Homebrew?", true))) {
        io.line(dim("  brew install ollama"));
        if (host.run(install.brew, ["install", "ollama"]) === 0) install = { kind: "brew", brew: install.brew };
      }
      if (install.kind === "missing") {
        io.line(`  ${FAIL} Ollama isn't installed. Get it from https://ollama.com/download, then run \`faber setup\` again.`);
        return { ok: false, cfg };
      }
    }
    io.status("  … starting Ollama");
    const started = startOllama(install);
    models = (await waitFor(async () => (await ollamaModels(base)) !== null, started ? 60_000 : 3_000)) ? await ollamaModels(base) : null;
    if (!models) {
      io.line(`  ${FAIL} Ollama isn't running at ${base}. Open the Ollama app or run \`ollama serve\`, then run \`faber setup\` again.`);
      return { ok: false, cfg };
    }
  }
  io.line(`  ${OK} Ollama is running`);

  // Before the big download, offer the choice of models (unless one is already downloaded, or
  // the config names a model of the user's own). Change later in Settings or `faber models`.
  const lowMemory = totalmem() < LOW_MEMORY_BYTES;
  for (const [kind, what] of [
    ["enrich", "Which model should write summaries?"],
    ["embed", "Which model should index documents for search?"],
  ] as const) {
    const pc = cfg[kind];
    const choices = MODEL_CHOICES[kind];
    const current = choices.findIndex((c) => sameModel(c.id, pc.model));
    if (!io.interactive || pc.provider !== "ollama" || current === -1 || hasModel(models, pc.model)) continue;
    const pick = await io.choose(
      what,
      choices.map((c) => {
        const warn = lowMemory && c.size_gb > 4 ? yellow(` This computer has ${gb(totalmem())} of memory, so it may be slow.`) : "";
        return `${bold(c.label)} ${dim(`${c.id}, ${c.size_gb} GB`)}: ${c.detail}${warn}`;
      }),
      current,
    );
    if (pick !== current) {
      cfg = editConfig(cfg, kind, "model", choices[pick]!.id);
      io.line(`  ${OK} Set ${kind}.model = "${choices[pick]!.id}"`);
    }
  }

  let ok = true;
  for (const model of ollamaWanted(cfg)) {
    if (hasModel(models, model)) {
      io.line(`  ${OK} ${model}`);
      continue;
    }
    if (!(await io.confirm(`Download the ${model} model now? (a few GB, once)`, true))) {
      io.line(`  ${WARN} Skipped ${model}. Later: ollama pull ${model}`);
      ok = false;
      continue;
    }
    try {
      let last = 0;
      await pullModel(base, model, (p) => {
        if (Date.now() - last < 150) return;
        last = Date.now();
        const pct = p.total ? ` ${Math.floor(((p.completed ?? 0) / p.total) * 100)}%  ${gb(p.completed ?? 0)} / ${gb(p.total)}` : "";
        io.status(`  ↓ ${model}  ${p.status}${pct}`);
      });
      io.line(`  ${OK} ${model}`);
    } catch (err) {
      ok = false;
      io.line(`  ${FAIL} ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok, cfg };
}

async function setupExtension(deps: SetupDeps, cfg: Config, openApps: boolean): Promise<boolean> {
  const { io, host, layout, db } = deps;
  const dest = extensionInstallPath(cfg.home);
  const r = syncExtension(layout.extensionSrc, dest, true);
  if (r === "unavailable") {
    io.line(`  ${WARN} This copy of Faber has no extension bundled. From a source checkout: bun run build:extension, then faber setup.`);
    return true;
  }
  // Pre-approve exactly this copy: Chrome derives an unpacked extension's id from its folder.
  const state = extensionState(db, cfg.home);
  if (!state.approved) approveExtension(db, state.id);
  if (state.lastSeen) {
    io.line(`  ${OK} Connected${r === "updated" ? ` (updated to ${extensionVersion(dest)}; Chrome picks it up within a few minutes)` : ""}`);
    return true;
  }
  io.line(`  Add it to Chrome (once):`);
  io.line(`    1. Open ${bold("chrome://extensions")} and turn on ${bold("Developer mode")} (top right).`);
  io.line(`    2. Click ${bold("Load unpacked")} and choose ${bold(tilde(dest))}`);
  if (host.platform === "darwin") io.line(dim(`       (the path is on your clipboard: press ⌘⇧G in the dialog and paste; or drag the folder onto the page)`));
  io.line(`    3. That's it. Faber connects it automatically.`);
  host.copy(dest);
  if (io.interactive && host.hasChrome()) {
    if (host.platform === "darwin" && openApps) {
      host.open("chrome://extensions/", ["-a", "Google Chrome"]);
      host.open(dest, ["-R"]);
    }
    io.status(`  … waiting for Chrome ${dim("(press Enter to skip)")}`);
    const skip = io.enter();
    const seen = await Promise.race([waitFor(async () => extensionState(db, cfg.home).lastSeen !== null, 15 * 60_000, 1000), skip.done.then(() => false)]);
    skip.cancel();
    if (seen) {
      io.line(`  ${OK} Connected`);
      return true;
    }
  }
  io.line(`  ${WARN} Not connected yet. It connects as soon as you load it; \`faber doctor\` shows whether it has.`);
  return true;
}

function launcherRunning(): boolean {
  return spawnSync("pgrep", ["-f", "Faber Launcher.app/Contents/MacOS/FaberLauncher"], { stdio: "ignore" }).status === 0;
}

/** Quit a running launcher and wait for it to go (open ignores --args while it's still running). */
export async function quitLauncher(): Promise<boolean> {
  if (!launcherRunning()) return false;
  spawnSync("pkill", ["-f", "Faber Launcher.app/Contents/MacOS/FaberLauncher"], { stdio: "ignore" });
  for (let i = 0; i < 50 && launcherRunning(); i++) await Bun.sleep(100);
  return true;
}

async function setupLauncher(deps: SetupDeps, cfg: Config) {
  const { io, host, layout } = deps;
  const dest = launcherInstallPath();
  if (!layout.launcherSrc && !existsSync(dest)) {
    io.line(`  ${WARN} This copy of Faber has no launcher app bundled. From a source checkout: bun run build:macos, then faber setup.`);
    return;
  }
  await quitLauncher();
  const r = syncLauncher(layout.launcherSrc, dest, true);
  if (r === "unavailable") {
    io.line(`  ${WARN} ${tilde(dest)} isn't Faber's; left it alone.`);
    return;
  }
  if (cfg.daemon.port !== 7777) host.run("defaults", ["write", "dev.faber.launcher", "daemonURL", daemonUrl(cfg)]);
  const login = await io.confirm("Start the launcher when you log in?", true);
  host.open(dest, ["--args", "--login-item", login ? "on" : "off"]);
  io.line(`  ${OK} ${r === "current" ? "Installed" : r === "updated" ? "Updated" : "Installed"} ${tilde(dest)} (${appVersion(dest)})${login ? ", opens at login" : ""}`);
  io.line(dim(`    Press ⌥Space anywhere to search. Change the shortcut in Faber: Settings → Shortcuts.`));
}

async function setupSources(deps: SetupDeps) {
  const { io, db, host } = deps;
  const settings = getSettings(db);
  const google = settings.watchlist.filter((r) => r.builtin && ["gdocs", "gslides", "gsheets"].includes(r.id));
  let watching = true;
  if (google.some((r) => !r.enabled)) {
    watching = false;
    if (await io.confirm("Remember the Google Docs, Slides and Sheets you open?", true)) {
      saveSettings(db, { watchlist: settings.watchlist.map((r) => (google.some((g) => g.id === r.id) ? { ...r, enabled: true } : r)) });
      watching = true;
      io.line(`  ${OK} Watching Google Docs, Slides and Sheets ${dim("(more sites: Settings → Capture & Sources)")}`);
    } else {
      io.line(`  ${dim("  Pick what to watch any time in Settings → Capture & Sources")}`);
    }
  } else {
    io.line(`  ${OK} Watching Google Docs, Slides and Sheets`);
  }

  const docs = db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM documents`).get()!.n;
  const profiles = host.chromeProfiles();
  if (watching && docs === 0 && profiles.length > 0) {
    // Reading browser history only ever happens when someone says yes at the prompt.
    if (io.interactive && (await io.confirm("Import the Google docs you opened in Chrome over the last 90 days?", true))) {
      const pick = profiles.length === 1 ? 0 : await io.choose("Which Chrome profile do you use for work?", profiles.map((p) => `${p.name}${p.account ? ` (${p.account})` : ""}`), 0);
      const profile = profiles[pick]!;
      try {
        const r = importChromeHistory(db, profile.historyPath);
        io.line(`  ${OK} Imported ${r.docs_created} docs from "${profile.name}". The extension fetches their text in the background.`);
      } catch (err) {
        io.line(`  ${WARN} Couldn't read that profile's history (${err instanceof Error ? err.message : err}). Try later: faber import-chrome --list`);
      }
    }
  }
}

// ---------- doctor ----------

export async function runDoctor(deps: Omit<SetupDeps, "host">): Promise<boolean> {
  const { io, layout, db } = deps;
  const cfg = deps.cfg;
  let ok = true;
  const pass = (msg: string) => io.line(`  ${OK} ${msg}`);
  let warnings = 0;
  const warn = (msg: string) => {
    warnings++;
    io.line(`  ${WARN} ${msg}`);
  };
  const fail = (msg: string) => {
    ok = false;
    io.line(`  ${FAIL} ${msg}`);
  };

  io.line(bold(`Faber ${VERSION}`));
  pass(`Installed at ${tilde(layout.exe)}${layout.brewPrefix ? " (Homebrew)" : layout.compiled ? "" : " (source checkout)"}`);
  const schema = db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value;
  pass(`Data: ${tilde(join(cfg.home, DB_FILE))} (schema ${schema}, this version writes ${SCHEMA_VERSION})`);
  const backups = join(cfg.home, "backups");
  if (existsSync(backups)) pass(`Pre-upgrade backups in ${tilde(backups)}`);

  const v = await daemonVersion(cfg);
  if (!v) fail(`The daemon isn't answering at ${daemonUrl(cfg)}. Run \`faber setup\` (or \`faber serve\`).`);
  else if (v !== VERSION) fail(`The daemon at ${daemonUrl(cfg)} is version ${v}, not ${VERSION}. Restart it: faber service restart`);
  else pass(`Daemon running at ${daemonUrl(cfg)}`);
  if (process.env.FABER_HOME) {
    io.line(dim("    (FABER_HOME is set, so no background service: run `faber serve` for this home)"));
  } else if (serviceKind(layout) !== "none") {
    if (serviceInstalled(layout)) pass(`Background service installed (${serviceKind(layout)})`);
    else warn("No background service: Faber stops when you close its terminal. Fix: faber setup");
  }

  const base = ollamaBase(cfg);
  if (base) {
    const models = await ollamaModels(base);
    if (!models) fail(`Ollama isn't reachable at ${base}. Start it with \`brew services start ollama\` (or open the Ollama app), or run \`faber setup\`.`);
    else {
      pass("Ollama is running");
      for (const m of ollamaWanted(cfg)) (hasModel(models, m) ? pass : fail)(hasModel(models, m) ? `Model ${m}` : `Model ${m} is missing. Fix: ollama pull ${m}`);
    }
  } else {
    pass(`AI: ${cfg.enrich.provider}/${cfg.enrich.model}`);
  }

  const extDir = extensionInstallPath(cfg.home);
  if (!existsSync(extDir)) warn("The Chrome extension isn't installed. Fix: faber setup");
  else {
    const st = extensionState(db, cfg.home);
    const installed = extensionVersion(extDir);
    if (installed !== VERSION && layout.extensionSrc) warn(`The extension copy is ${installed}; restart the daemon to update it (faber service restart)`);
    if (!st.approved) fail(`The extension in ${tilde(extDir)} isn't approved. Fix: faber setup`);
    else if (!st.lastSeen) warn(`The extension hasn't connected yet. Load ${tilde(extDir)} in chrome://extensions (Load unpacked).`);
    else pass(`Extension connected (last seen ${new Date(st.lastSeen).toLocaleString()})`);
  }

  if (process.platform === "darwin") {
    const app = launcherInstallPath();
    if (!existsSync(app)) warn("The launcher app isn't installed (optional). Fix: faber setup");
    else {
      const av = appVersion(app);
      if (av !== VERSION && layout.launcherSrc) warn(`The launcher is ${av}; restart the daemon to update it (faber service restart)`);
      else pass(`Launcher ${tilde(app)}${launcherRunning() ? " (running)" : " (not running: open it from Applications)"}`);
    }
  }
  io.line();
  io.line(
    !ok
      ? `${WARN} Fix the items marked ${FAIL}, then run \`faber doctor\` again.`
      : warnings
        ? `${OK} Working. ${warnings} optional item${warnings === 1 ? "" : "s"} marked ${WARN} above.`
        : `${OK} All good.`,
  );
  return ok;
}

// ---------- uninstall ----------

export async function runUninstall(deps: SetupDeps, opts: { purge: boolean }): Promise<void> {
  const { io, layout, cfg } = deps;
  for (const done of uninstallService(layout)) io.line(`  ${OK} ${done}`);
  const app = launcherInstallPath();
  if (process.platform === "darwin" && existsSync(app)) {
    // Turn off Open at login before the app goes, or a dangling login item stays behind.
    await quitLauncher();
    deps.host.open(app, ["-g", "--args", "--login-item", "off"]);
    await Bun.sleep(1500);
    await quitLauncher();
    rmSync(app, { recursive: true, force: true });
    io.line(`  ${OK} Removed ${tilde(app)}`);
  }
  const ext = extensionInstallPath(cfg.home);
  if (existsSync(ext)) {
    removeExtension(deps.db, extensionState(deps.db, cfg.home).id);
    rmSync(ext, { recursive: true, force: true });
    io.line(`  ${OK} Removed the extension files (remove it from chrome://extensions too)`);
  }
  if (opts.purge) {
    const home = configHome();
    if (home === "/" || home === homedir()) throw new Error(`Refusing to delete ${home}`);
    if (!io.interactive) io.line(`  ${WARN} Deleting your data needs a yes at the prompt: run \`faber uninstall --purge\` in a terminal, without --yes.`);
    if (await io.confirm(`Delete all your Faber data in ${tilde(home)}? This can't be undone.`, false)) {
      deps.db.close();
      rmSync(home, { recursive: true, force: true });
      io.line(`  ${OK} Deleted ${tilde(home)}`);
    }
  } else {
    io.line(`  ${dim(`Your data stays in ${tilde(cfg.home)} (delete it with \`faber uninstall --purge\`).`)}`);
  }
  if (layout.brewPrefix) io.line(`  Finally: brew uninstall faber`);
}

export { detectLayout, findBrew };
