import { expect, test, type Page } from "@playwright/test";

/**
 * Web UI v2: Home dashboard, Projects, sectioned Settings, appearance and the ⌘K launcher.
 * Shares the seeded e2e daemon with web.spec.ts (and runs before it), so every test that
 * changes daemon state puts it back: 4 demo projects, "system" appearance, built-in watchlist.
 */

const RATE_LIMIT = "Usage-Based Pricing: Rate Limit Design";
const SYSTEM = { theme: "system", dark_flavor: "mocha", accent: "mauve", density: "comfortable" };

async function openLauncher(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("digest")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("launcher-input");
  await expect(input).toBeFocused();
  return input;
}

/** Add a doc whose text names a project (the fake enricher picks up "Project Xyz"), and wait until it's enriched. */
async function addProjectDoc(page: Page, project: string, title: string) {
  const res = await page.request.post("/api/docs", {
    data: { url: `https://wiki.example.com/e2e-v2/${Date.now()}`, title, content: `Notes for Project ${project}. The plan is written down here in some detail.` },
  });
  expect(res.ok()).toBe(true);
  const { doc } = (await res.json()) as { doc: { id: string } };
  const id = project.toLowerCase();
  await expect.poll(async () => (await page.request.get(`/api/projects/${id}`)).status(), { timeout: 20_000 }).toBe(200);
  return { docId: doc.id, projectId: id };
}

