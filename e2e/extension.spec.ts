/**
 * End-to-end tests for the Chrome extension against a seeded e2e daemon
 * (started by playwright.config.ts). Uses the FABER_TEST build, which can read
 * loopback pages without a permission prompt.
 */
import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON = process.env.FABER_E2E_DAEMON ?? "http://127.0.0.1:7788";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, "packages/extension/build-test");
const SHOTS = process.env.FABER_EXT_SHOTS ?? join(ROOT, "e2e/.results/screenshots/extension");

type Fixtures = { context: BrowserContext; sw: Worker; extId: string };

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
    // The worker can be reported before its extension APIs and module are ready.
    await expect
      .poll(() => sw.evaluate(() => typeof chrome !== "undefined" && !!chrome.storage?.local && "__faber" in globalThis).catch(() => false))
      .toBe(true);
    // The daemon only serves extensions the user has approved; approve this one (no Origin header → allowed).
    const id = new URL(sw.url()).host;
    const approved = await fetch(`${DAEMON}/api/extensions/${id}/approve`, { method: "POST" });
    if (!approved.ok) throw new Error(`approving extension failed: ${approved.status}`);
    // Point the extension at the e2e daemon with a short dwell, then sync the watchlist.
    await sw.evaluate(async (daemonUrl) => {
      await chrome.storage.local.set({ config: { daemonUrl, dwellSeconds: 1 }, queue: [] });
      await (globalThis as unknown as { __faber: { refreshWatchlist(): Promise<boolean> } }).__faber.refreshWatchlist();
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
  mkdirSync(SHOTS, { recursive: true });
});

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DAEMON}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function setWatchlist(mutate: (rules: { id: string; enabled: boolean; builtin: boolean; pattern: string }[]) => unknown[]) {
  const s = await api<{ watchlist: { id: string; enabled: boolean; builtin: boolean; pattern: string }[] }>("/api/settings");
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ watchlist: mutate(s.watchlist) }) });
}

/** Tiny local site the extension can be told to watch. */
async function startSite(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const name = (req.url ?? "/").replace(/[^a-z0-9-]/gi, "") || "home";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Team wiki: ${name}</title>
      <nav>Home · Teams · Search</nav>
      <main><h1>Quokka migration plan (${name})</h1>
      <p>The quokka service moves from the legacy cluster to the new regional platform in three phases.</p>
      <p>Phase one shadows traffic; phase two cuts over reads; phase three cuts over writes. Owner: Ada Byron.</p>
      ${"<p>Filler paragraph to make this a realistic page with enough text to be the main content block.</p>".repeat(4)}
      </main>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function waitForDoc(url: string, predicate: (d: { has_content: boolean }) => boolean = () => true, timeout = 15_000) {
  let doc: { id: string; has_content: boolean; title: string } | null = null;
  await expect
    .poll(
      async () => {
        const res = await fetch(`${DAEMON}/api/docs/lookup?url=${encodeURIComponent(url)}`);
        doc = res.ok ? await res.json() : null;
        return doc !== null && predicate(doc);
      },
      { timeout },
    )
    .toBe(true);
  return doc!;
}

async function shoot(page: Page, name: string, fullPage = false) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), fullPage });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("popup shows recent docs and searches the daemon", async ({ context, extId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 560 });
  await page.goto(`chrome-extension://${extId}/popup.html`);

  await expect(page.locator(".dot-ok")).toBeVisible();
  const search = page.getByRole("combobox", { name: "Search your docs" });
  await expect(search).toBeFocused();
  await expect(page.getByTestId("open-app")).toBeVisible();
  await shoot(page, "popup-home");

  // Recent is one click away.
  await page.getByTestId("menu-recent").click();
  await expect(page.getByText("Recent", { exact: true })).toBeVisible();
  await expect(page.getByRole("option").first()).toBeVisible();
  await shoot(page, "popup-recent");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("open-app")).toBeVisible();

  await search.fill("token bucket rate limit");
  const first = page.getByRole("option").first();
  await expect(first).toContainText("Rate Limit Design");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await shoot(page, "popup-search");

  // Keyboard navigation moves the selection (and the combobox points at it).
  await search.fill("gateway");
  await expect(page.getByRole("option").nth(1)).toBeVisible();
  await search.press("ArrowDown");
  const second = page.getByRole("option").nth(1);
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveAttribute("aria-activedescendant", (await second.getAttribute("id"))!);

  await search.fill("zzzz-no-such-thing");
  await expect(page.getByText(/No docs match/)).toBeVisible();

  // Escape clears the query and returns to the menu.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.getByTestId("open-app")).toBeVisible();

  // Collections list.
  await page.getByTestId("menu-collections").click();
  await expect(page.getByRole("button", { name: /Project Atlas/ })).toBeVisible();
});

