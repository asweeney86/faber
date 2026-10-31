#!/usr/bin/env bun
/**
 * Build the extension into packages/extension/build/.
 *
 *   bun packages/extension/build.ts            production build (load unpacked from build/)
 *   FABER_TEST=1 bun packages/extension/build.ts  test build for e2e (adds http://127.0.0.1 page access)
 *   bun packages/extension/dev.ts              watch mode: rebuild build/ on save and auto-reload Chrome
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const test = process.env.FABER_TEST === "1";
const out = process.env.FABER_EXT_OUT ?? join(here, test ? "build-test" : "build");

const pkg = (await Bun.file(join(here, "package.json")).json()) as { version: string };

export function manifest(opts: { test: boolean; version: string }) {
  // The daemon runs on 127.0.0.1/localhost; match patterns cannot name a port, so both builds need these.
  const daemonHosts = ["http://127.0.0.1/*", "http://localhost/*"];
  // Test builds pre-grant the https variants too, so custom loopback watch rules never trigger a permission prompt.
  const testHosts = opts.test ? ["https://127.0.0.1/*", "https://localhost/*"] : [];
  return {
    manifest_version: 3,
    name: opts.test ? "Faber (test)" : "Faber",
    short_name: "Faber",
    description: "Remembers and organizes the docs you open at work, so you can find them again. Local-first.",
    version: opts.version,
    minimum_chrome_version: "116",
    icons: { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
    action: {
      default_title: "Faber",
      default_popup: "popup.html",
      // Neutral until the worker knows whether the current tab is saved (see src/lib/tabstate.ts).
      default_icon: { "16": "icons/action-unknown-16.png", "32": "icons/action-unknown-32.png" },
    },
    background: { service_worker: "background.js", type: "module" },
    // Never run in incognito windows: private browsing must not be recorded.
    incognito: "not_allowed",
    options_ui: { page: "options.html", open_in_tab: true },
    // No "tabs" permission: host permissions already reveal URLs of watched sites, calendar and the
    // opener tab when it is one of those; activeTab covers the popup's "This page". Other URLs stay hidden.
    permissions: ["storage", "alarms", "scripting", "activeTab"],
    host_permissions: [
      "https://docs.google.com/*",
      // Google serves some exports via redirects to googleusercontent.com.
      "https://*.googleusercontent.com/*",
      "https://calendar.google.com/*",
      ...daemonHosts,
      ...testHosts,
    ],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    // Opt-in ("Show saved status on every site"): lets the toolbar icon read the current tab's address anywhere.
    optional_permissions: ["tabs"],
    commands: {
      // The launcher (search everything, over the current page). Change it at chrome://extensions/shortcuts.
      "open-launcher": {
        suggested_key: { default: "Ctrl+Shift+K", mac: "Command+Shift+K" },
        description: "Open the Faber launcher",
      },
      _execute_action: {
        description: "Open the Faber popup (this page's status)",
      },
    },
    // The launcher iframe shown over pages. Only this one page is exposed.
    web_accessible_resources: [{ resources: ["launcher.html"], matches: ["http://*/*", "https://*/*"] }],
    omnibox: { keyword: "faber" },
  };
}

export interface BuildOptions {
  test: boolean;
  out: string;
  /** Port of the dev reload server (dev.ts); 0 = no auto-reload client in the bundle. */
  devReloadPort?: number;
  /** Identifies this build so a reconnecting dev client can tell it is stale. */
  buildId?: string;
}

export async function buildExtension(opts: BuildOptions): Promise<boolean> {
  const { test, out } = opts;
  const dev = (opts.devReloadPort ?? 0) > 0;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(here, "src/background.ts"), join(here, "src/popup/main.tsx"), join(here, "src/options/main.tsx"), join(here, "src/launcher/main.tsx")],
    root: join(here, "src"),
    outdir: out,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: !test && !dev,
    sourcemap: test || dev ? "inline" : "none",
    naming: "[dir]/[name].[ext]",
    define: {
      "process.env.NODE_ENV": JSON.stringify(test || dev ? "development" : "production"),
      // Compile-time constants: in normal builds the dev reload client is dead code and removed.
      __FABER_DEV_RELOAD_PORT__: String(opts.devReloadPort ?? 0),
      __FABER_BUILD_ID__: JSON.stringify(opts.buildId ?? ""),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }

  cpSync(join(here, "static"), out, { recursive: true });
  // The launcher's styles live with the shared component.
  cpSync(join(here, "..", "ui", "src", "launcher.css"), join(out, "launcher.css"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest({ test, version: pkg.version }), null, 2));
  return true;
}

if (import.meta.main) {
  if (!(await buildExtension({ test, out }))) process.exit(1);
  console.log(`Built ${test ? "test " : ""}extension → ${out}`);
}
