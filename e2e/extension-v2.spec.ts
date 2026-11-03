/**
 * Extension v2: the shared appearance reaching extension pages, and the launcher overlay /
 * window (toggle, origin checks, keyboard, problems). Same fixture as extension.spec.ts:
 * the FABER_TEST build against the seeded e2e daemon, one fresh browser per test.
 */
import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON = process.env.FABER_E2E_DAEMON ?? "http://127.0.0.1:7788";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, "packages/extension/build-test");
const SYSTEM = { theme: "system", dark_flavor: "mocha", accent: "mauve", density: "comfortable" };

type Fixtures = { context: BrowserContext; sw: Worker; extId: string };
type Hook = { openLauncher(query?: string): Promise<string> };

const test = base.extend<Fixtures>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await expect
      .poll(() => sw.evaluate(() => typeof chrome !== "undefined" && !!chrome.storage?.local && "__faber" in globalThis).catch(() => false))
      .toBe(true);
    const id = new URL(sw.url()).host;
    const approved = await fetch(`${DAEMON}/api/extensions/${id}/approve`, { method: "POST" });
    if (!approved.ok) throw new Error(`approving extension failed: ${approved.status}`);
    await sw.evaluate(async (daemonUrl) => {
      await chrome.storage.local.set({ config: { daemonUrl, dwellSeconds: 1 }, queue: [] });
    }, DAEMON);
    await use(sw);
  },
  extId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  execFileSync("bun", [join(ROOT, "packages/extension/build.ts")], { env: { ...process.env, FABER_TEST: "1" }, stdio: "inherit" });
});

const putAppearance = (a: Record<string, string>) =>
  fetch(`${DAEMON}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ appearance: a }) });

const openLauncher = (sw: Worker, query?: string) => sw.evaluate((q) => (globalThis as unknown as { __faber: Hook }).__faber.openLauncher(q), query);

async function startSite(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Host ${req.url}</title><main><h1>Host page</h1><input id="host-input" aria-label="host input"></main>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** A host page in the foreground with the launcher overlay open over it. */
async function overlayOn(context: BrowserContext, sw: Worker, site: string, query?: string) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${site}/host`);
  await page.bringToFront();
  expect(await openLauncher(sw, query)).toBe("overlay");
  const frame = page.frameLocator("#faber-launcher-frame");
  await expect(frame.getByTestId("launcher-input")).toBeFocused();
  return { page, frame, input: frame.getByTestId("launcher-input") };
}

