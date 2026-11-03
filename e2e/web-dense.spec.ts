import { expect, test } from "@playwright/test";

/**
 * Search results and the sidebar. Runs against the shared seeded daemon; everything that
 * would change its data is stubbed with page.route.
 */

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.describe("search results", () => {
  test("long summaries are clamped to two lines, with the full text on hover", async ({ page }) => {
    const long = "A summary from before Faber asked for short ones, which goes on and on. ".repeat(8).trim();
    await page.route("**/api/search", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { hits: { doc: { enrichment: { summary: string } | null } }[] };
      const first = body.hits.find((h) => h.doc.enrichment);
      if (first) first.doc.enrichment!.summary = long;
      await r.fulfill({ response: res, json: body });
    });
    await page.goto("/#/search");
    const summary = page.getByTestId("result").locator(".result-summary").first();
    await expect(summary).toHaveAttribute("title", long);
    const { height, line } = await summary.evaluate((el) => ({ height: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight) }));
    expect(height).toBeLessThanOrEqual(Math.ceil(2 * line));
  });

  test("browsing lists the most used first, and Recent switches to last opened", async ({ page }) => {
    const sorts: (string | undefined)[] = [];
    await page.route("**/api/search", async (r) => {
      sorts.push((r.request().postDataJSON() as { sort?: string }).sort);
      await r.fallback();
    });
    await page.goto("/#/search");
    await expect(page.getByTestId("results-meta")).toContainText("Most used");
    await expect(page.getByTestId("sort-frequent")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("sort-recent").click();
    await expect(page).toHaveURL(/sort=recent/);
    await expect(page.getByTestId("results-meta")).toContainText("Recently opened");
    expect(sorts).toContain("frequent");
    expect(sorts.at(-1)).toBe("recent");
    // A query is ranked by relevance: no sort switch.
    await page.getByTestId("search-input").fill("pricing");
    await expect(page.getByTestId("results-meta")).toContainText(/result/);
    await expect(page.getByTestId("sort-recent")).toHaveCount(0);
  });

  test("documents show their site's icon (Google's for Docs); sites without one keep the built-in icon", async ({ page }) => {
    let noIconId = "";
    await page.route("**/api/search", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { hits: { doc: { id: string; source: string; canonical_url: string; title: string } }[] };
      // Turn two hits into web pages: one site with an icon, one without. The rest stay Google docs.
      body.hits[0]!.doc = { ...body.hits[0]!.doc, source: "url", canonical_url: "https://has-icon.example.com/a", title: "Has icon" };
      body.hits[1]!.doc = { ...body.hits[1]!.doc, source: "url", canonical_url: "https://no-icon.example.com/b", title: "No icon" };
      noIconId = body.hits[1]!.doc.id;
      await r.fulfill({ response: res, json: body });
    });
    await page.route("**/api/docs/*/favicon", (r) =>
      r.fulfill(r.request().url().includes(`/api/docs/${noIconId}/`) ? { status: 204 } : { status: 200, contentType: "image/png", body: PNG_1PX }),
    );
    await page.goto("/#/search");
    const results = page.getByTestId("result");
    await expect(results.nth(0).locator(".result-head img.favicon")).toBeVisible();
    await expect(results.nth(0).locator(".result-head .source-icon")).toHaveCount(0);
    await expect(results.nth(1).locator(".result-head img.favicon")).toHaveCount(0);
    await expect(results.nth(1).locator(".result-head .source-icon")).toBeVisible();
    await expect(results.nth(2).locator(".result-head img.favicon")).toBeVisible();
  });
});

test.describe("launcher", () => {
  test("⌘K shows web pages with their site's icon", async ({ page }) => {
    await page.route("**/api/search", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { hits: { doc: { source: string; canonical_url: string; title: string } }[] };
      body.hits[0]!.doc = { ...body.hits[0]!.doc, source: "url", canonical_url: "https://news.example.com/item", title: "A web page" };
      await r.fulfill({ response: res, json: body });
    });
    await page.route("**/api/docs/*/favicon", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }));
    await page.goto("/");
    await expect(page.getByTestId("digest")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("launcher-input").fill("pricing");
    const item = page.locator(".fl-item", { hasText: "A web page" });
    await expect(item.locator("img.favicon")).toBeVisible();
  });
});

test.describe("project tree", () => {
  const project = (id: string, name: string, parent_id: string | null = null) => ({
    id,
    name,
    parent_id,
    doc_count: 3,
    last_seen_at: Date.now(),
    recent_doc_count: 1,
    new_doc_count: 0,
    active: true,
    doc_types: [],
    top_people: [],
  });

  test("subprojects fold under their parent, stay as you left them, and a long list scrolls", async ({ page }) => {
    const many = Array.from({ length: 40 }, (_, i) => project(`p${i}`, `Project ${String(i).padStart(2, "0")}`));
    await page.route("**/api/projects", (r) =>
      r.fulfill({ json: [project("atlas", "Atlas"), project("atlas-pricing", "Pricing", "atlas"), project("atlas-billing", "Billing", "atlas"), ...many] }),
    );
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("faber:nav-expanded", JSON.stringify({ projects: true }));
      }
    });
    await page.goto("/#/search");
    const tree = page.getByTestId("nav-project-list");
    await expect(tree).toContainText("Atlas");
    await expect(tree).not.toContainText("Pricing");

    const toggle = tree.getByRole("button", { name: "Expand Atlas" });
    await toggle.click();
    await expect(tree).toContainText("Pricing");
    await expect(tree).toContainText("Billing");
    await expect(tree.getByRole("button", { name: "Collapse Atlas" })).toHaveAttribute("aria-expanded", "true");

    // Remembered across reloads.
    await page.reload();
    await expect(page.getByTestId("nav-project-list")).toContainText("Pricing");
    await page.getByTestId("nav-project-list").getByRole("button", { name: "Collapse Atlas" }).click();
    await expect(page.getByTestId("nav-project-list")).not.toContainText("Pricing");

    // Every project is listed, and the tree scrolls on its own instead of pushing the nav away.
    await expect(page.getByTestId("nav-project-list").locator(".nav-sub-link")).toHaveCount(41);
    const { scroll, client } = await page.getByTestId("nav-project-list").evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(scroll).toBeGreaterThan(client);
    await expect(page.getByTestId("nav-settings")).toBeInViewport();
  });

  test("opening a subproject opens its parent in the tree", async ({ page }) => {
    const parent = project("atlas", "Atlas");
    const child = project("atlas-pricing", "Pricing", "atlas");
    await page.route("**/api/projects", (r) => r.fulfill({ json: [parent, child] }));
    await page.route("**/api/projects/atlas-pricing", (r) =>
      r.fulfill({
        json: { ...child, docs: [], key_docs: [], meetings: [], people: [], topics: [], related_projects: [], ancestors: [parent], children: [], decisions: [], summary: null, aliases: [], own_doc_ids: [] },
      }),
    );
    await page.addInitScript(() => localStorage.setItem("faber:nav-expanded", JSON.stringify({ projects: true })));
    await page.goto("/#/projects/atlas-pricing");
    await expect(page.getByTestId("nav-project-list").locator(".is-active")).toHaveText("Pricing");
  });
});