test.describe("home", () => {
  test("with zero projects: no projects panel or top projects, glance shows 0, links still work", async ({ page }) => {
    await page.route("**/api/projects", (r) => r.fulfill({ json: [] }));
    await page.route("**/api/overview", async (r) => {
      const res = await r.fetch();
      r.fulfill({ response: res, json: { ...(await res.json()), projects: 0, new_projects: 0, activity: [] } });
    });
    await page.goto("/");
    await expect(page.getByTestId("digest")).toBeVisible();
    const glance = page.getByTestId("glance");
    await expect(glance.locator(".glance-row").filter({ hasText: "Projects" }).locator(".glance-value")).toHaveText("0");
    await expect(glance.locator(".glance-extra")).toHaveCount(0);
    await expect(page.getByTestId("projects-panel")).toHaveCount(0);
    await expect(page.getByTestId("top-projects")).toHaveCount(0);
    await expect(page.getByTestId("activity")).toHaveCount(0);
    // The sidebar has no project list or expander when there's nothing to list.
    await expect(page.getByTestId("nav-project-list")).toHaveCount(0);
    await expect(page.getByTestId("nav-expand-projects")).toHaveCount(0);
    // The Projects tile leads to an explained empty state.
    await page.getByTestId("tile-projects").click();
    await expect(page.getByTestId("projects-empty")).toContainText("No projects yet");
    await expect(page.getByTestId("project-grid")).toHaveCount(0);
  });

  test("glance counts match the API and its rows link to their pages", async ({ page }) => {
    const o = (await (await page.request.get("/api/overview")).json()) as { docs: number; projects: number; collections: number; people: number };
    await page.goto("/");
    const glance = page.getByTestId("glance");
    for (const [label, value] of [
      ["Projects", o.projects],
      ["Collections", o.collections],
      ["People", o.people],
      ["Documents", o.docs],
    ] as const) {
      await expect(glance.locator(".glance-row").filter({ hasText: label }).locator(".glance-value")).toHaveText(value.toLocaleString("en-US"));
    }
    await glance.locator(".glance-row").filter({ hasText: "People" }).click();
    await expect(page).toHaveURL(/#\/people$/);
  });

  test("a project activity item and a top project open the project", async ({ page }) => {
    await page.goto("/");
    const top = page.getByTestId("top-projects").getByRole("link").first();
    const name = (await top.locator(".top-project-name").textContent())!;
    await top.click();
    await expect(page).toHaveURL(/#\/projects\/[^/]+$/);
    await expect(page.getByTestId("project-page").getByRole("heading", { level: 1 })).toContainText(name);

    await page.goto("/");
    const projectActivity = page.getByTestId("activity").locator(".activity-project a");
    if ((await projectActivity.count()) > 0) {
      await projectActivity.first().click();
      await expect(page.getByTestId("project-page")).toBeVisible();
    }
  });

  test("the home search ⌘K button opens the launcher with what was typed", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("home-search").fill("frankfurt");
    await page.getByTestId("home-launcher").click();
    await expect(page.getByTestId("launcher-input")).toHaveValue("frankfurt");
    await expect(page.getByTestId("launcher").locator(".fl-group-title").filter({ hasText: "Documents" })).toBeVisible();
  });
});

test.describe("projects", () => {
  test("a project with a single doc has a complete, sensible page", async ({ page }) => {
    const { docId, projectId } = await addProjectDoc(page, "Solitaire", `E2E solitaire doc ${Date.now()}`);
    try {
      await page.goto("/#/projects");
      const card = page.getByTestId("project-grid").getByTestId("project-card").filter({ hasText: "Solitaire" });
      await expect(card).toContainText("1 doc");
      await expect(card).not.toContainText("1 docs");
      await card.click();
      await expect(page).toHaveURL(new RegExp(`#/projects/${projectId}$`));
      const ws = page.getByTestId("project-page");
      await expect(ws.getByRole("heading", { level: 1 })).toContainText("Solitaire");
      await expect(ws.locator(".page-header, header").first()).toContainText("1 doc");
      await expect(page.getByTestId("project-docs").getByRole("listitem").or(page.getByTestId("project-docs").locator("[data-testid=doc-row], .doc-row, li"))).not.toHaveCount(0);
      await expect(page.getByTestId("project-docs")).toContainText("E2E solitaire doc");
      await expect(page.getByTestId("project-key-docs")).toContainText("E2E solitaire doc");
      await expect(page.getByTestId("project-overview")).toContainText("Active");
      // Nothing to relate, no shared topics, no people.
      await expect(page.getByTestId("project-related")).toHaveCount(0);
      await expect(page.getByTestId("project-topics")).toHaveCount(0);
      await expect(page.getByTestId("project-people")).toHaveCount(0);
      // The breadcrumb leads back.
      await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Projects" }).click();
      await expect(page).toHaveURL(/#\/projects$/);
      await expect(page.getByTestId("project-grid")).toBeVisible();
    } finally {
      await page.request.delete(`/api/docs/${docId}`);
    }
    // Deleting its only doc removes the project.
    expect((await page.request.get(`/api/projects/${projectId}`)).status()).toBe(404);
    await page.goto(`/#/projects/${projectId}`);
    await expect(page.getByTestId("not-found")).toContainText("Project not found");
  });

  test("unicode project ids are encoded in links and load their page", async ({ page }) => {
    const summary = {
      id: "zürich-launch",
      name: "Zürich Launch",
      doc_count: 1,
      last_seen_at: Date.now(),
      recent_doc_count: 1,
      new_doc_count: 1,
      active: true,
      doc_types: [],
      top_people: [],
    };
    const requested: string[] = [];
    await page.route("**/api/projects", (r) => r.fulfill({ json: [summary] }));
    await page.route("**/api/projects/*", (r) => {
      requested.push(new URL(r.request().url()).pathname);
      r.fulfill({
        json: { ...summary, docs: [], key_docs: [], meetings: [], people: [], topics: [], related_projects: [], ancestors: [], children: [], decisions: [], summary: null, aliases: [], own_doc_ids: [] },
      });
    });
    await page.goto("/#/projects");
    const card = page.getByTestId("project-card").filter({ hasText: "Zürich Launch" });
    await expect(card.locator("a").first()).toHaveAttribute("href", "#/projects/z%C3%BCrich-launch");
    await card.locator("a").first().click();
    await expect(page.getByTestId("project-page").getByRole("heading", { level: 1 })).toContainText("Zürich Launch");
    expect(requested).toContain("/api/projects/z%C3%BCrich-launch"); // encoded once, not twice
    // Scoped search and Ask carry the display name.
    await expect(page.getByTestId("project-search")).toHaveAttribute("href", /project=z%C3%BCrich-launch/);
    await expect(page.getByTestId("project-ask")).toHaveAttribute("href", "#/ask?project=z%C3%BCrich-launch");
  });

  // Regression (fixed): the sidebar compares the raw (still percent-encoded) hash segment with the
  // decoded project id, so a project whose id isn't plain ASCII is never marked active in the
  // sidebar. packages/web/src/App.tsx Sidebar: `const [section, sub] = path.split("/")` vs
  // `sub === p.id` (useRoute().segments are decoded; `path` is not).
  test("the sidebar marks a unicode project as the open one", async ({ page }) => {
    const summary = { id: "zürich-launch", name: "Zürich Launch", doc_count: 1, last_seen_at: Date.now(), recent_doc_count: 1, new_doc_count: 1, active: true, doc_types: [], top_people: [] };
    await page.route("**/api/projects", (r) => r.fulfill({ json: [summary] }));
    await page.route("**/api/projects/*", (r) =>
      r.fulfill({ json: { ...summary, docs: [], key_docs: [], meetings: [], people: [], topics: [], related_projects: [], ancestors: [], children: [], decisions: [], summary: null, aliases: [], own_doc_ids: [] } }),
    );
    await page.goto("/#/projects/z%C3%BCrich-launch");
    await expect(page.getByTestId("project-page")).toBeVisible();
    await expect(page.getByTestId("nav-project-list").locator(".is-active")).toHaveText("Zürich Launch");
  });

  test("a project page whose API call fails offers Retry and recovers", async ({ page }) => {
    let fail = true;
    await page.route("**/api/projects/atlas", (r) => (fail ? r.fulfill({ status: 500, json: { error: "database is locked" } }) : r.continue()));
    await page.goto("/#/projects/atlas");
    await expect(page.getByText("database is locked")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("project-page")).toBeVisible();
  });

  test("project cards' related links and topic chips go to the right places", async ({ page }) => {
    await page.goto("/#/projects/atlas");
    const topics = page.getByTestId("project-topics");
    if ((await topics.count()) > 0) {
      const chip = topics.locator("a.chip").first();
      const tag = ((await chip.textContent()) ?? "").replace(/^#/, "").replace(/\s*\d+$/, "").trim();
      await chip.click();
      await expect(page).toHaveURL(/#\/search\?/);
      await expect(page).toHaveURL(new RegExp(`tag=${encodeURIComponent(tag)}`));
      await expect(page).toHaveURL(/project=atlas/);
      await page.goBack();
    }
    await page.getByTestId("project-related").getByRole("link").first().click();
    await expect(page).toHaveURL(/#\/projects\/(?!atlas)[^/]+$/);
    await expect(page.getByTestId("project-page")).toBeVisible();
  });
});

test.describe("settings", () => {
  for (const id of ["appearance", "shortcuts", "capture", "ai", "organization", "privacy"]) {
    test(`deep link #/settings/${id} opens that section directly and survives a reload`, async ({ page }) => {
      await page.goto(`/#/settings/${id}`);
      await expect(page.getByTestId(`settings-${id}`)).toBeVisible();
      await expect(page.getByTestId(`settings-nav-${id}`)).toHaveAttribute("aria-current", "page");
      await page.reload();
      await expect(page.getByTestId(`settings-${id}`)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#/settings/${id}$`));
    });
  }

  test("Settings → Shortcuts records a new Mac launcher hotkey and shows what each app has", async ({ page }) => {
    const put = (shortcuts: object) => page.request.put("/api/settings", { data: { shortcuts } });
    const clear = { launcher: null, launcher_active: null, browser: null };
    await put(clear);
    // The Mac row only shows on a Mac.
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
    try {
      await page.goto("/#/settings/shortcuts");
      const row = page.getByTestId("launcher-hotkey");
      await expect(row.getByTestId("hotkey-current")).toHaveText("⌥Space");
      await expect(row.getByTestId("hotkey-status")).toContainText("hasn’t connected");

      // Esc cancels recording.
      await row.getByTestId("hotkey-change").click();
      await expect(row.getByTestId("hotkey-recorder")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(row.getByTestId("hotkey-current")).toHaveText("⌥Space");

      // A reserved shortcut gets a warning before saving.
      await row.getByTestId("hotkey-change").click();
      await page.keyboard.press("Control+Space");
      await expect(row.getByTestId("hotkey-candidate")).toHaveText("⌃Space");
      await expect(row.getByTestId("hotkey-status")).toContainText("input sources");
      await row.getByRole("button", { name: "Cancel" }).click();

      await row.getByTestId("hotkey-change").click();
      await page.keyboard.press("Control+Alt+KeyJ");
      await expect(row.getByTestId("hotkey-candidate")).toHaveText("⌃⌥J");
      await row.getByTestId("hotkey-save").click();
      await expect(row.getByTestId("hotkey-current")).toHaveText("⌃⌥J");
      expect((await (await page.request.get("/api/settings")).json()).shortcuts.launcher).toBe("ctrl+option+j");

      // What the Mac app reports back (the launcher page does this inside the app).
      await put({ launcher_active: { label: "⌥Space", ok: true, at: Date.now() } });
      await page.reload();
      await expect(row.getByTestId("hotkey-status")).toContainText("Switching the launcher to ⌃⌥J");
      await put({ launcher_active: { label: "⌃⌥J", ok: true, at: Date.now() } });
      await page.reload();
      await expect(row.getByTestId("hotkey-status")).toContainText("Active in Faber Launcher");
      await put({ launcher_active: { label: "⌥Space", ok: false, at: Date.now() } });
      await page.reload();
      await expect(row.getByTestId("hotkey-status")).toContainText("another app already has it");

      await row.getByTestId("hotkey-reset").click();
      await expect(row.getByTestId("hotkey-current")).toHaveText("⌥Space");
      await expect(row.getByTestId("hotkey-reset")).toHaveCount(0);

      // The browser shortcut is whatever the extension says Chrome has.
      await expect(page.getByTestId("browser-shortcut")).toContainText("⌘⇧K");
      await put({ browser: { label: "⌥⇧F", at: Date.now() } });
      await page.reload();
      await expect(page.getByTestId("browser-shortcut")).toContainText("⌥⇧F");
      await put({ browser: { label: "", at: Date.now() } });
      await page.reload();
      await expect(page.getByTestId("browser-shortcut")).toContainText("Not set");
    } finally {
      await put(clear);
    }
  });

  test("#/settings pins the default section in the URL without adding a history entry", async ({ page }) => {
    await page.goto("/#/people");
    await page.goto("/#/settings");
    await expect(page).toHaveURL(/#\/settings\/appearance$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/people$/);
  });

  test("an unknown section falls back to the default one", async ({ page }) => {
    await page.goto("/#/settings/not-a-section");
    await expect(page.getByTestId("settings-appearance")).toBeVisible();
    await expect(page.getByTestId("settings-nav-appearance")).toHaveAttribute("aria-current", "page");
  });

  test("back and forward move between sections", async ({ page }) => {
    await page.goto("/#/settings/appearance");
    await page.getByTestId("settings-nav-ai").click();
    await page.getByTestId("settings-nav-privacy").click();
    await page.goBack();
    await expect(page.getByTestId("settings-ai")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("settings-appearance")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("settings-ai")).toBeVisible();
  });

  test("Organization links to the review inbox and the project list", async ({ page }) => {
    await page.goto("/#/settings/organization");
    const org = page.getByTestId("organization");
    await expect(org.getByTestId("org-review")).toHaveAttribute("href", "#/inbox");
    await org.getByRole("link", { name: /All 4 projects/ }).click();
    await expect(page).toHaveURL(/#\/projects$/);
  });
});

test.describe("appearance", () => {
  test.afterEach(async ({ page }) => {
    await page.request.put("/api/settings", { data: { appearance: SYSTEM } });
  });

  test("an appearance save doesn't touch the watchlist", async ({ page }) => {
    const before = (await (await page.request.get("/api/settings")).json()) as { watchlist: unknown };
    await page.goto("/#/settings/appearance");
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
    await page.getByTestId("theme-frappe").click();
    const req = (await saved).request();
    expect(Object.keys(JSON.parse(req.postData() ?? "{}"))).toEqual(["appearance"]);
    const after = (await (await page.request.get("/api/settings")).json()) as { watchlist: unknown };
    expect(after.watchlist).toEqual(before.watchlist);
  });

  test("each choice is reflected on <html> and survives a reload", async ({ page }) => {
    await page.goto("/#/settings/appearance");
    const html = page.locator("html");
    await page.getByTestId("theme-macchiato").click();
    await expect(html).toHaveAttribute("data-flavor", "macchiato");
    await expect(html).toHaveAttribute("data-mode", "dark");
    await page.getByTestId("accent-peach").click();
    await expect(page.getByTestId("accent-peach")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("density-compact").click();
    await expect
      .poll(async () => ((await (await page.request.get("/api/settings")).json()) as { appearance: unknown }).appearance)
      .toEqual({ theme: "macchiato", dark_flavor: "mocha", accent: "peach", density: "compact" });
    await page.reload();
    await expect(html).toHaveAttribute("data-flavor", "macchiato");
    await expect(html).toHaveAttribute("data-density", "compact");
    await expect(page.getByTestId("theme-macchiato")).toHaveAttribute("aria-checked", "true");
  });

  test("System follows the OS, using the chosen dark flavor when dark", async ({ page }) => {
    await page.request.put("/api/settings", { data: { appearance: { ...SYSTEM, dark_flavor: "frappe" } } });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-flavor", "latte");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-flavor", "frappe");
    await expect(html).toHaveAttribute("data-mode", "dark");
  });

  test("the cached choice paints before the daemon answers (no flash)", async ({ page }) => {
    await page.request.put("/api/settings", { data: { appearance: { ...SYSTEM, theme: "latte" } } });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-flavor", "latte");
    // Now hold /api/settings: the next load must paint Latte from the cache, not the Mocha default.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/settings", async (r) => {
      await held;
      await r.continue();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-flavor", "latte");
    release();
  });

  test("a change made elsewhere (the extension) is picked up when the window regains focus", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-flavor", /latte|mocha/);
    await page.request.put("/api/settings", { data: { appearance: { ...SYSTEM, theme: "frappe", accent: "green" } } });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("html")).toHaveAttribute("data-flavor", "frappe");
  });

  test("a failed save shows the error and rolls the preview back", async ({ page }) => {
    // Start from a known saved choice, and wait until it's on screen: a fresh page first paints
    // the built-in default, and reading the theme before settings arrive made this flaky in CI.
    await page.request.put("/api/settings", { data: { appearance: { ...SYSTEM, theme: "latte" } } });
    await page.goto("/#/settings/appearance");
    await expect(page.locator("html")).toHaveAttribute("data-flavor", "latte");
    await expect(page.getByTestId("theme-latte")).toHaveAttribute("aria-checked", "true");
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/settings", async (r) => {
      if (r.request().method() !== "PUT") return r.continue();
      await held;
      await r.fulfill({ status: 500, json: { error: "disk full" } });
    });
    await page.getByTestId("theme-frappe").click();
    await expect(page.locator("html")).toHaveAttribute("data-flavor", "frappe"); // instant preview
    release();
    await expect(page.getByText("disk full")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-flavor", "latte"); // back to what was saved
  });
});

test.describe("launcher keyboard", () => {
  test("no search results: only the Ask row; Enter on it asks", async ({ page }) => {
    const input = await openLauncher(page);
    await input.fill("zzqqxxnomatch");
    const items = page.getByTestId("launcher-item");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Ask Faber: “zzqqxxnomatch”");
    await expect(page.locator(".fl-group-title").filter({ hasText: "Documents" })).toHaveCount(0);
    await input.press("Enter");
    await expect(page.getByTestId("launcher-mode-ask")).toHaveClass(/is-active/);
  });

  test("a filter with no match shows the section's empty state", async ({ page }) => {
    const input = await openLauncher(page);
    await page.getByTestId("launcher-mode-pinned").click();
    await expect(page.getByTestId("launcher-item").first()).toBeVisible();
    await input.fill("zzqqxxnomatch");
    await expect(page.getByTestId("launcher-empty")).toHaveText("Nothing in Pinned matches “zzqqxxnomatch”.");
    await expect(page.getByTestId("launcher-actions")).toHaveCount(0); // nothing selected, no actions
    await input.press("Enter"); // nothing to open: no crash, launcher stays
    await expect(page.getByTestId("launcher")).toBeVisible();
  });

  test("arrows wrap around the list", async ({ page }) => {
    const input = await openLauncher(page);
    await page.getByTestId("launcher-mode-projects").click();
    const items = page.getByTestId("launcher-item");
    await expect(items).toHaveCount(4);
    await input.press("ArrowUp");
    await expect(items.nth(3)).toHaveAttribute("aria-selected", "true");
    await input.press("ArrowDown");
    await expect(items.nth(0)).toHaveAttribute("aria-selected", "true");
  });

  test("Backspace on an empty filter leaves a project; with text it just edits", async ({ page }) => {
    const input = await openLauncher(page);
    await page.getByTestId("launcher-mode-projects").click();
    await input.fill("atl");
    await input.press("Enter");
    await expect(page.getByTestId("launcher-back")).toContainText("Atlas");
    await expect(input).toHaveValue("");
    await input.fill("ra");
    await input.press("Backspace");
    await expect(input).toHaveValue("r");
    await expect(page.getByTestId("launcher-back")).toBeVisible();
    await input.press("Backspace");
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("launcher-back")).toBeVisible();
    await input.press("Backspace");
    await expect(page.getByTestId("launcher-back")).toHaveCount(0);
    await expect(input).toHaveValue("atl"); // the filter from before browsing in
    await expect(page.getByTestId("launcher-mode-projects")).toHaveClass(/is-active/);
  });

  test("filtering inside a project narrows its docs; the back crumb returns", async ({ page }) => {
    const input = await openLauncher(page);
    await page.getByTestId("launcher-mode-projects").click();
    await page.getByTestId("launcher-item").filter({ hasText: "Atlas" }).click();
    const items = page.getByTestId("launcher-item");
    await expect(items.first()).toBeVisible();
    const all = await items.count();
    await input.fill("rate limit");
    await expect.poll(() => items.count()).toBeLessThanOrEqual(all);
    await expect(items.first()).toContainText("Rate Limit");
    await page.getByTestId("launcher-back").click();
    await expect(page.getByTestId("launcher-back")).toHaveCount(0);
  });

  test("Option+letter on an empty query: R, C, P switch sections; A opens Ask; O opens the app home", async ({ page }) => {
    const input = await openLauncher(page);
    for (const [key, mode] of [
      ["Alt+KeyR", "recent"],
      ["Alt+KeyC", "collections"],
      ["Alt+KeyP", "pinned"],
    ] as const) {
      await input.press(key);
      await expect(page.getByTestId(`launcher-mode-${mode}`)).toHaveClass(/is-active/);
    }
    await input.press("Alt+KeyA");
    await expect(page.getByTestId("launcher-mode-ask")).toHaveClass(/is-active/);
    await expect(page.getByTestId("launcher-answer")).toHaveCount(0);

    await page.goto("/#/people");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("launcher-input").press("Alt+KeyO");
    await expect(page.getByTestId("launcher")).toHaveCount(0);
    await expect(page).toHaveURL(/#\/$/);
  });

  test("Option+letter with text typed is left to the input (no section switch, no ask)", async ({ page }) => {
    const input = await openLauncher(page);
    await input.fill("frankfurt");
    await expect(page.getByTestId("launcher-item").first()).toBeVisible();
    for (const key of ["Alt+KeyR", "Alt+KeyA", "Alt+KeyO"]) await input.press(key);
    await expect(page.getByTestId("launcher-mode-search")).toHaveClass(/is-active/);
    await expect(page.getByTestId("launcher")).toBeVisible();
    await expect(page.getByTestId("launcher-answer")).toHaveCount(0);
    await expect(input).toHaveValue(/^frankfurt/);
  });

  test("Enter pressed while a search is still settling opens the first fresh result", async ({ page, context }) => {
    await context.route("https://docs.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>Doc</title>Doc" }));
    try {
      const input = await openLauncher(page);
      // Type and press Enter at once: the empty-query list (recent docs) is still showing.
      await input.fill("rate limit design");
      const [tab] = await Promise.all([context.waitForEvent("page"), input.press("Enter")]);
      await expect(tab).toHaveURL(/docs\.google\.com\/document/);
      const opened = tab.url();
      await tab.close();
      const hits = (await (await page.request.post("/api/search", { data: { q: "rate limit design", limit: 7 } })).json()) as { hits: { doc: { canonical_url: string } }[] };
      expect(opened).toBe(hits.hits[0]!.doc.canonical_url);
    } finally {
      await context.unroute("https://docs.google.com/**");
    }
  });

  test("⌘⇧C copies the selected doc's link", async ({ page, context, browserName }) => {
    test.skip(browserName !== "chromium" || process.platform !== "darwin", "the mac binding is ⌘⇧C; elsewhere it is Ctrl+Alt+C");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const input = await openLauncher(page);
    await input.fill("rate limit design");
    await expect(page.getByTestId("launcher-item").first()).toContainText("Rate Limit Design");
    await input.press("Meta+Shift+KeyC");
    await expect(page.getByTestId("launcher-actions")).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https:\/\/docs\.google\.com\/document\//);
  });

  test("⌘K inside the launcher returns to Search; Esc clears an answer before closing", async ({ page }) => {
    const input = await openLauncher(page);
    await page.getByTestId("launcher-mode-collections").click();
    await input.fill("atlas");
    await input.press("ControlOrMeta+k");
    await expect(page.getByTestId("launcher-mode-search")).toHaveClass(/is-active/);
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("launcher")).toHaveCount(1); // not a second launcher
  });

  test("⌘↵ opens a doc's original in a new tab; Enter does too in the app", async ({ page, context }) => {
    await context.route("https://docs.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>Doc</title>Doc" }));
    try {
      const input = await openLauncher(page);
      await input.fill("rate limit design");
      await expect(page.getByTestId("launcher-item").first()).toContainText("Rate Limit Design");
      const [tab] = await Promise.all([context.waitForEvent("page"), input.press("ControlOrMeta+Enter")]);
      await expect(tab).toHaveURL(/docs\.google\.com\/document/);
      await tab.close();
      await expect(page.getByTestId("launcher")).toHaveCount(0);
      expect(page.url()).toMatch(/#\/$|\/$/); // the app stayed where it was
    } finally {
      await context.unroute("https://docs.google.com/**");
    }
  });

  test("⌘↵ on a project opens it in a new app tab instead of browsing into it", async ({ page, context }) => {
    const input = await openLauncher(page);
    await page.getByTestId("launcher-mode-projects").click();
    await input.fill("frank");
    await expect(page.getByTestId("launcher-item")).toHaveCount(1);
    const [tab] = await Promise.all([context.waitForEvent("page"), input.press("ControlOrMeta+Enter")]);
    await expect(tab).toHaveURL(/#\/projects\/frankfurt$/);
    await expect(tab.getByTestId("project-page")).toBeVisible();
    await tab.close();
    await expect(page.getByTestId("launcher")).toHaveCount(0);
    expect(new URL(page.url()).hash).toMatch(/^(#\/?)?$/); // this tab stayed home
  });

  test("⌘O on a doc opens its details drawer in the app", async ({ page }) => {
    const input = await openLauncher(page);
    await input.fill("rate limit design");
    await expect(page.getByTestId("launcher-item").first()).toContainText("Rate Limit Design");
    await input.press("ControlOrMeta+o");
    await expect(page.getByTestId("drawer").getByTestId("detail-title")).toHaveText(RATE_LIMIT);
  });

  test("people: browse into a person and back with Esc", async ({ page }) => {
    const input = await openLauncher(page);
    await page.getByTestId("launcher-mode-people").click();
    await input.fill("Maya");
    await input.press("Enter");
    await expect(page.getByTestId("launcher-back")).toContainText("Maya Chen");
    await expect(page.getByTestId("launcher-item").filter({ hasText: "Rate Limit" }).first()).toBeVisible();
    await input.press("Escape");
    await expect(input).toHaveValue("Maya");
  });

  test("clicking the backdrop closes the launcher; clicking inside does not", async ({ page }) => {
    await openLauncher(page);
    await page.getByTestId("launcher").locator(".fl-footer").click();
    await expect(page.getByTestId("launcher")).toBeVisible();
    await page.getByTestId("launcher-overlay").click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("launcher")).toHaveCount(0);
  });

  test("the shortcut doesn't open the add-bookmark form or a second launcher while open", async ({ page }) => {
    const input = await openLauncher(page);
    await input.fill("a");
    await expect(page.getByTestId("add-modal")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("launcher")).toHaveCount(1);
  });
});

test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const [name, hash, testId] of [
    ["home", "/", "glance"],
    ["projects", "/#/projects", "project-grid"],
    ["project", "/#/projects/atlas", "project-page"],
    ["settings", "/#/settings/appearance", "appearance"],
    ["ask", "/#/ask", "ask-input"],
  ] as const) {
    test(`${name} renders without horizontal scrolling`, async ({ page }) => {
      await page.goto(hash);
      await expect(page.getByTestId(testId)).toBeVisible();
      await page.waitForTimeout(300);
      const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(scroll).toBeLessThanOrEqual(client + 1);
      await page.screenshot({ path: `e2e/.results/screenshots/mobile-${name}.png`, fullPage: true });
    });
  }

  test("the launcher fits the screen and works (opened from a hardware keyboard)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest")).toBeVisible();
    await expect(page.getByTestId("home-launcher")).toBeHidden(); // no ⌘K hint without a keyboard
    await page.keyboard.press("ControlOrMeta+k");
    const panel = page.getByTestId("launcher");
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    await page.getByTestId("launcher-input").fill("atlas");
    await expect(page.getByTestId("launcher-item").first()).toBeVisible();
    await page.screenshot({ path: "e2e/.results/screenshots/mobile-launcher.png" });
  });
});