test.describe("appearance", () => {
  test.afterEach(async () => {
    await putAppearance(SYSTEM);
  });

  test("the daemon's appearance reaches the popup and the options page", async ({ context, extId }) => {
    await putAppearance({ ...SYSTEM, theme: "latte", accent: "teal", density: "compact" });
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 560 });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    const html = popup.locator("html");
    await expect(html).toHaveAttribute("data-flavor", "latte");
    await expect(html).toHaveAttribute("data-mode", "light");
    await expect(html).toHaveAttribute("data-density", "compact");

    // Changed in the app: the next open follows (and paints from the shared cache at once).
    await putAppearance({ ...SYSTEM, theme: "frappe" });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extId}/options.html`);
    await expect(options.locator("html")).toHaveAttribute("data-flavor", "frappe");
    await popup.reload();
    await expect(html).toHaveAttribute("data-flavor", "frappe");
    await expect(html).toHaveAttribute("data-density", "comfortable");
  });

  test("the launcher overlay uses the daemon's appearance too", async ({ context, sw }) => {
    await putAppearance({ ...SYSTEM, theme: "macchiato" });
    const { server, base: site } = await startSite();
    try {
      const { frame } = await overlayOn(context, sw, site);
      await expect(frame.locator("html")).toHaveAttribute("data-flavor", "macchiato");
    } finally {
      server.close();
    }
  });

  test("System in the popup follows the OS", async ({ context, extId }) => {
    await putAppearance({ ...SYSTEM, dark_flavor: "frappe" });
    const popup = await context.newPage();
    await popup.emulateMedia({ colorScheme: "light" });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await expect(popup.locator("html")).toHaveAttribute("data-flavor", "latte");
    await popup.emulateMedia({ colorScheme: "dark" });
    await expect(popup.locator("html")).toHaveAttribute("data-flavor", "frappe");
  });
});

test.describe("launcher overlay", () => {
  let server: Server;
  let site: string;
  test.beforeEach(async () => {
    ({ server, base: site } = await startSite());
  });
  test.afterEach(() => {
    server.close();
  });

  test("the shortcut toggles it: a second press closes it and the page gets focus back", async ({ context, sw }) => {
    const page = await context.newPage();
    await page.goto(`${site}/toggle`);
    await page.bringToFront();
    await page.locator("#host-input").focus();
    expect(await openLauncher(sw)).toBe("overlay");
    await expect(page.frameLocator("#faber-launcher-frame").getByTestId("launcher-input")).toBeFocused();
    expect(await openLauncher(sw)).toBe("closed");
    await expect(page.locator("#faber-launcher-frame")).toHaveCount(0);
    await expect(page.locator("#host-input")).toBeFocused();
    // And it opens again afterwards, then still closes with Esc.
    expect(await openLauncher(sw)).toBe("overlay");
    const input = page.frameLocator("#faber-launcher-frame").getByTestId("launcher-input");
    await expect(input).toBeFocused();
    // Through the page keyboard (focus is in the frame): a locator press can hang when the
    // frame it targets is removed by that very keystroke.
    await page.keyboard.press("Escape");
    await expect(page.locator("#faber-launcher-frame")).toHaveCount(0);
  });

  test("the host page can't close it by posting the close message", async ({ context, sw }) => {
    const { page } = await overlayOn(context, sw, site);
    await page.evaluate(() => window.postMessage({ type: "faber:launcher-close" }, "*"));
    // Nor by framing launcher.html itself and closing from there.
    await page.evaluate(() => {
      const f = document.createElement("iframe");
      f.srcdoc = `<script>parent.postMessage({ type: "faber:launcher-close" }, "*")</script>`;
      document.body.appendChild(f);
    });
    await page.waitForTimeout(500);
    await expect(page.locator("#faber-launcher-frame")).toHaveCount(1);
  });

  test("clicking outside the panel closes it", async ({ context, sw }) => {
    const { page } = await overlayOn(context, sw, site);
    await page.mouse.click(8, 8);
    await expect(page.locator("#faber-launcher-frame")).toHaveCount(0);
  });

  test("it opens with a query, and ⌘↵ opens the result in a new tab, leaving this one", async ({ context, sw }) => {
    await context.route("https://docs.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>Doc</title>Doc" }));
    try {
      const { page, frame, input } = await overlayOn(context, sw, site, "rate limit design");
      await expect(input).toHaveValue("rate limit design");
      await expect(frame.getByTestId("launcher-item").first()).toContainText("Rate Limit Design");
      const [tab] = await Promise.all([context.waitForEvent("page"), input.press("ControlOrMeta+Enter")]);
      await expect(tab).toHaveURL(/docs\.google\.com\/document/);
      expect(page.url()).toBe(`${site}/host`);
      await expect(page.locator("#faber-launcher-frame")).toHaveCount(0);
    } finally {
      await context.unroute("https://docs.google.com/**");
    }
  });

  test("keyboard: Tab cycles all seven sections back to Search; no results leave only Ask", async ({ context, sw }) => {
    const { frame, input } = await overlayOn(context, sw, site);
    const order = ["recent", "pinned", "projects", "collections", "people", "ask", "search"];
    for (const mode of order) {
      await input.press("Tab");
      await expect(frame.getByTestId(`launcher-mode-${mode}`)).toHaveClass(/is-active/);
    }
    await input.fill("zzqqxxnomatch");
    await expect(frame.getByTestId("launcher-item")).toHaveCount(1);
    await expect(frame.getByTestId("launcher-item")).toContainText("Ask Faber");
    await input.press("Escape");
    await expect(input).toHaveValue("");
    await input.press("Alt+KeyP");
    await expect(frame.getByTestId("launcher-mode-pinned")).toHaveClass(/is-active/);
    await expect(frame.getByTestId("launcher-item").first()).toContainText("Rate Limit Design");
  });

  test("browse into a collection and back with Backspace", async ({ context, sw }) => {
    const { frame, input } = await overlayOn(context, sw, site);
    await frame.getByTestId("launcher-mode-collections").click();
    await input.fill("frankfurt");
    await input.press("Enter");
    await expect(frame.getByTestId("launcher-back")).toContainText("Frankfurt");
    await expect(frame.getByTestId("launcher-item").first()).toBeVisible();
    await input.press("Backspace");
    await expect(frame.getByTestId("launcher-back")).toHaveCount(0);
    await expect(input).toHaveValue("frankfurt");
  });

  test("Show in Faber (⌘O) opens the app in a new tab", async ({ context, sw }) => {
    const { page, input } = await overlayOn(context, sw, site);
    await input.press("Alt+KeyR");
    const [tab] = await Promise.all([context.waitForEvent("page"), input.press("ControlOrMeta+o")]);
    await expect(tab).toHaveURL(new RegExp(`^${DAEMON.replace(/[.]/g, "\\.")}/#/doc/`));
    expect(page.url()).toBe(`${site}/host`);
  });
});

