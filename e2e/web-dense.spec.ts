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

  test("web pages show their site's icon; docs and sites without one keep the built-in icon", async ({ page }) => {
    await page.route("**/api/search", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { hits: { doc: { id: string; source: string; canonical_url: string; title: string } }[] };
      // Turn two hits into web pages: one site with an icon, one without.
      body.hits[0]!.doc = { ...body.hits[0]!.doc, source: "url", canonical_url: "https://has-icon.example.com/a", title: "Has icon" };
      body.hits[1]!.doc = { ...body.hits[1]!.doc, source: "url", canonical_url: "https://no-icon.example.com/b", title: "No icon" };
      await r.fulfill({ response: res, json: body });
    });
    let asked = 0;
    await page.route("**/api/docs/*/favicon", async (r) => {
      asked++;
      // The first hit's doc gets an icon; anything else has none.
      const first = asked === 1;
      await r.fulfill(first ? { status: 200, contentType: "image/png", body: PNG_1PX } : { status: 204 });
    });
    await page.goto("/#/search");
    const results = page.getByTestId("result");
    await expect(results.nth(0).locator(".result-head img.favicon")).toBeVisible();
    await expect(results.nth(0).locator(".result-head .source-icon")).toHaveCount(0);
    await expect(results.nth(1).locator(".result-head img.favicon")).toHaveCount(0);
    await expect(results.nth(1).locator(".result-head .source-icon")).toBeVisible();
    // Google docs never ask.
    await expect(results.nth(2).locator(".result-head .source-icon")).toBeVisible();
    expect(asked).toBe(2);
  });
});
