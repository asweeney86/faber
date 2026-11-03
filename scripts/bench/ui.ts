#!/usr/bin/env bun
/// <reference lib="dom" />
/**
 * How the app feels with a full library: time from navigation / keystroke to results on
 * screen, ⌘K launcher open time, DOM size, and screenshots of the main views.
 * Read-only: types and looks, never clicks a result (opening one would count as a visit).
 *
 *   bun scripts/bench/ui.ts [--daemon URL] [--label after-1000]
 *
 * Writes <out>/ui-<label>.json and <out>/screens/<label>-*.png.
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    daemon: { type: "string", default: "http://127.0.0.1:7777" },
    out: { type: "string", default: join(homedir(), ".faber", "bench") },
    label: { type: "string", default: "ui" },
  },
});
const BASE = values.daemon!.replace(/\/$/, "");
const SHOTS = join(values.out!, "screens");
mkdirSync(SHOTS, { recursive: true });

const QUERIES = ["climate", "artificial intelligence", "election", "nasa telescope", "interest rates", "football", "open source database", "ukraine"];
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const max = (xs: number[]) => Math.max(...xs);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${values.label}-${name}.png`) });
const result: Record<string, unknown> = {};

/** ms from navigation until `selector` is visible. */
async function load(hash: string, selector: string, name: string) {
  const xs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    await page.goto(`${BASE}/${hash}`, { waitUntil: "commit" });
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 30_000 });
    xs.push(Date.now() - t);
  }
  result[`load_${name}_ms`] = { median: median(xs), max: max(xs) };
}

await load("#/", "[data-testid=digest]", "home");
await page.waitForTimeout(1500);
await shot("home");
await load("#/search", "[data-testid=result]", "search_browse");
await page.waitForTimeout(1500);
await shot("search-browse");
result.dom_nodes_search_browse = await page.evaluate(() => document.querySelectorAll("*").length);

/** Type a query like a person would and time until the result list shows its results. */
async function typeAndWait(p: Page, q: string): Promise<{ typed: number; total: number }> {
  const input = p.getByTestId("search-input");
  await input.fill("");
  await p.waitForTimeout(400);
  const before = await p.getByTestId("results-meta").innerText().catch(() => "");
  const t = Date.now();
  await input.pressSequentially(q, { delay: 60 });
  const typed = Date.now();
  // Results for the full query: the meta line shows "N results" and is no longer the browse view.
  await p.waitForFunction(
    (prev) => {
      const meta = document.querySelector("[data-testid=results-meta]")?.textContent ?? "";
      return /result/.test(meta) && meta !== prev && !document.querySelector(".search-bar .spinner");
    },
    before,
    { timeout: 30_000 },
  );
  return { typed: Date.now() - typed, total: Date.now() - t };
}

const afterTyping: number[] = [];
for (const q of QUERIES) {
  afterTyping.push((await typeAndWait(page, q)).typed);
}
result.search_results_after_last_keystroke_ms = { median: median(afterTyping), max: max(afterTyping), samples: afterTyping };
await page.getByTestId("search-input").fill("artificial intelligence");
await page.waitForTimeout(2500);
await shot("search-query");
result.dom_nodes_search_query = await page.evaluate(() => document.querySelectorAll("*").length);

// ⌘K launcher: open, then type.
await page.goto(`${BASE}/#/`);
await page.locator("[data-testid=digest]").waitFor();
const opens: number[] = [];
const launcherTyping: number[] = [];
for (const q of QUERIES.slice(0, 5)) {
  const t = Date.now();
  await page.keyboard.press("Meta+k");
  await page.getByTestId("launcher-input").waitFor();
  await page.locator(".fl-item").first().waitFor();
  opens.push(Date.now() - t);
  await page.getByTestId("launcher-input").pressSequentially(q, { delay: 60 });
  const typed = Date.now();
  // The Documents section shows "N results" (or "nothing matches") once this query's results are in.
  await page.waitForFunction(() => /\d+ results?|nothing matches/i.test(document.querySelector(".fl-results")?.textContent ?? ""), null, { timeout: 30_000 });
  launcherTyping.push(Date.now() - typed);
  if (q === "climate") await shot("launcher");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}
result.launcher_open_ms = { median: median(opens), max: max(opens) };
result.launcher_results_after_last_keystroke_ms = { median: median(launcherTyping), max: max(launcherTyping) };

await load("#/projects", "[data-testid=project-page], .project-grid, .page", "projects");
await page.waitForTimeout(1000);
await shot("projects");
await load("#/people", ".page", "people");
await page.waitForTimeout(1000);
await shot("people");

await browser.close();
writeFileSync(join(values.out!, `ui-${values.label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