test.describe("launcher problems", () => {
  test("daemon offline: the launcher explains instead of showing an empty list", async ({ context, sw, extId }) => {
    await sw.evaluate(async () => chrome.storage.local.set({ config: { daemonUrl: "http://127.0.0.1:9", dwellSeconds: 1 } }));
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.bringToFront();
    const opened = context.waitForEvent("page");
    expect(await openLauncher(sw)).toBe("window");
    const win = await opened;
    await expect(win.getByTestId("launcher-problem")).toContainText("Faber isn’t running");
    await expect(win.getByTestId("launcher-problem")).toContainText("http://127.0.0.1:9");
  });

  test("not paired: the launcher asks for approval", async ({ context, sw, extId }) => {
    await fetch(`${DAEMON}/api/extensions/${extId}`, { method: "DELETE" });
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/options.html`);
      await page.bringToFront();
      const opened = context.waitForEvent("page");
      expect(await openLauncher(sw)).toBe("window");
      const win = await opened;
      await expect(win.getByTestId("launcher-problem")).toContainText("Approve this extension in Faber");
      await expect(win.getByRole("button", { name: "Open settings" })).toBeVisible();
    } finally {
      await fetch(`${DAEMON}/api/extensions/${extId}/approve`, { method: "POST" });
    }
  });

  test("a launcher URL with a used ticket shows nothing on reload", async ({ context, sw, extId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.bringToFront();
    const opened = context.waitForEvent("page");
    await openLauncher(sw);
    const win = await opened;
    await expect(win.getByTestId("launcher-input")).toBeVisible();
    // Opening the same URL again (the ticket is spent): the page closes itself without any data.
    let apiCalls = 0;
    context.on("request", (r) => r.url().startsWith(DAEMON) && r.frame().url().includes("launcher.html") && r.frame().page() !== win && apiCalls++);
    const again = await context.newPage();
    const closed = again.waitForEvent("close", { timeout: 5000 }).then(() => true, () => false);
    await again.goto(win.url()).catch(() => {});
    if (!(await closed)) await expect(again.getByTestId("launcher")).toHaveCount(0);
    expect(apiCalls).toBe(0);
  });
});

// Regression (fixed): the popup's launcher button calls window.close() synchronously right after
// chrome.runtime.sendMessage({type:"open-launcher"}), so the popup is torn down before the
// message reaches the service worker and nothing opens (no ticket is ever issued). Stubbing
// window.close makes the launcher open. packages/extension/src/popup/App.tsx:131-134 —
// await the send (or close from the worker) before closing.
test("the popup's launcher button opens the launcher with what was typed", async ({ context, extId }) => {
  const popup: Page = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 560 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await expect(popup.getByTestId("open-app")).toBeVisible();
  await popup.getByRole("combobox", { name: "Search your docs" }).fill("frankfurt");
  // The popup (opened as a tab) is itself the active tab, which can't be scripted: window mode.
  const opened = context.waitForEvent("page");
  await popup.getByTestId("open-launcher").click();
  const win = await opened;
  await expect(win).toHaveURL(/launcher\.html\?mode=window/);
  await expect(win.getByTestId("launcher-input")).toHaveValue("frankfurt");
  await expect(win.getByTestId("launcher-item").first()).toBeVisible();
});


test("extension pages load site icons from the daemon like the app does", async ({ context, extId }) => {
  const res = await fetch(`${DAEMON}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "" }) });
  const id = ((await res.json()) as { hits: { doc: { id: string } }[] }).hits[0]!.doc.id;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  const icon = page.waitForResponse((r) => r.url().endsWith(`/api/docs/${id}/favicon`));
  await page.evaluate((src) => {
    const img = new Image();
    img.src = src;
    document.body.append(img);
  }, `${DAEMON}/api/docs/${id}/favicon`);
  // Allowed (the e2e daemon has icons off, so "no icon"), not refused as an unidentified extension request.
  expect((await icon).status()).toBe(204);
});
