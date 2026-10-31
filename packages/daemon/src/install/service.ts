/**
 * Run the daemon in the background, started at login and restarted if it stops.
 *
 *  - Homebrew installs use `brew services` (the formula's service block), so
 *    `brew services`, `brew upgrade` and `brew uninstall` all know about it.
 *  - Other macOS installs get a LaunchAgent; Linux gets a systemd user unit.
 *
 * Every variant starts Faber from a path that survives upgrades (Layout.command) and
 * sets FABER_SERVICE=1, which turns on the restart-after-upgrade watch (upgrade-watch.ts).
 * Exiting with UPGRADE_EXIT_CODE asks the service manager for a restart; exit 0 means
 * "stay stopped" (e.g. the binary was uninstalled).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Layout } from "./layout";

export const LAUNCHD_LABEL = "dev.faber.daemon";
export const BREW_LABEL = "homebrew.mxcl.faber";
export const SYSTEMD_UNIT = "faber.service";
/** EX_TEMPFAIL: "restart me". Service definitions restart on non-zero exits only. */
export const UPGRADE_EXIT_CODE = 75;

export type ServiceKind = "brew" | "launchd" | "systemd" | "none";

export interface ServiceEnv {
  home: string;
  /** Extra environment for the daemon, e.g. FABER_HOME when not the default. */
  env: Record<string, string>;
  logFile: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(command: string[], s: ServiceEnv): string {
  const env = { FABER_SERVICE: "1", ...s.env };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[...command, "serve"].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash or an upgrade (exit ${UPGRADE_EXIT_CODE}); a clean exit stays stopped. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(s.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(s.logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(command: string[], s: ServiceEnv): string {
  const env = { FABER_SERVICE: "1", ...s.env };
  const q = (a: string) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a);
  return `[Unit]
Description=Faber daemon (local-first knowledge base)
After=network.target

[Service]
ExecStart=${[...command, "serve"].map(q).join(" ")}
${Object.entries(env)
  .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`)
  .join("\n")}
Restart=on-failure
RestartSec=2
StandardOutput=append:${s.logFile}
StandardError=append:${s.logFile}

[Install]
WantedBy=default.target
`;
}

function has(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

export function serviceKind(layout: Layout, platform = process.platform): ServiceKind {
  if (layout.brewPrefix && existsSync(join(layout.brewPrefix, "bin", "brew"))) return "brew";
  if (platform === "darwin") return "launchd";
  if (platform === "linux" && has("systemctl")) return "systemd";
  return "none";
}

export const launchAgentPath = () => join(process.env.FABER_LAUNCHAGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents"), `${LAUNCHD_LABEL}.plist`);
export const systemdUnitPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", SYSTEMD_UNIT);
const gui = () => `gui/${userInfo().uid}`;

function run(cmd: string, args: string[]) {
  execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
}

function tryRun(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
}

/** Install (or refresh) and start the background service. Returns what was done, for the user. */
export function installService(layout: Layout, s: ServiceEnv): string {
  const kind = serviceKind(layout);
  mkdirSync(join(s.logFile, ".."), { recursive: true });
  switch (kind) {
    case "brew": {
      // A LaunchAgent from a pre-Homebrew install would fight it for the port.
      removeOwnService();
      const brew = join(layout.brewPrefix!, "bin", "brew");
      run(brew, ["services", "restart", "faber"]);
      return "Started with `brew services` (starts at login; `brew services stop faber` to stop)";
    }
    case "launchd": {
      const path = launchAgentPath();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, launchdPlist(layout.command, s));
      tryRun("launchctl", ["bootout", `${gui()}/${LAUNCHD_LABEL}`]);
      run("launchctl", ["bootstrap", gui(), path]);
      return `Installed a LaunchAgent (${path}); it starts at login`;
    }
    case "systemd": {
      const path = systemdUnitPath();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, systemdUnit(layout.command, s));
      run("systemctl", ["--user", "daemon-reload"]);
      run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
      run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
      return `Installed a systemd user service (${path})`;
    }
    case "none":
      throw new Error("No service manager found here. Run `faber serve` yourself (e.g. in a terminal or with your init system).");
  }
}

/** Remove the LaunchAgent / systemd unit this module writes (not Homebrew's). */
function removeOwnService(): boolean {
  let removed = false;
  if (process.platform === "darwin" && existsSync(launchAgentPath())) {
    tryRun("launchctl", ["bootout", `${gui()}/${LAUNCHD_LABEL}`]);
    rmSync(launchAgentPath(), { force: true });
    removed = true;
  }
  if (process.platform === "linux" && existsSync(systemdUnitPath())) {
    tryRun("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    rmSync(systemdUnitPath(), { force: true });
    tryRun("systemctl", ["--user", "daemon-reload"]);
    removed = true;
  }
  return removed;
}

export function uninstallService(layout: Layout): string[] {
  const done: string[] = [];
  if (layout.brewPrefix && existsSync(join(layout.brewPrefix, "bin", "brew"))) {
    if (tryRun(join(layout.brewPrefix, "bin", "brew"), ["services", "stop", "faber"])) done.push("Stopped the Homebrew service");
  }
  if (removeOwnService()) done.push("Removed the background service");
  return done;
}

/** Whether the background service is set up, as far as the service manager knows. */
export function serviceInstalled(layout: Layout): boolean {
  switch (serviceKind(layout)) {
    case "brew":
      return existsSync(join(homedir(), "Library", "LaunchAgents", `${BREW_LABEL}.plist`)) || existsSync(join(systemdUnitPath(), "..", `homebrew.faber.service`));
    case "launchd":
      return existsSync(launchAgentPath());
    case "systemd":
      return existsSync(systemdUnitPath());
    case "none":
      return false;
  }
}

/** Ask the service manager to restart the daemon (after a config change, say). */
export function restartService(layout: Layout): boolean {
  switch (serviceKind(layout)) {
    case "brew":
      return tryRun(join(layout.brewPrefix!, "bin", "brew"), ["services", "restart", "faber"]);
    case "launchd":
      return tryRun("launchctl", ["kickstart", "-k", `${gui()}/${LAUNCHD_LABEL}`]);
    case "systemd":
      return tryRun("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    case "none":
      return false;
  }
}
