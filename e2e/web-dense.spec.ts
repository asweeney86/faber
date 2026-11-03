import { expect, test } from "@playwright/test";

/**
 * Search results and the sidebar. Runs against the shared seeded daemon; everything that
 * would change its data is stubbed with page.route.
 */

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
});
