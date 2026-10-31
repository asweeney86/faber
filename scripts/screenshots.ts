#!/usr/bin/env bun
/**
 * Regenerate the README media in docs/screenshots/ from a running daemon with the demo data.
 *
 *   FABER_HOME=$(mktemp -d) bun faber demo   # with Ollama, enriched by Qwen
 *   FABER_HOME=… bun faber serve
 *   bun scripts/screenshots.ts --daemon http://127.0.0.1:7777 [--out docs/screenshots] [--only home,ask]
 *
 * Every shot is captured at 2× and then framed: a window with a title bar on a transparent
 * background (the hero sits on the brand violet). Also:
 *   - themes.png: Home in all four Catppuccin flavors;
 *   - launcher-demo.gif: the launcher in use (needs ffmpeg);
 *   - native.png: the macOS menu-bar launcher (on macOS, if packages/macos/build exists).
 *
 * It sets the appearance through the API (Mocha by default) and restores the previous one at
 * the end. The popup shot builds and loads a test copy of the extension, approved on the daemon.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const DAEMON = arg("daemon", "http://127.0.0.1:7777").replace(/\/$/, "");
const OUT = arg("out", join(import.meta.dir, "..", "docs", "screenshots"));
const ONLY = new Set(arg("only", "").split(",").filter(Boolean));
const want = (name: string) => ONLY.size === 0 || ONLY.has(name);
const ROOT = join(import.meta.dir, "..");
const RAW = mkdtempSync(join(tmpdir(), "faber-shots-"));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(DAEMON + path, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type Flavor = "mocha" | "macchiato" | "frappe" | "latte";
type Appearance = { theme: string; dark_flavor: string; accent: string; density: string };
const setAppearance = (a: Partial<Appearance>) =>
  api("/api/settings", { method: "PUT", body: JSON.stringify({ appearance: { theme: "mocha", dark_flavor: "mocha", accent: "mauve", density: "comfortable", ...a } }) });

/** Window chrome per flavor (Catppuccin mantle / surface0 / overlay1). */
const CHROME: Record<Flavor, { bar: string; border: string; text: string }> = {
  mocha: { bar: "#181825", border: "#313244", text: "#7f849c" },
  macchiato: { bar: "#1e2030", border: "#363a4f", text: "#8087a2" },
  frappe: { bar: "#292c3c", border: "#414559", text: "#838ba7" },
  latte: { bar: "#e6e9ef", border: "#ccd0da", text: "#8c8fa1" },
};
const VIOLET = "#7056EF"; // the brand tile

type ChromeGlobal = { chrome?: { storage?: { local?: { set(items: object): Promise<void> } } } };

const settle = (page: Page) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(500));
const dataUrl = (file: string) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;