test("popup shows the This page card for a known doc", async ({ context, extId }) => {
  const docUrl = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit";
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 560 });
  // A popup opened as a tab sees itself as the active tab; pretend the user is on the doc instead.
  await page.addInitScript((url) => {
    const fake = [{ id: 999, url, title: "Usage-Based Pricing: Rate Limit Design - Google Docs", active: true }];
    chrome.tabs.query = (() => Promise.resolve(fake)) as unknown as typeof chrome.tabs.query;
  }, docUrl);
  await page.goto(`chrome-extension://${extId}/popup.html`);

  const card = page.getByRole("region", { name: "This page" });
  await expect(card).toContainText("This page is saved");
  await expect(card).toContainText("Rate Limit Design");
  await expect(card.getByLabel("Pinned")).toBeVisible();
  // Editing controls and the AI summary stay hidden until asked for.
  await expect(card.getByRole("textbox", { name: "Note" })).toHaveCount(0);
  await shoot(page, "popup-page");
  await card.getByTestId("edit-page").click();
  await expect(card.getByRole("textbox", { name: "Note" })).toHaveValue(/approved/i);
  await shoot(page, "popup-page-edit");

  // Add a tag and check it reached the daemon.
  await card.getByRole("textbox", { name: "Add tag" }).fill("e2e-tag");
  await card.getByRole("textbox", { name: "Add tag" }).press("Enter");
  await expect(card.getByText("e2e-tag")).toBeVisible();
  const doc = await api<{ id: string; tags: { tag: string }[] }>(`/api/docs/lookup?url=${encodeURIComponent(docUrl)}`);
  expect(doc.tags.map((t) => t.tag)).toContain("e2e-tag");
  await card.getByRole("button", { name: "Remove tag e2e-tag" }).click();
  await expect(card.getByText("e2e-tag")).toHaveCount(0);

  // Put the page in a collection from the popup.
  await card.getByTestId("add-to-collection").selectOption({ label: "Frankfurt launch" });
  await expect(card.getByText("Added to Frankfurt launch.")).toBeVisible();

  // Projects: the detected one is listed; add another, then take it back out.
  const projects = card.getByTestId("popup-projects");
  await expect(projects).toContainText("Atlas");
  await projects.getByTestId("popup-project-input").fill("Frankfurt");
  await projects.getByTestId("popup-project-input").press("Enter");
  await expect(projects).toContainText("Frankfurt");
  await projects.getByRole("button", { name: "Not part of Frankfurt" }).click();
  await expect(projects).not.toContainText("Frankfurt");
  // Leave no correction behind for other tests.
  const c = await api<{ docs: { doc_id: string; project_id: string }[] }>("/api/organize/corrections");
  for (const d of c.docs) await api(`/api/docs/${d.doc_id}/projects`, { method: "PUT", body: JSON.stringify({ project: d.project_id, in: null }) });
});

