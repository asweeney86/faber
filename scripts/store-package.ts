#!/usr/bin/env bun
/**
 * Everything the Chrome Web Store asks for, in one folder, so publishing the extension is a
 * single upload (that's what removes "Developer mode + Load unpacked" from the install):
 *
 *   bun scripts/store-package.ts [--out dist/store]
 *
 *   faber-extension-<version>.zip   the production extension (upload this)
 *   screenshot-{1..4}.png           1280×800, from docs/screenshots
 *   icon-128.png                    store icon
 *   listing.md                      description, single purpose, permission justifications, privacy answers
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { checkVersions } from "./release-lib";

const root = join(import.meta.dir, "..");
const i = process.argv.indexOf("--out");
const out = i >= 0 ? process.argv[i + 1]! : join(root, "dist", "store");
const version = checkVersions(root);

rmSync(out, { recursive: true, force: true });
const ext = join(out, "extension");
execFileSync("bun", [join(root, "packages/extension/build.ts")], { stdio: "inherit", env: { ...process.env, FABER_EXT_OUT: ext } });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")) as { permissions: string[]; host_permissions: string[]; optional_permissions: string[] };
execFileSync("zip", ["-qr", join(out, `faber-extension-${version}.zip`), "."], { cwd: ext, env: { ...process.env, COPYFILE_DISABLE: "1" } });
copyFileSync(join(root, "packages/extension/static/icons/icon-128.png"), join(out, "icon-128.png"));

// Store screenshots must be exactly 1280×800: letterbox each docs screenshot on the brand violet.
const shots = ["hero.png", "popup.png", "search.png", "project.png"];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const [n, name] of shots.entries()) {
  const data = readFileSync(join(root, "docs/screenshots", name)).toString("base64");
  await page.setContent(
    `<body style="margin:0;width:1280px;height:800px;background:#7056EF;display:flex;align-items:center;justify-content:center">
       <img src="data:image/png;base64,${data}" style="max-width:1200px;max-height:740px;object-fit:contain"></body>`,
  );
  await page.waitForFunction(() => [...(globalThis as unknown as { document: { images: { complete: boolean }[] } }).document.images].every((im) => im.complete));
  await page.screenshot({ path: join(out, `screenshot-${n + 1}.png`) });
}
await browser.close();

writeFileSync(
  join(out, "listing.md"),
  `# Faber: Chrome Web Store listing (v${version})

**Name:** Faber
**Summary (≤132 chars):** Remembers and organizes the docs you open at work, so you can find them again. Local-first: nothing leaves your computer.
**Category:** Productivity → Workflow & planning
**Language:** English

## Description

Faber remembers the documents you actually spend time on (Google Docs, Slides and Sheets, plus any site you choose), and finds them again by what you remember about them.

- Search the way you remember: "the pricing doc from Maya's team, around Q2 planning"
- Projects organize themselves from your documents; your corrections always win
- A launcher over any page (⌘⇧K), and a popup that tells you whether this page is saved
- Ask questions and get answers with citations from your own documents

Faber is local-first. The extension talks only to the Faber app running on your own computer (http://127.0.0.1). A local AI model reads your documents there. Nothing is sent to us or anyone else, and there are no accounts, analytics or ads.

Requires the free Faber app: \`brew install asweeney86/faber/faber && faber setup\`. Source: https://github.com/asweeney86/faber

## Single purpose

Remember the work documents the user opens, and help them find those documents again, by sending them to the Faber app on the user's own computer.

## Permission justifications

${[
  ["storage", "Keeps the user's settings and a queue of captures for when the local Faber app isn't running."],
  ["alarms", "Retries queued captures and syncs settings with the local app every few minutes."],
  ["scripting", "Reads the visible text of pages the user has chosen to watch, and shows the launcher over the current page when asked."],
  ["activeTab", "Lets the popup save the current page when the user clicks Save."],
  ["tabs (optional)", "Off by default. Only if the user turns on 'Show saved status on every site', so the toolbar icon can show whether any page is saved."],
  ["https://docs.google.com/*, https://*.googleusercontent.com/*", "Fetches the text of Google Docs, Slides and Sheets the user opens, with their own Google session, so it can be searched locally."],
  ["https://calendar.google.com/*", "Links a document to the meeting it was opened from, when the user turns that on."],
  ["http://127.0.0.1/*, http://localhost/*", "The Faber app runs on the user's own computer; this is the only place data is sent."],
  ["Optional host permissions (any site)", "Requested per site, only when the user adds a site to watch (e.g. their wiki)."],
]
  .map(([p, why]) => `- **${p}:** ${why}`)
  .join("\n")}

(Manifest: permissions ${manifest.permissions.join(", ")}; host permissions ${manifest.host_permissions.join(", ")}; optional ${manifest.optional_permissions.join(", ")}.)

## Privacy practices

- **Data collected:** website content (the text of pages the user chooses to watch) and web history (which watched pages they opened). Both go only to the Faber app on the user's own computer.
- **Not sold, not transferred to third parties, not used for anything unrelated to the single purpose, not used for creditworthiness.**
- **Remote code:** none. Everything is in the package.
- **Privacy policy URL:** https://github.com/asweeney86/faber#privacy-first

## After it's published

Put the store's extension id in \`daemon.allowed_extension_ids\` in \`DEFAULT_CONFIG_TOML\` (packages/core/src/config.ts), so the store copy is trusted without pairing. Then have \`faber setup\` open the store page instead of chrome://extensions.
`,
);
rmSync(ext, { recursive: true, force: true });
console.log(`Wrote ${out}`);
