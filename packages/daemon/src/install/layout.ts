/**
 * Where this copy of Faber is installed and what it ships with.
 *
 * A release is a tarball laid out like a Homebrew keg:
 *
 *   bin/faber                              the daemon + CLI, one compiled binary
 *   share/faber/extension/                 the Chrome extension, unpacked
 *   share/faber/Faber Launcher.app         the native launcher (macOS builds)
 *
 * Homebrew installs it under <prefix>/Cellar/faber/<version>/ and keeps a stable
 * symlink at <prefix>/opt/faber. Anything that outlives one version (the background
 * service, the extension Chrome loads, the launcher in ~/Applications) must point at
 * stable paths, never into a versioned keg, or an upgrade would pull it out from under them.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Layout {
  /** True for a release binary (bun build --compile); false when run from a source checkout. */
  compiled: boolean;
  /** Real path of the running binary (compiled) or of cli.ts (source). */
  exe: string;
  /** Command that starts this Faber from a path that survives upgrades, e.g. [/opt/homebrew/opt/faber/bin/faber]. */
  command: string[];
  /** Homebrew prefix (e.g. /opt/homebrew) when Homebrew installed this copy. */
  brewPrefix: string | null;
  /** The unpacked extension this version ships, if any. */
  extensionSrc: string | null;
  /** The macOS launcher app this version ships, if any. */
  launcherSrc: string | null;
}

const CELLAR_RE = /^(.*)\/Cellar\/faber\/[^/]+\/bin\/faber$/;

/** <prefix> when `exe` lives in a Homebrew keg. */
export function brewPrefixOf(exe: string): string | null {
  return CELLAR_RE.exec(exe)?.[1] ?? null;
}

const existing = (p: string) => (existsSync(p) ? p : null);

export function detectLayout(env: NodeJS.ProcessEnv = process.env): Layout {
  // Compiled binaries run their bundled entry point from Bun's virtual filesystem.
  const compiled = Bun.main.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/.test(Bun.main);
  if (compiled) {
    const exe = realpathSync(process.execPath);
    const brewPrefix = brewPrefixOf(exe);
    const share = env.FABER_SHARE_DIR ?? join(dirname(exe), "..", "share", "faber");
    return {
      compiled,
      exe,
      command: [brewPrefix ? join(brewPrefix, "opt", "faber", "bin", "faber") : exe],
      brewPrefix,
      extensionSrc: existing(join(share, "extension", "manifest.json")) && join(share, "extension"),
      launcherSrc: existing(join(share, "Faber Launcher.app", "Contents", "Info.plist")) && join(share, "Faber Launcher.app"),
    };
  }
  // A source checkout: assets are whatever has been built locally.
  const cli = resolve(import.meta.dir, "..", "cli.ts");
  const root = resolve(import.meta.dir, "..", "..", "..", "..");
  const share = env.FABER_SHARE_DIR;
  const ext = share ? join(share, "extension") : join(root, "packages", "extension", "build");
  const app = share ? join(share, "Faber Launcher.app") : join(root, "packages", "macos", "build", "Faber Launcher.app");
  return {
    compiled,
    exe: cli,
    command: [process.execPath, cli],
    brewPrefix: null,
    extensionSrc: existing(join(ext, "manifest.json")) && ext,
    launcherSrc: existing(join(app, "Contents", "Info.plist")) && app,
  };
}

/** Where the launcher app is installed: ~/Applications, so no admin rights are needed. */
export function launcherInstallPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.FABER_APPS_DIR ?? join(homedir(), "Applications"), "Faber Launcher.app");
}

/** Where the extension Chrome loads lives. Inside the data home, so its path (and so its id) never changes. */
export function extensionInstallPath(home: string): string {
  return join(home, "extension");
}