test("popup asks for approval until the extension is paired", async ({ context, extId }) => {
  // Un-approve, open the popup, then approve and retry.
  await fetch(`${DAEMON}/api/extensions/${extId}`, { method: "DELETE" });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 380, height: 560 });
    await page.goto(`chrome-extension://${extId}/popup.html`);
    await expect(page.getByText("Approve Faber in the app")).toBeVisible();
    await expect(page.getByRole("button", { name: /Open settings/ })).toBeVisible();
    await shoot(page, "popup-pairing");

    await fetch(`${DAEMON}/api/extensions/${extId}/approve`, { method: "POST" });
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".dot-ok")).toBeVisible();
    await expect(page.getByTestId("open-app")).toBeVisible();
  } finally {
    await fetch(`${DAEMON}/api/extensions/${extId}/approve`, { method: "POST" });
  }
});

test("popup explains when the daemon is offline", async ({ context, extId, sw }) => {
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ config: { daemonUrl: "http://127.0.0.1:9", dwellSeconds: 1 } });
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 560 });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await expect(page.getByText("Faber isn’t running")).toBeVisible();
  await expect(page.getByText("bun faber serve")).toBeVisible();
  await shoot(page, "popup-offline");
});

test("options page toggles a built-in rule and persists it to the daemon", async ({ context, extId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto(`chrome-extension://${extId}/options.html`);

  await expect(page.getByText(/Connected · v/)).toBeVisible();
  const sw = page.getByRole("switch", { name: "Google Slides" });
  await expect(sw).not.toBeChecked();
  await sw.click();
  await expect(sw).toBeChecked();
  await expect(page.getByRole("status")).toContainText("Watchlist saved");

  const settings = await api<{ watchlist: { id: string; enabled: boolean }[] }>("/api/settings");
  expect(settings.watchlist.find((r) => r.id === "gslides")?.enabled).toBe(true);
  await page.waitForTimeout(3600); // let the toast fade before screenshots
  await shoot(page, "options", true);

  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect
    .poll(async () => (await api<{ watchlist: { id: string; enabled: boolean }[] }>("/api/settings")).watchlist.find((r) => r.id === "gslides")?.enabled)
    .toBe(false);
});

test("options page rejects an invalid custom pattern", async ({ context, extId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.getByRole("textbox", { name: "Site pattern" }).fill("not a host!");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText(/Use a site with an optional path/)).toBeVisible();
});

test("options page refuses a duplicate custom rule after normalisation", async ({ context, extId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await expect(page.getByText(/Connected · v/)).toBeVisible();
  try {
    await page.getByRole("textbox", { name: "Label" }).fill("Local");
    await page.getByRole("textbox", { name: "Site pattern" }).fill("localhost");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("Local", { exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "Site pattern" }).fill("HTTP://LocalHost/");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(/You already watch that/)).toBeVisible();
    const settings = await api<{ watchlist: { pattern: string }[] }>("/api/settings");
    expect(settings.watchlist.filter((r) => r.pattern === "localhost")).toHaveLength(1);
  } finally {
    await setWatchlist((rules) => rules.filter((r) => r.builtin));
  }
});

test("a custom watch rule captures a page with its text", async ({ context, extId }) => {
  const { server, base: site } = await startSite();
  try {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extId}/options.html`);
    await expect(options.getByText(/Connected · v/)).toBeVisible();
    await options.getByRole("textbox", { name: "Label" }).fill("Local wiki");
    await options.getByRole("textbox", { name: "Site pattern" }).fill("127.0.0.1");
    await options.getByRole("button", { name: "Add" }).click();
    await expect(options.getByText("Local wiki")).toBeVisible();
    const settings = await api<{ watchlist: { pattern: string; enabled: boolean }[] }>("/api/settings");
    expect(settings.watchlist.some((r) => r.pattern === "127.0.0.1" && r.enabled)).toBe(true);

    // Visit a watched page and stay past the dwell threshold.
    const pageUrl = `${site}/quokka-plan`;
    const page = await context.newPage();
    await page.goto(pageUrl);
    const doc = await waitForDoc(pageUrl, (d) => d.has_content);
    expect(doc.title).toContain("Team wiki");

    // Its text is searchable.
    await expect
      .poll(async () => (await api<{ hits: { doc: { id: string } }[] }>(`/api/search?q=quokka`)).hits.map((h) => h.doc.id))
      .toContain(doc.id);

    // The daemon's own UI is never captured even though 127.0.0.1 is watched.
    const ui = await context.newPage();
    await ui.goto(`${DAEMON}/`);
    await ui.waitForTimeout(2000);
    const own = await fetch(`${DAEMON}/api/docs/lookup?url=${encodeURIComponent(`${DAEMON}/`)}`);
    expect(own.status).toBe(404);
  } finally {
    server.close();
    await setWatchlist((rules) => rules.filter((r) => r.builtin));
  }
});

test("captures made while the daemon is down are queued and flushed later", async ({ context, sw }) => {
  const { server, base: site } = await startSite();
  try {
    await setWatchlist((rules) => [
      ...rules,
      { id: "custom-e2e", label: "Local", pattern: "127.0.0.1", extractor: "generic", enabled: true, builtin: false },
    ]);
    await sw.evaluate(async () => {
      await (globalThis as unknown as { __faber: { refreshWatchlist(): Promise<boolean> } }).__faber.refreshWatchlist();
    });
    // Daemon "goes away".
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ config: { daemonUrl: "http://127.0.0.1:9", dwellSeconds: 1 } });
    });

    const pageUrl = `${site}/offline-visit`;
    const page = await context.newPage();
    await page.goto(pageUrl);
    await expect
      .poll(async () => sw.evaluate(async () => ((await chrome.storage.local.get("queue")).queue as unknown[] | undefined)?.length ?? 0), {
        timeout: 10_000,
      })
      .toBe(1);
    expect((await fetch(`${DAEMON}/api/docs/lookup?url=${encodeURIComponent(pageUrl)}`)).status).toBe(404);

    // Daemon is back: flushing sends the queued capture, text included.
    await sw.evaluate(async (daemonUrl) => {
      await chrome.storage.local.set({ config: { daemonUrl, dwellSeconds: 1 } });
      await (globalThis as unknown as { __faber: { flush(): Promise<void> } }).__faber.flush();
    }, DAEMON);
    await waitForDoc(pageUrl, (d) => d.has_content);
    expect(await sw.evaluate(async () => ((await chrome.storage.local.get("queue")).queue as unknown[]).length)).toBe(0);
  } finally {
    server.close();
    await setWatchlist((rules) => rules.filter((r) => r.builtin));
  }
});

test("a watched page only accrues dwell time while it is the foreground tab", async ({ context, sw }) => {
  const { server, base: site } = await startSite();
  try {
    await setWatchlist((rules) => [
      ...rules,
      { id: "custom-bg", label: "Local", pattern: "127.0.0.1", extractor: "generic", enabled: true, builtin: false },
    ]);
    await sw.evaluate(async () => {
      await (globalThis as unknown as { __faber: { refreshWatchlist(): Promise<boolean> } }).__faber.refreshWatchlist();
    });

    const pageUrl = `${site}/background-tab`;
    const watched = await context.newPage();
    await watched.goto(pageUrl);
    // Immediately switch to another tab: the watched page sits in the background.
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    await watched.waitForTimeout(3000); // well past the 1s dwell
    expect((await fetch(`${DAEMON}/api/docs/lookup?url=${encodeURIComponent(pageUrl)}`)).status).toBe(404);

    // Back to the foreground: now it gets captured.
    await watched.bringToFront();
    await waitForDoc(pageUrl, (d) => d.has_content);
  } finally {
    server.close();
    await setWatchlist((rules) => rules.filter((r) => r.builtin));
  }
});

test("the toolbar icon shows whether the current tab is saved", async ({ context, sw, extId }) => {
  type Hook = {
    tabStatusFor(url: string): { tabId: number; state: string; title: string } | null;
    invalidateTab(tabId: number, url?: string): Promise<void>;
  };
  const statusOf = (url: string) =>
    sw.evaluate((u) => (globalThis as unknown as { __faber: Hook }).__faber.tabStatusFor(u), url);
  const { server, base: site } = await startSite();
  try {
    // A page already in Faber → filled "saved" icon.
    const savedUrl = `${site}/icon-saved`;
    const { doc: added } = await api<{ doc: { id: string } }>("/api/docs", { method: "POST", body: JSON.stringify({ url: savedUrl, title: "Icon test page" }) });
    const savedTab = await context.newPage();
    await savedTab.goto(savedUrl);
    await expect.poll(async () => (await statusOf(savedUrl))?.state).toBe("saved");
    expect((await statusOf(savedUrl))!.title).toMatch(/^Saved in Faber · opened \d+×/);

    // Pinning it (and refreshing, as the popup does) adds the pinned marker.
    await api(`/api/docs/${added.id}/pin`, { method: "PUT", body: JSON.stringify({ pinned: true }) });
    const savedTabId = (await statusOf(savedUrl))!.tabId;
    await sw.evaluate(([id, u]) => (globalThis as unknown as { __faber: Hook }).__faber.invalidateTab(id as number, u as string), [savedTabId, savedUrl]);
    await expect.poll(async () => (await statusOf(savedUrl))?.state).toBe("pinned");
    expect((await statusOf(savedUrl))!.title).toContain("Pinned");

    // A page that isn't saved → outline "not saved" icon.
    const unsavedUrl = `${site}/icon-unsaved`;
    const unsavedTab = await context.newPage();
    await unsavedTab.goto(unsavedUrl);
    await expect.poll(async () => (await statusOf(unsavedUrl))?.state).toBe("unsaved");
    expect((await statusOf(unsavedUrl))!.title).toBe("Not saved — click to save");

    // Save it from the popup → the icon flips to saved.
    const tabId = (await statusOf(unsavedUrl))!.tabId;
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 560 });
    await popup.addInitScript(
      ([id, url]) => {
        const fake = [{ id, url, title: "Team wiki: icon-unsaved", active: true }];
        chrome.tabs.query = (() => Promise.resolve(fake)) as unknown as typeof chrome.tabs.query;
      },
      [tabId, unsavedUrl] as const,
    );
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.getByRole("button", { name: /Save this page/ }).click();
    await expect(popup.getByText(/Saved\. It will be summarised/)).toBeVisible();
    await expect.poll(async () => (await statusOf(unsavedUrl))?.state).toBe("saved");
  } finally {
    server.close();
  }
});

test.describe("launcher", () => {
  test("the shortcut opens the launcher over the current page; Esc closes it", async ({ context, sw }) => {
    const { server, base } = await startSite();
    try {
      // Opening a result navigates this tab; keep that offline.
      await context.route("https://docs.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>Doc</title>Doc" }));
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${base}/launcher-host`);
      await page.bringToFront();
      const how = await sw.evaluate(() => (globalThis as unknown as { __faber: { openLauncher(): Promise<string> } }).__faber.openLauncher());
      expect(how).toBe("overlay");

      const frame = page.frameLocator("#faber-launcher-frame");
      const input = frame.getByTestId("launcher-input");
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
      await input.fill("rate limit");
      const item = frame.getByTestId("launcher-item").first();
      await expect(item).toContainText("Rate Limit Design");
      await expect(item).toHaveAttribute("aria-selected", "true");
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(150);
        await page.screenshot({ path: join(SHOTS, `launcher-overlay-${scheme}.png`) });
      }

      // Tab moves to the next section; Projects lists the inferred projects and browses into one.
      await input.press("Tab");
      await expect(frame.getByTestId("launcher-mode-recent")).toHaveClass(/is-active/);
      await frame.getByTestId("launcher-mode-projects").click();
      await expect(frame.getByTestId("launcher-item").filter({ hasText: "Atlas" })).toBeVisible();
      await frame.getByTestId("launcher-item").filter({ hasText: "Atlas" }).click();
      await expect(frame.getByTestId("launcher-back")).toContainText("Atlas");
      await input.press("Escape"); // back out of the project
      await expect(frame.getByTestId("launcher-back")).toHaveCount(0);

      // Esc closes, and the page gets its focus back.
      await input.press("Escape");
      await expect(page.locator("#faber-launcher-frame")).toHaveCount(0);

      // Enter opens the selected doc in this tab.
      expect(await sw.evaluate(() => (globalThis as unknown as { __faber: { openLauncher(): Promise<string> } }).__faber.openLauncher())).toBe("overlay");
      const input2 = page.frameLocator("#faber-launcher-frame").getByTestId("launcher-input");
      await input2.fill("rate limit design");
      await expect(page.frameLocator("#faber-launcher-frame").getByTestId("launcher-item").first()).toContainText("Rate Limit Design");
      await input2.press("Enter");
      await expect(page).toHaveURL(/docs\.google\.com\/document/);
    } finally {
      await context.unroute("https://docs.google.com/**");
      server.close();
    }
  });

  test("a website that frames the launcher itself gets nothing", async ({ context, extId }) => {
    const { server, base } = await startSite();
    try {
      const page = await context.newPage();
      await page.goto(`${base}/framer`);
      let apiCalls = 0;
      context.on("request", (r) => r.url().startsWith(DAEMON) && r.frame() !== page.mainFrame() && apiCalls++);
      // A forged URL: right shape, no ticket from the service worker.
      await page.evaluate((src) => {
        const f = document.createElement("iframe");
        f.id = "evil";
        f.src = src;
        document.body.appendChild(f);
      }, `chrome-extension://${extId}/launcher.html?mode=overlay&t=forged&q=pricing`);
      const frame = page.frameLocator("#evil");
      await page.waitForTimeout(1500);
      await expect(frame.getByTestId("launcher")).toHaveCount(0);
      await expect(frame.getByTestId("launcher-item")).toHaveCount(0);
      expect(apiCalls).toBe(0);
    } finally {
      server.close();
    }
  });

  test("pages Chrome won't let us script get the launcher in its own window", async ({ context, sw, extId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.bringToFront();
    const opened = context.waitForEvent("page");
    const how = await sw.evaluate(() => (globalThis as unknown as { __faber: { openLauncher(): Promise<string> } }).__faber.openLauncher());
    expect(how).toBe("window");
    const win = await opened;
    // Pressing the shortcut again focuses the same window instead of stacking another.
    expect(await sw.evaluate(() => (globalThis as unknown as { __faber: { openLauncher(): Promise<string> } }).__faber.openLauncher())).toBe("window");
    expect(context.pages().filter((p) => p.url().includes("launcher.html?mode=window"))).toHaveLength(1);
    await expect(win).toHaveURL(/launcher\.html\?mode=window/);
    const input = win.getByTestId("launcher-input");
    await expect(input).toBeVisible();
    await input.fill("frankfurt");
    await expect(win.locator(".fl-group-title").filter({ hasText: "Documents" })).toBeVisible();
    await expect(win.getByTestId("launcher-item").first()).toBeVisible();
    await win.screenshot({ path: join(SHOTS, "launcher-window.png") });
    const closed = win.waitForEvent("close");
    await input.press("Escape"); // clear
    await expect(input).toHaveValue("");
    // The window closes on keydown, so the key-up of this press may hit a closed page.
    await input.press("Escape").catch(() => {});
    await closed;
  });
});