/** Render HTML to a PNG at 2×, with a transparent page background. */
async function render(browser: Browser, html: string, out: string, width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 400 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .stage{display:inline-block}
    .win{border-radius:12px;overflow:hidden;box-shadow:0 18px 50px rgba(17,17,27,.28),0 2px 8px rgba(17,17,27,.18)}
    .bar{height:30px;display:flex;align-items:center;position:relative}
    .dots{display:flex;gap:8px;padding-left:13px}.dots i{width:12px;height:12px;border-radius:50%;display:block}
    .title{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:500}
    .win img,.panel img{display:block;width:100%}
  </style></head><body><div class="stage" id="stage">${html}</div></body></html>`);
  // (Runs in the page; scripts/ has no DOM types.)
  type Doc = { images: Iterable<{ decode(): Promise<void> }> };
  await page.evaluate(() => Promise.all([...(globalThis as unknown as { document: Doc }).document.images].map((i) => i.decode())));
  await page.locator("#stage").screenshot({ path: out, omitBackground: true });
  await ctx.close();
}

/** A captured page in a window frame. */
function windowHtml(img: string, flavor: Flavor, width: number, title = "Faber") {
  const c = CHROME[flavor];
  return `<div class="win" style="width:${width}px;border:1px solid ${c.border}">
    <div class="bar" style="background:${c.bar};border-bottom:1px solid ${c.border}">
      <div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
      <div class="title" style="color:${c.text}">${title}</div>
    </div><img src="${dataUrl(img)}"></div>`;
}

const framed = (browser: Browser, raw: string, name: string, flavor: Flavor = "mocha", title?: string) =>
  render(browser, `<div style="padding:28px 36px 52px">${windowHtml(raw, flavor, 960, title)}</div>`, join(OUT, `${name}.png`), 1100);

mkdirSync(OUT, { recursive: true });
const previous = (await api<{ appearance: Appearance }>("/api/settings")).appearance;
const browser = await chromium.launch();
try {
  /** Capture a page of the app at 2× into RAW/<name>.png. */
  const capture = async (name: string, hash: string, opts: { theme?: Flavor; act?: (p: Page) => Promise<void>; width?: number; height?: number } = {}) => {
    await setAppearance({ theme: opts.theme ?? "mocha" });
    const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${DAEMON}/#${hash}`);
    await settle(page);
    await opts.act?.(page);
    const file = join(RAW, `${name}.png`);
    await page.screenshot({ path: file });
    await ctx.close();
    return file;
  };
  const shot = async (name: string, hash: string, opts: Parameters<typeof capture>[2] & { title?: string } = {}) => {
    if (!want(name)) return;
    const raw = await capture(name, hash, opts);
    await framed(browser, raw, name, opts.theme ?? "mocha", opts.title);
    console.log(`✓ ${name}`);
  };

  const projects = await api<{ id: string; doc_count: number; parent_id?: string | null }[]>("/api/projects");
  // The project with subprojects makes the best workspace shot; else the biggest.
  const parentIds = new Set(projects.map((p) => p.parent_id).filter(Boolean));
  const top = projects.find((p) => parentIds.has(p.id)) ?? [...projects].sort((a, b) => b.doc_count - a.doc_count)[0];

  const openLauncher = async (p: Page, query: string) => {
    await p.keyboard.press("ControlOrMeta+k");
    await p.getByTestId("launcher-input").pressSequentially(query, { delay: 30 });
    await p.waitForTimeout(1500);
  };

  // The hero: the launcher over the app, on the brand violet.
  if (want("hero")) {
    const raw = await capture("hero", "/", { act: (p) => openLauncher(p, "rate limit") });
    await render(
      browser,
      `<div style="background:${VIOLET};border-radius:20px;padding:44px 52px 56px">${windowHtml(raw, "mocha", 1000)}</div>`,
      join(OUT, "hero.png"),
      1120,
    );
    console.log("✓ hero");
  }
  await shot("home", "/");
  await shot("launcher", "/projects", {
    act: async (p) => {
      await p.keyboard.press("ControlOrMeta+k");
      await p.getByTestId("launcher-mode-projects").click();
      await p.waitForTimeout(400);
      await p.getByTestId("launcher-input").press("Enter"); // into the first project
      await p.waitForTimeout(1200);
    },
  });
  await shot("search", "/search?q=pricing%20presentation%20reviewed%20with%20infrastructure%20last%20spring");
  await shot("projects", "/projects");
  if (top) await shot("project", `/projects/${encodeURIComponent(top.id)}`);
  await shot("doc", "/search?q=rate%20limit%20design", {
    act: async (p) => {
      await p.getByTestId("result").first().click();
      await p.getByTestId("drawer").waitFor();
      await p.waitForTimeout(700);
    },
  });
  await shot("ask", "/ask", {
    act: async (p) => {
      await p.getByTestId("ask-input").fill("What blocked the Frankfurt launch?");
      await p.getByTestId("ask-input").press("Enter");
      await p.getByTestId("ask-answer").waitFor({ timeout: 240_000 });
      await p.waitForTimeout(400);
    },
  });
  await shot("dashboards", "/dashboards/my-work");
  await shot("settings-appearance", "/settings/appearance", { theme: "latte" });

  // Home in each flavor, as a 2×2 grid.
  if (want("themes")) {
    const flavors: Flavor[] = ["mocha", "macchiato", "frappe", "latte"];
    const cells: string[] = [];
    for (const f of flavors) {
      const raw = await capture(`theme-${f}`, "/", { theme: f });
      const label = f === "frappe" ? "Frappé" : f[0]!.toUpperCase() + f.slice(1);
      cells.push(`<div>${windowHtml(raw, f, 520, label)}</div>`);
    }
    await render(browser, `<div style="display:grid;grid-template-columns:520px 520px;gap:30px 34px;padding:24px 34px 48px">${cells.join("")}</div>`, join(OUT, "themes.png"), 1200);
    console.log("✓ themes");
  }

  // The launcher in use, as a GIF.
  if (want("launcher-demo")) {
    if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
      console.log("· launcher-demo skipped (no ffmpeg)");
    } else {
      await setAppearance({ theme: "mocha" });
      const videoDir = join(RAW, "video");
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } });
      const p = await ctx.newPage();
      await p.goto(`${DAEMON}/#/`);
      await settle(p);
      await p.waitForTimeout(700);
      await p.keyboard.press("ControlOrMeta+k");
      await p.waitForTimeout(700);
      const input = p.getByTestId("launcher-input");
      await input.pressSequentially("frankfurt launch", { delay: 90 });
      await p.waitForTimeout(1500);
      await input.press("ArrowDown");
      await p.waitForTimeout(500);
      await input.press("ArrowDown");
      await p.waitForTimeout(800);
      await input.press("ArrowUp");
      await p.waitForTimeout(600);
      await input.fill("");
      await p.getByTestId("launcher-mode-projects").click();
      await p.waitForTimeout(1000);
      await input.press("Enter");
      await p.waitForTimeout(1800);
      await input.press("Escape"); // back out of the project
      await p.waitForTimeout(700);
      await p.keyboard.press("Escape"); // close
      await p.waitForTimeout(900);
      await ctx.close();
      const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
      if (webm) {
        const gif = join(OUT, "launcher-demo.gif");
        rmSync(gif, { force: true });
        execFileSync("ffmpeg", [
          "-loglevel", "error", "-ss", "0.6", "-i", join(videoDir, webm),
          "-vf", "fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
          "-loop", "0", gif,
        ]);
        console.log("✓ launcher-demo");
      }
    }
  }

  // The native macOS launcher, as a floating panel.
  const app = join(ROOT, "packages", "macos", "build", "Faber Launcher.app", "Contents", "MacOS", "FaberLauncher");
  if (want("native") && process.platform === "darwin" && existsSync(app)) {
    await setAppearance({ theme: "mocha" });
    const raw = join(RAW, "native.png");
    // WebKit occasionally hasn't painted yet when the app snapshots: a blank capture is tiny.
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      rmSync(raw, { force: true });
      const r = spawnSync(app, ["--daemon", DAEMON, "--snapshot", raw], { timeout: 30_000 });
      ok = r.status === 0 && existsSync(raw) && statSync(raw).size > 100_000;
    }
    if (ok) {
      await render(
        browser,
        `<div style="padding:30px 40px 56px"><div class="panel" style="width:900px;border-radius:16px;overflow:hidden;box-shadow:0 22px 60px rgba(17,17,27,.35),0 2px 10px rgba(17,17,27,.2)"><img src="${dataUrl(raw)}"></div></div>`,
        join(OUT, "native.png"),
        1000,
      );
      console.log("✓ native");
    } else {
      console.log("· native skipped (snapshot failed)");
    }
  }

  // Extension popup: a test build, approved on this daemon.
  if (want("popup")) {
    const extDir = mkdtempSync(join(tmpdir(), "faber-shots-ext-"));
    execFileSync("bun", [join(ROOT, "packages/extension/build.ts")], { env: { ...process.env, FABER_TEST: "1", FABER_EXT_OUT: extDir }, stdio: "ignore" });
    await setAppearance({ theme: "mocha" });
    const ctx = await chromium.launchPersistentContext("", {
      channel: "chromium",
      deviceScaleFactor: 2,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });
    try {
      const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
      const id = new URL(sw.url()).host;
      // The worker can be reported before its extension APIs are ready.
      for (let i = 0; i < 50 && !(await sw.evaluate(() => !!(globalThis as ChromeGlobal).chrome?.storage?.local).catch(() => false)); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await api(`/api/extensions/${id}/approve`, { method: "POST" });
      await sw.evaluate(async (d) => (globalThis as ChromeGlobal).chrome!.storage!.local!.set({ config: { daemonUrl: d, dwellSeconds: 4 } }), DAEMON);
      const popup = await ctx.newPage();
      await popup.setViewportSize({ width: 380, height: 560 });
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup.getByTestId("menu-recent").click();
      await popup.getByRole("option").first().waitFor();
      await popup.waitForTimeout(400);
      const raw = join(RAW, "popup.png");
      await popup.screenshot({ path: raw });
      await render(
        browser,
        `<div style="padding:24px 32px 48px"><div class="panel" style="width:380px;border-radius:12px;overflow:hidden;border:1px solid ${CHROME.mocha.border};box-shadow:0 18px 50px rgba(17,17,27,.28)"><img src="${dataUrl(raw)}"></div></div>`,
        join(OUT, "popup.png"),
        460,
      );
      console.log("✓ popup");
      await api(`/api/extensions/${id}`, { method: "DELETE" });
    } finally {
      await ctx.close();
      rmSync(extDir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  await setAppearance(previous);
  rmSync(RAW, { recursive: true, force: true });
}
console.log(`Wrote ${OUT}`);
