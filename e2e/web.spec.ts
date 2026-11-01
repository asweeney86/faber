import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Web UI end-to-end tests. Runs against a daemon seeded by e2e/fixtures/serve.ts
 * (fake providers, ~12 demo docs). Tests share one database and run serially,
 * so each one creates uniquely named data rather than assuming a clean slate.
 */

const RATE_LIMIT = "Usage-Based Pricing: Rate Limit Design";
const Q3_SYNC = "Q3 Planning Sync - Growth";

async function docIdByTitle(page: Page, title: string): Promise<string> {
  const res = await page.request.post("/api/search", { data: { q: title, limit: 20 } });
  const body = (await res.json()) as { hits: { doc: { id: string; title: string } }[] };
  const hit = body.hits.find((h) => h.doc.title === title);
  if (!hit) throw new Error(`Seed doc not found: ${title}`);
  return hit.doc.id;
}

async function search(page: Page, q: string) {
  await page.goto("/#/search");
  const input = page.getByTestId("search-input");
  await input.fill(q);
  await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(q).replace(/%20/g, "\\+|%20")}`.replace("\\+|%20", "(\\+|%20)")));
  await expect(page.getByTestId("result").first()).toBeVisible();
}

test.describe("home", () => {
  test("digest renders its sections and the status indicator", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest")).toBeVisible();
    for (const id of ["pinned", "recent", "frequent", "resurfacing"]) {
      await expect(page.getByTestId(`digest-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("digest-pinned")).toContainText(RATE_LIMIT);
    await expect(page.getByTestId("daemon-status")).toContainText(/\d+ docs/);
    // Projects inferred from the demo docs, the rail and the explore tiles.
    await expect(page.getByTestId("projects-panel").getByTestId("project-card")).toHaveCount(3); // + the New project card
    await expect(page.getByTestId("home-new-project")).toBeVisible();
    await expect(page.getByTestId("glance")).toContainText("Projects");
    await expect(page.getByTestId("top-projects")).toContainText("Bedrock");
    await expect(page.getByTestId("activity")).toBeVisible();
    await expect(page.getByTestId("tile-projects")).toHaveAttribute("href", "#/projects");
  });

  test("home search box submits to the search page", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("home-search").fill("frankfurt");
    await page.getByTestId("home-search").press("Enter");
    await expect(page).toHaveURL(/#\/search\?q=frankfurt/);
    await expect(page.getByTestId("search-input")).toHaveValue("frankfurt");
  });
});

test.describe("search", () => {
  test("finds seeded docs and highlights matches", async ({ page }) => {
    await search(page, "pricing");
    const titles = page.getByTestId("result-title");
    await expect(titles.filter({ hasText: RATE_LIMIT })).toHaveCount(1);
    await expect(page.locator('[data-testid="result"] mark').first()).toBeVisible();
    await expect(page.getByTestId("results-meta")).toContainText(/result/);
  });

  test("a type filter chip narrows results and syncs to the URL", async ({ page }) => {
    await search(page, "pricing");
    const before = await page.getByTestId("result").count();
    await page.getByTestId("type-menu").click();
    await page.getByTestId("type-deck").click();
    await expect(page).toHaveURL(/type=deck/);
    await expect(page.getByTestId("type-deck")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("type-menu-list")).toBeHidden();
    await expect(page.getByTestId("type-menu")).toHaveText(/Deck/);
    await expect.poll(() => page.getByTestId("result").count()).toBeLessThan(before);
    const badges = await page.locator('[data-testid="result"] .badge').allTextContents();
    expect(badges.every((b) => b === "Deck")).toBe(true);
    await page.getByTestId("clear-filters").click();
    await expect(page).not.toHaveURL(/type=deck/);
  });

  test("facet sidebar toggles a person filter", async ({ page }) => {
    await search(page, "gateway");
    await page.getByTestId("facet-people").getByRole("button", { name: /Maya Chen/ }).click();
    await expect(page).toHaveURL(/person=Maya(\+|%20)Chen/);
    await expect(page.getByTestId("active-filter")).toContainText("Maya Chen");
  });

  test("shows an empty state for no matches", async ({ page }) => {
    await page.goto("/#/search?q=zzqqxxnomatch");
    await expect(page.getByTestId("no-results")).toBeVisible();
  });

  test("keyboard: arrows move selection, → opens details, Esc closes", async ({ page }) => {
    await search(page, "pricing");
    const results = page.getByTestId("result");
    expect(await results.count()).toBeGreaterThan(1);
    await expect(results.nth(0)).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("search-input").press("ArrowDown");
    await expect(results.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("search-input").press("ArrowUp");
    await expect(results.nth(0)).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("search-input").press("End");
    await page.getByTestId("search-input").press("ArrowRight");
    await expect(page.getByTestId("drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("drawer")).toBeHidden();
  });

  test("⌘K opens the launcher and / jumps to search from anywhere", async ({ page }) => {
    await page.goto("/#/people");
    await expect(page.getByTestId("people-table")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("launcher-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("launcher")).toHaveCount(0);
    await page.goto("/#/collections");
    await expect(page.getByTestId("collection-list")).toBeVisible();
    await page.locator("body").click();
    await page.keyboard.press("/");
    await expect(page.getByTestId("search-input")).toBeFocused();
  });
});

test.describe("doc detail", () => {
  test("tag, note and pin edits persist across reloads", async ({ page }) => {
    await search(page, "Q3 Planning Sync");
    const card = page.getByTestId("result").filter({ hasText: Q3_SYNC }).first();
    await card.locator(".doc-meta").click();
    const drawer = page.getByTestId("drawer");
    await expect(drawer.getByTestId("detail-title")).toHaveText(Q3_SYNC);

    await drawer.getByTestId("tag-input").fill("e2e-tag");
    await drawer.getByTestId("tag-input").press("Enter");
    await expect(drawer.locator('[data-tag="e2e-tag"]')).toBeVisible();

    await drawer.getByTestId("note-input").fill("Frankfurt blocker decision lives here");
    await drawer.getByTestId("note-input").press("ControlOrMeta+Enter");
    await expect(drawer.getByTestId("note-status")).toHaveText("Saved");

    const pin = drawer.getByTestId("detail-pin");
    const wasPinned = (await pin.getAttribute("aria-pressed")) === "true";
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", String(!wasPinned));

    const id = await drawer.getByTestId("doc-detail").getAttribute("data-doc-id");
    await page.goto(`/#/doc/${id}`);
    await page.reload();
    const detail = page.getByTestId("doc-detail");
    await expect(detail.locator('[data-tag="e2e-tag"]')).toBeVisible();
    await expect(detail.getByTestId("note-input")).toHaveValue("Frankfurt blocker decision lives here");
    await expect(detail.getByTestId("detail-pin")).toHaveAttribute("aria-pressed", String(!wasPinned));

    // Removing the tag also persists.
    await detail.getByRole("button", { name: "Remove tag e2e-tag" }).click();
    await expect(detail.locator('[data-tag="e2e-tag"]')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("doc-detail").locator('[data-tag="e2e-tag"]')).toHaveCount(0);
  });

  test("shows related docs and provenance", async ({ page }) => {
    const id = await docIdByTitle(page, RATE_LIMIT);
    await page.goto(`/#/doc/${id}`);
    await expect(page.getByTestId("detail-summary")).toBeVisible();
    await expect(page.getByTestId("related").locator(".related-item").first()).toBeVisible();
    await expect(page.getByTestId("provenance")).toContainText("Enriched by");
    await expect(page.getByTestId("detail-open")).toHaveAttribute("href", /docs\.google\.com/);
  });
});

test.describe("collections", () => {
  test("create, pin a doc, export and re-import", async ({ page }) => {
    const name = `E2E Collection ${Date.now()}`;
    await page.goto("/#/collections");
    await page.getByTestId("new-collection").click();
    await page.getByTestId("collection-name").fill(name);
    await page.getByTestId("collection-description").fill("Created by the web e2e suite");
    await page.getByTestId("save-collection").click();
    await expect(page.getByTestId("collection-title")).toHaveText(name);
    await expect(page.getByTestId("collection-empty")).toBeVisible();
    const collectionUrl = page.url();

    const docId = await docIdByTitle(page, RATE_LIMIT);
    await page.goto(`/#/doc/${docId}`);
    await page.getByTestId("add-to-collection").selectOption({ label: name });
    await expect(page.getByTestId("doc-collections")).toContainText(name);

    await page.goto(collectionUrl);
    await expect(page.getByTestId("collection-item")).toHaveCount(1);
    await expect(page.getByTestId("collection-item").first()).toContainText(RATE_LIMIT);
    await expect(page.getByTestId("collection-item").first()).toHaveAttribute("data-state", "pin");

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-collection").click()]);
    expect(download.suggestedFilename()).toMatch(/\.faber\.json$/);
    const exported = JSON.parse(readFileSync((await download.path())!, "utf8"));
    expect(exported.format).toBe("faber/collection");
    expect(exported.items.map((i: { title: string }) => i.title)).toContain(RATE_LIMIT);
    expect(JSON.stringify(exported)).not.toContain("token-bucket limiter at the API gateway keyed by org_id"); // no document text

    // Import it as a different collection (as if a teammate had sent it).
    const imported = {
      ...exported,
      id: crypto.randomUUID(),
      name: `${name} (imported)`,
      items: exported.items.map((i: { note: string | null }) => ({ ...i, note: "Teammate: start with the burst pricing section" })),
    };
    await page.goto("/#/collections");
    await page.getByTestId("import-file").setInputFiles({ name: "shared.faber.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
    await expect(page.getByTestId("import-result")).toContainText("Imported");
    await expect(page.getByTestId("collection-card").filter({ hasText: `${name} (imported)` })).toBeVisible();
    // The pin arrived with the exporter's note, so it is labelled as shared rather than "Added by you".
    await page.getByTestId("collection-card").filter({ hasText: `${name} (imported)` }).click();
    await expect(page.getByTestId("collection-shared")).toContainText(RATE_LIMIT);
    await expect(page.getByTestId("collection-shared").locator(".shared-note")).toContainText("Teammate: start with the burst pricing section");
    await expect(page.getByTestId("collection-pins")).toHaveCount(0);
  });

  test("rejects a file that isn't a collection export", async ({ page }) => {
    await page.goto("/#/collections");
    await page.getByTestId("import-file").setInputFiles({ name: "nope.json", mimeType: "application/json", buffer: Buffer.from('{"hello":1}') });
    await expect(page.getByRole("alert")).toContainText("isn’t a Faber collection");
  });

  test("smart collection shows matched docs that can be excluded", async ({ page }) => {
    await page.goto("/#/collections");
    await page.getByTestId("collection-card").filter({ hasText: "Project Atlas" }).click();
    await expect(page.getByTestId("smart-query")).toBeVisible();
    const matched = page.getByTestId("collection-matched").getByTestId("collection-item");
    const n = await matched.count();
    expect(n).toBeGreaterThan(0);
    await matched.first().getByTestId("exclude-item").click();
    await expect(matched).toHaveCount(n - 1);
    await page.getByTestId("toggle-excluded").click();
    await page.getByRole("button", { name: "Restore" }).first().click();
    await expect(matched).toHaveCount(n);
  });
});

test.describe("people", () => {
  test("filter the list and open a person", async ({ page }) => {
    await page.goto("/#/people");
    await page.getByTestId("people-filter").fill("Maya");
    await expect(page.getByTestId("person-row")).toHaveCount(1);
    await page.getByTestId("person-row").getByRole("link").click();
    await expect(page.getByTestId("person-name")).toHaveText("Maya Chen");
    await expect(page.getByTestId("person-docs")).toContainText(RATE_LIMIT);
    await page.getByTestId("related-people").getByRole("link").first().click();
    await expect(page).toHaveURL(/#\/people\/[^/]+$/);
    await expect(page.getByTestId("person-name")).not.toHaveText("Maya Chen");
  });
});

test.describe("ask", () => {
  test("returns an answer with clickable citations", async ({ page }) => {
    await page.goto("/#/ask");
    await page.getByTestId("ask-input").fill("What did we decide about EU data residency?");
    await page.getByTestId("ask-input").press("Enter");
    const answer = page.getByTestId("ask-answer");
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await expect(answer.getByTestId("citation").first()).toBeVisible();
    await answer.getByTestId("cite-ref").first().click();
    await answer.getByTestId("citation").first().locator(".cite-title").click();
    await expect(page.getByTestId("drawer")).toBeVisible();
  });
});

test.describe("settings", () => {
  test("watchlist toggle persists", async ({ page }) => {
    await page.goto("/#/settings/capture");
    const toggle = page.getByTestId("toggle-gslides");
    await expect(toggle).not.toBeChecked();
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
    await toggle.check();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(page.getByTestId("toggle-gslides")).toBeChecked();
    const api = (await (await page.request.get("/api/settings")).json()) as { watchlist: { id: string; enabled: boolean }[] };
    expect(api.watchlist.find((r) => r.id === "gslides")?.enabled).toBe(true);
    await page.getByTestId("toggle-gslides").uncheck();
  });

  test("custom site rules validate, add and remove", async ({ page }) => {
    await page.goto("/#/settings/capture");
    await page.getByTestId("rule-pattern").fill("not a host!");
    await page.getByTestId("rule-pattern").blur();
    await expect(page.getByTestId("rule-error")).toBeVisible();
    await expect(page.getByTestId("add-rule")).toBeDisabled();

    await page.getByTestId("rule-label").fill("Team wiki");
    await page.getByTestId("rule-pattern").fill("wiki.example.com/team");
    await page.getByTestId("add-rule").click();
    const row = page.locator('[data-testid^="rule-"]').filter({ hasText: "Team wiki" });
    await expect(row).toBeVisible();
    await page.reload();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Remove Team wiki" }).click();
    await expect(row).toHaveCount(0);
  });

  test("shows provider and storage info", async ({ page }) => {
    await page.goto("/#/settings/ai");
    await expect(page.getByTestId("providers")).toContainText("fake/");
    await page.getByTestId("settings-nav-privacy").click();
    await expect(page.getByTestId("storage")).toContainText("faber.sqlite");
  });

  test("sections: each one opens from the settings nav", async ({ page }) => {
    await page.goto("/#/settings");
    await expect(page.getByTestId("settings-appearance")).toBeVisible(); // the default with nothing pending
    for (const id of ["shortcuts", "capture", "ai", "organization", "privacy", "appearance"]) {
      await page.getByTestId(`settings-nav-${id}`).click();
      await expect(page.getByTestId(`settings-${id}`)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#/settings/${id}$`));
    }
    await expect(page.getByTestId("organization").or(page.getByTestId("appearance"))).toBeVisible();
  });

  test("appearance: theme, accent and density apply at once and persist across surfaces", async ({ page }) => {
    await page.goto("/#/settings/appearance");
    const html = page.locator("html");
    await page.getByTestId("theme-latte").click();
    await expect(html).toHaveAttribute("data-flavor", "latte");
    await expect(html).toHaveAttribute("data-mode", "light");
    await page.getByTestId("accent-teal").click();
    await page.getByTestId("density-compact").click();
    await expect(html).toHaveAttribute("data-density", "compact");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(239, 241, 245)"); // Latte base
    // Saved to the daemon (the extension reads it from there).
    await expect
      .poll(async () => ((await (await page.request.get("/api/settings")).json()) as { appearance: { theme: string; accent: string; density: string } }).appearance)
      .toEqual({ theme: "latte", dark_flavor: "mocha", accent: "teal", density: "compact" });
    // A fresh page load paints the same theme.
    await page.reload();
    await expect(html).toHaveAttribute("data-flavor", "latte");
    await page.screenshot({ path: "e2e/.results/screenshots/settings-appearance-latte.png" });
    // Back to the fixture's default for other tests.
    await page.request.put("/api/settings", { data: { appearance: { theme: "system", dark_flavor: "mocha", accent: "mauve", density: "comfortable" } } });
  });
});

test.describe("extension pairing", () => {
  const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
  const asExtension = { origin: `chrome-extension://${EXT_ID}` };

  test("a pending extension surfaces on Home and in Settings, and can be approved and removed", async ({ page }) => {
    // An unknown extension calling the API is refused and recorded as pending.
    const refused = await page.request.get("/api/status", { headers: asExtension });
    expect(refused.status()).toBe(403);

    await page.goto("/");
    await expect(page.getByTestId("settings-attention")).toHaveText("1");
    await expect(page.getByTestId("pairing-banner")).toBeVisible();
    await page.getByTestId("pairing-banner-dismiss").click();
    await expect(page.getByTestId("pairing-banner")).toBeHidden();
    await page.reload();
    await expect(page.getByTestId("pairing-banner")).toBeHidden(); // stays dismissed for the same request
    await expect(page.getByTestId("settings-attention")).toHaveText("1"); // the badge does not

    await page.getByTestId("nav-settings").click();
    const request = page.getByTestId("pending-extension").filter({ hasText: EXT_ID });
    await expect(request).toContainText("A browser extension is asking for access");
    await expect(page.getByTestId("extensions")).toContainText("read everything Faber has saved");
    await request.getByTestId("approve-extension").click();

    await expect(request).toHaveCount(0);
    const row = page.locator(`[data-testid="extension-approved"][data-extension-id="${EXT_ID}"]`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId("settings-attention")).toHaveCount(0);
    expect((await page.request.get("/api/status", { headers: asExtension })).status()).toBe(200);
    await page.reload();
    await expect(row).toContainText("Last seen");

    page.once("dialog", (d) => void d.accept());
    await row.getByTestId("remove-extension").click();
    await expect(row).toHaveCount(0);
    expect((await page.request.get("/api/status", { headers: asExtension })).status()).toBe(403);
    // Clean up the new pending entry so later tests start without a banner.
    await page.reload();
    await page.getByTestId("pending-extension").filter({ hasText: EXT_ID }).getByTestId("dismiss-extension").click();
    await expect(page.getByTestId("pending-extension")).toHaveCount(0);
  });
});

test.describe("doc collections in the drawer", () => {
  test("smart-collection match can be pinned, excluded and included again", async ({ page }) => {
    const id = await docIdByTitle(page, RATE_LIMIT);
    await page.goto(`/#/doc/${id}`);
    const atlas = page.getByTestId("doc-collection").filter({ hasText: "Project Atlas" });
    await expect(atlas).toHaveAttribute("data-state", "query");
    await expect(atlas).toContainText("Matches query");

    await atlas.getByTestId("ref-exclude").click();
    await expect(atlas).toHaveAttribute("data-state", "exclude");
    await expect(atlas).toContainText("Excluded");
    await atlas.getByTestId("ref-include").click();
    await expect(atlas).toHaveAttribute("data-state", "query");

    await atlas.getByTestId("ref-pin").click();
    await expect(atlas).toHaveAttribute("data-state", "pin");
    await page.reload();
    await expect(page.getByTestId("doc-collection").filter({ hasText: "Project Atlas" })).toHaveAttribute("data-state", "pin");
    await page.getByTestId("doc-collection").filter({ hasText: "Project Atlas" }).getByRole("button", { name: "Remove from Project Atlas" }).click();
    await expect(page.getByTestId("doc-collection").filter({ hasText: "Project Atlas" })).toHaveAttribute("data-state", "query");
  });

  test("collection page explains what an export shares", async ({ page }) => {
    await page.goto("/#/collections");
    await page.getByTestId("collection-card").filter({ hasText: "Frankfurt launch" }).click();
    await expect(page.getByTestId("export-note")).toContainText("never document text or AI summaries");
  });
});

test.describe("first run and offline", () => {
  test("an empty library shows the setup checklist on Home, Search and Ask", async ({ page }) => {
    // Pretend the library is empty; everything else (extensions, settings) is the real daemon.
    await page.route("**/api/status", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, docs: 0, docs_with_content: 0, enriched: 0 } });
    });
    await page.goto("/");
    const checklist = page.getByTestId("setup-checklist");
    await expect(checklist).toBeVisible();
    await expect(page.getByRole("heading", { name: "Welcome to Faber" })).toBeVisible();
    await expect(page.getByTestId("digest")).toHaveCount(0);
    await expect(checklist.getByTestId("import-command")).toContainText('bun faber import-chrome --profile "Work"');
    // Watchlist step reflects live settings.
    const watch = checklist.getByTestId("setup-watchlist");
    const settings = (await (await page.request.get("/api/settings")).json()) as { watchlist: { builtin: boolean; enabled: boolean; extractor: string }[] };
    const anyOn = settings.watchlist.some((r) => r.builtin && r.enabled && r.extractor !== "gcal");
    await expect(watch).toHaveAttribute("data-done", String(anyOn));
    await checklist.getByTestId("setup-add").click();
    await expect(page.getByTestId("add-modal")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto("/#/search");
    await expect(page.getByTestId("setup-checklist")).toBeVisible();
    await expect(page.getByTestId("results-meta")).toHaveCount(0);

    await page.goto("/#/ask");
    await expect(page.getByTestId("ask-empty")).toBeVisible();
    await expect(page.getByTestId("ask-input")).toBeDisabled();
    await expect(page.getByTestId("ask-suggestions")).toHaveCount(0);
  });

  test("Ask suggestions come from the library's own projects and tags", async ({ page }) => {
    await page.goto("/#/ask");
    const suggestions = page.getByTestId("ask-suggestions");
    await expect(suggestions).toBeVisible();
    await expect(suggestions).toContainText("Atlas");
    await suggestions.getByRole("button").first().click();
    await expect(page.getByTestId("ask-answer")).toBeVisible({ timeout: 20_000 });
  });

  test("no search hits offers to ask instead", async ({ page }) => {
    await page.goto("/#/search?q=zzqqxxnomatch");
    await page.getByTestId("ask-instead").click();
    await expect(page).toHaveURL(/#\/ask\?q=zzqqxxnomatch/);
    // The question in the URL is asked straight away.
    await expect(page.getByTestId("ask-answer")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("ask-answer")).toContainText("zzqqxxnomatch");
  });

  test("a stopped daemon shows a clear offline state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest")).toBeVisible();
    await page.route("**/api/**", (route) => route.abort("connectionrefused"));
    await page.reload();
    await expect(page.getByTestId("offline-banner")).toContainText("Can’t reach Faber");
    await expect(page.getByTestId("offline-banner")).toContainText("bun faber serve");
    await expect(page.getByTestId("daemon-status")).toContainText("Can’t reach the daemon", { timeout: 10_000 });
    await expect(page.locator(".nav-count")).toHaveCount(0);
    await page.unroute("**/api/**");
    await page.getByTestId("offline-banner").getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("digest")).toBeVisible();
  });

  test("people page lists meetings and the meeting page links back", async ({ page }) => {
    await page.goto("/#/people");
    const row = page.getByTestId("meeting-row").first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByTestId("meeting-title")).toBeVisible();
    await page.getByRole("link", { name: "← People & meetings" }).click();
    await expect(page).toHaveURL(/#\/people$/);
  });
});

test.describe("QA fixes", () => {
  test("facets are scoped to the current results, so picking one never empties the list", async ({ page }) => {
    await search(page, "frankfurt");
    const total = await page.getByTestId("result").count();
    const people = page.getByTestId("facet-people").locator(".facet-item");
    const n = Math.min(await people.count(), 4);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const item = people.nth(i);
      const count = Number(await item.locator(".facet-count").textContent());
      expect(count).toBeLessThanOrEqual(total);
      await item.click();
      await expect(page.getByTestId("result")).toHaveCount(count);
      await expect(page.getByTestId("no-results")).toHaveCount(0);
      await page.getByTestId("active-filter").first().click();
      await expect(page.getByTestId("result")).toHaveCount(total);
    }
  });

  test("daemon setup issues show in the shell and in Settings", async ({ page }) => {
    const issue = "Ollama isn't reachable at http://127.0.0.1:11434. Start it with `brew services start ollama`";
    await page.route("**/api/status", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, issues: [issue], enricher_ok: false, embedder_ok: false } });
    });
    await page.goto("/");
    const bar = page.getByTestId("status-issues");
    await expect(bar).toContainText("Ollama isn't reachable");
    await expect(bar.locator("code")).toHaveText("brew services start ollama");
    await bar.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-issues")).toContainText("Ollama isn't reachable");
    await expect(page.getByTestId("models-enrich")).toContainText("not ready");
    await expect(page.getByTestId("models-embed")).toContainText("not ready");
    await expect(page.getByTestId("providers")).toContainText("config.toml");
  });

  test("Settings → AI lets you pick the models: downloads, switches, re-indexes", async ({ page }) => {
    // The e2e daemon runs offline fake models, so stand in for a machine running Ollama.
    const choice = (id: string, label: string, installed: boolean, size_gb: number) => ({ id, label, detail: `${label} model`, size_gb, installed });
    let state = {
      enrich: { provider: "ollama", model: "qwen3:4b", editable: true, installed: true, choices: [choice("qwen3:4b", "Fast", true, 2.5), choice("qwen3:8b", "Thorough", false, 5.2)] },
      embed: {
        provider: "ollama",
        model: "qwen3-embedding:0.6b",
        editable: true,
        installed: true,
        choices: [choice("qwen3-embedding:0.6b", "Fast", true, 0.6), choice("qwen3-embedding", "Most accurate", true, 4.7)],
      },
      ollama_reachable: true,
      pull: null as null | Record<string, unknown>,
      reindex_remaining: 0,
      summaries_from_other_models: 0,
    };
    const puts: unknown[] = [];
    await page.route("**/api/models**", async (route) => {
      const req = route.request();
      if (req.method() === "PUT") {
        const body = req.postDataJSON() as { kind: "enrich" | "embed"; model: string };
        puts.push(body);
        if (body.model === "qwen3:8b") state = { ...state, pull: { kind: "enrich", model: "qwen3:8b", status: "downloading", completed: 2 * 1024 ** 3, total: 5 * 1024 ** 3, error: null } };
        else state = { ...state, [body.kind]: { ...state[body.kind], model: body.model }, reindex_remaining: body.kind === "embed" ? 12 : 0 };
      }
      if (req.method() === "POST") return route.fulfill({ json: { queued: 7 } });
      await route.fulfill({ json: state });
    });
    await page.goto("/#/settings/ai");
    const enrich = page.getByTestId("models-enrich");
    await expect(enrich.getByTestId("model-choice-qwen3:4b").getByRole("radio")).toBeChecked();
    await expect(enrich.getByTestId("model-choice-qwen3:8b")).toContainText("5.2 GB download");

    // A model that isn't downloaded yet: progress, then it's the one in use.
    await enrich.getByTestId("model-choice-qwen3:8b").click();
    await expect(enrich.getByTestId("model-pull-enrich")).toContainText("Downloading qwen3:8b · 40% of 5.0 GB");
    state = { ...state, pull: null, enrich: { ...state.enrich, model: "qwen3:8b" }, summaries_from_other_models: 7 };
    await expect(enrich.getByTestId("model-choice-qwen3:8b").getByRole("radio")).toBeChecked();
    await expect(enrich.getByTestId("resummarise-note")).toContainText("7 documents were summarised by another model");
    await enrich.getByTestId("resummarise").click();
    await expect(enrich.getByTestId("resummarise-note")).toContainText("Queued 7 documents");

    // The search model: re-indexing shows until it's done.
    const embed = page.getByTestId("models-embed");
    await embed.getByTestId("model-choice-qwen3-embedding").click();
    await expect(embed.getByTestId("reindex-progress")).toContainText("Re-indexing 12 documents with qwen3-embedding");
    state = { ...state, reindex_remaining: 0 };
    await expect(embed.getByTestId("reindex-progress")).toHaveCount(0);

    // Any other Ollama model, by name.
    await embed.getByTestId("model-custom-embed").fill("nomic-embed-text");
    await embed.getByRole("button", { name: "Use" }).click();
    expect(puts).toEqual([
      { kind: "enrich", model: "qwen3:8b" },
      { kind: "embed", model: "qwen3-embedding" },
      { kind: "embed", model: "nomic-embed-text" },
    ]);
  });

  test("Ask lists cited sources first and the rest under “Also read”", async ({ page }) => {
    await page.goto("/#/ask");
    await page.getByTestId("ask-input").fill("What blocked the Frankfurt launch?");
    await page.getByTestId("ask-input").press("Enter");
    const answer = page.getByTestId("ask-answer");
    await expect(answer).toBeVisible({ timeout: 20_000 });
    const text = (await answer.locator(".answer-body").textContent()) ?? "";
    const refs = await answer.getByTestId("cite-ref").allTextContents();
    const distinct = new Set(refs.map(Number));
    expect(distinct.size).toBeGreaterThan(0);
    const cited = await answer.getByTestId("citation").locator(".cite-n").allTextContents();
    expect(new Set(cited.map(Number))).toEqual(distinct);
    const uncited = answer.getByTestId("uncited-source");
    if ((await uncited.count()) > 0) {
      await expect(answer.getByTestId("also-read").locator("summary")).toHaveText(`Also read (${await uncited.count()})`);
      await expect(uncited.first()).toBeHidden(); // collapsed by default
    }
    expect(text.length).toBeGreaterThan(0);
  });

  test("Ask shows a friendly notice when the model is unavailable", async ({ page }) => {
    await page.route("**/api/ask", (route) =>
      route.fulfill({ status: 503, json: { error: "Ollama isn't reachable. Start it with `brew services start ollama`", code: "model_unavailable" } }),
    );
    await page.goto("/#/ask");
    await page.getByTestId("ask-input").fill("anything");
    await page.getByTestId("ask-input").press("Enter");
    const notice = page.getByTestId("ask-unavailable");
    await expect(notice).toContainText("The answer model isn’t available");
    await expect(notice.locator("code")).toHaveText("brew services start ollama");
    await expect(page.getByTestId("error-banner")).toHaveCount(0);
  });

  for (const [what, hash] of [
    ["Document", "#/doc/00000000-0000-0000-0000-000000000000"],
    ["Collection", "#/collections/00000000-0000-0000-0000-000000000000"],
    ["Person", "#/people/00000000-0000-0000-0000-000000000000"],
    ["Meeting", "#/meetings/00000000-0000-0000-0000-000000000000"],
  ] as const) {
    test(`a missing ${what.toLowerCase()} shows “not found” with a way back, not Retry`, async ({ page }) => {
      await page.goto(`/${hash}`);
      await expect(page.getByTestId("not-found")).toContainText(`${what} not found`);
      await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
      await expect(page.getByTestId("not-found").getByRole("link")).toBeVisible();
    });
  }

  test("tag input caps length and shows server validation errors", async ({ page }) => {
    const id = await docIdByTitle(page, Q3_SYNC);
    await page.goto(`/#/doc/${id}`);
    const input = page.getByTestId("tag-input");
    await expect(input).toHaveAttribute("maxlength", "60");
    await page.route("**/api/docs/*/tags", (route) =>
      route.request().method() === "POST" ? route.fulfill({ status: 400, json: { error: "tag must be 1-60 characters" } }) : route.continue(),
    );
    await input.fill("x".repeat(60));
    await input.press("Enter");
    await expect(page.getByTestId("tag-error")).toHaveText("tag must be 1-60 characters");
    await input.fill("ok");
    await expect(page.getByTestId("tag-error")).toHaveCount(0);
  });
});

test.describe("add a bookmark by hand", () => {
  test("add with pasted text, then find it by a word in the text; re-adding updates", async ({ page }) => {
    const stamp = Date.now();
    const word = `zebrafinch${stamp}`;
    const url = `https://wiki.example.com/e2e/${stamp}`;
    await page.goto("/");
    await page.getByTestId("nav-add").click();
    const form = page.getByTestId("add-modal");
    await expect(form.getByTestId("add-url")).toBeFocused();
    await form.getByTestId("add-url").fill(url);
    await form.getByTestId("add-title").fill(`E2E wiki page ${stamp}`);
    await form.getByTestId("add-text-toggle").click();
    await form.getByTestId("add-content").fill(`Notes on the ${word} migration plan.\n\nOwner: Lin Zhao.`);
    await form.getByTestId("add-note").fill("Added by the e2e suite");
    await form.getByTestId("add-tags").fill("e2e, wiki");
    await form.getByTestId("add-content").press("ControlOrMeta+Enter");
    await expect(page.getByTestId("add-modal")).toHaveCount(0);
    await expect(page.getByTestId("toast").first()).toContainText("Added");

    await search(page, word);
    await expect(page.getByTestId("result-title").first()).toContainText(`E2E wiki page ${stamp}`);

    // Same URL again: the existing bookmark is updated, not duplicated.
    await page.keyboard.press("Escape");
    await page.locator("body").click();
    await page.keyboard.press("a");
    const again = page.getByTestId("add-modal");
    await again.getByTestId("add-url").fill(url);
    await again.getByTestId("add-submit").click();
    const toast = page.getByTestId("toast").filter({ hasText: "Already saved — updated" });
    await expect(toast).toBeVisible();
    await toast.getByTestId("toast-action").click();
    await expect(page.getByTestId("drawer").getByTestId("detail-title")).toContainText(`E2E wiki page ${stamp}`);
  });

  test("a Google doc without text says it is waiting for text", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-add").click();
    const id = `1E2e${Date.now()}abcdefghijklmnopqrstu`;
    await page.getByTestId("add-url").fill(`https://docs.google.com/document/d/${id}/edit`);
    await expect(page.getByTestId("add-modal").locator(".source-gdoc")).toBeVisible();
    await page.getByTestId("add-submit").click();
    await expect(page.getByTestId("toast").first()).toContainText("No text yet");
  });

  test("rejects a non-http link with an inline error; Esc closes", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-add").click();
    await page.getByTestId("add-url").fill("ftp://files.example.com/thing");
    await page.getByTestId("add-submit").click();
    await expect(page.getByTestId("add-url-error")).toContainText("Only http:// and https://");
    await expect(page.getByTestId("add-url")).toHaveAttribute("aria-invalid", "true");
    await page.getByTestId("add-url").fill("not a url");
    await page.getByTestId("add-submit").click();
    await expect(page.getByTestId("add-url-error")).toContainText("doesn’t look like a link");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("add-modal")).toHaveCount(0);
  });

  test("deep link prefills the form (for the bookmarklet)", async ({ page }) => {
    await page.goto(`/#/add?url=${encodeURIComponent("https://example.com/deep?x=1")}&title=${encodeURIComponent("Deep linked page")}`);
    await expect(page.getByTestId("add-url")).toHaveValue("https://example.com/deep?x=1");
    await expect(page.getByTestId("add-title")).toHaveValue("Deep linked page");
    await page.getByTestId("add-submit").click();
    await expect(page.getByTestId("add-result")).toContainText("Deep linked page");
  });

  test("choosing a text file fills the text box; oversized files are refused", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-add").click();
    await page.getByTestId("add-text-toggle").click();
    await page.getByTestId("add-file").setInputFiles({ name: "export.txt", mimeType: "text/plain", buffer: Buffer.from("Exported plain text body\nline two") });
    await expect(page.getByTestId("add-content")).toHaveValue("Exported plain text body\nline two");
    await expect(page.getByTestId("add-title")).toHaveValue("export");
    await page.getByTestId("add-file").setInputFiles({ name: "huge.txt", mimeType: "text/plain", buffer: Buffer.alloc(1_100_000, 97) });
    await expect(page.getByTestId("add-content-error")).toContainText("limit is 1 MB");
  });

  test("Settings offers a bookmarklet pointing at this daemon", async ({ page }) => {
    await page.goto("/#/settings/capture");
    const link = page.getByTestId("bookmarklet");
    await expect(link).toHaveAttribute("href", /^javascript:location\.href='http:\/\/127\.0\.0\.1:\d+\/#\/add\?url='\+encodeURIComponent\(location\.href\)/);
    await expect(page.getByTestId("bookmarklet-section")).toContainText("Drag to your bookmarks bar");
  });
});

test.describe("projects", () => {
  test("projects are inferred from documents and each has a workspace", async ({ page }) => {
    await page.goto("/#/projects");
    const cards = page.getByTestId("project-grid").getByTestId("project-card");
    await expect(cards).toHaveCount(4);
    await expect(cards.filter({ hasText: "Bedrock" })).toContainText("5 docs");
    await cards.filter({ hasText: "Atlas" }).click();
    await expect(page).toHaveURL(/#\/projects\/atlas$/);
    const ws = page.getByTestId("project-page");
    await expect(ws.getByRole("heading", { level: 1 })).toContainText("Atlas");
    await expect(page.getByTestId("project-overview")).toContainText("Includes");
    await expect(page.getByTestId("project-docs")).toContainText(RATE_LIMIT);
    await expect(page.getByTestId("project-people")).toContainText("Maya Chen");
    await expect(page.getByTestId("project-related")).toContainText("Bedrock");
    // The sidebar lists projects and marks the open one.
    await expect(page.getByTestId("nav-project-list").locator(".is-active")).toHaveText("Atlas");
    // Scoped search: the project filter is applied.
    await page.getByTestId("project-search").click();
    await expect(page).toHaveURL(/project=atlas/); // by id; the chip shows the name
    await expect(page.getByTestId("active-filter").first()).toContainText("Atlas");
  });

  test("an unknown project is a clear 404", async ({ page }) => {
    await page.goto("/#/projects/no-such-project");
    await expect(page.getByTestId("not-found")).toContainText("Project not found");
  });

  test("the sidebar groups can be collapsed and remember it", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("nav-project-list")).toBeVisible();
    await page.getByTestId("nav-expand-projects").click();
    await expect(page.getByTestId("nav-project-list")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("nav-project-list")).toHaveCount(0);
    await page.getByTestId("nav-expand-projects").click();
    await expect(page.getByTestId("nav-project-list")).toBeVisible();
  });
});

test.describe("launcher (app)", () => {
  test("⌘K opens the three-column launcher; search spans docs, projects and collections", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const launcher = page.getByTestId("launcher");
    await expect(launcher).toBeVisible();
    const input = page.getByTestId("launcher-input");
    await expect(input).toBeFocused();
    // Empty query: recent docs.
    await expect(launcher.getByTestId("launcher-item").first()).toBeVisible();
    await input.fill("atlas");
    await expect(launcher.locator(".fl-group-title").filter({ hasText: "Documents" })).toBeVisible();
    await expect(launcher.locator(".fl-group-title").filter({ hasText: "Projects" })).toBeVisible();
    await expect(launcher.locator(".fl-group-title").filter({ hasText: "Collections" })).toBeVisible();
    await expect(launcher.getByTestId("launcher-item").filter({ hasText: "Ask Faber" })).toBeVisible();
    await expect(launcher.getByTestId("launcher-actions")).toContainText("Open in new tab");
    await page.screenshot({ path: "e2e/.results/screenshots/launcher-app.png" });

    // Arrow keys move the selection; Esc clears, then closes.
    const items = launcher.getByTestId("launcher-item");
    await expect(items.first()).toHaveAttribute("aria-selected", "true");
    await input.press("ArrowDown");
    await expect(items.nth(1)).toHaveAttribute("aria-selected", "true");
    await input.press("Escape");
    await expect(input).toHaveValue("");
    await input.press("Escape");
    await expect(launcher).toHaveCount(0);
  });

  test("browse a project inside the launcher, then show it in the app", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest")).toBeVisible(); // the app is mounted and listening
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("launcher-mode-projects").click();
    const input = page.getByTestId("launcher-input");
    await input.fill("bedr");
    await expect(page.getByTestId("launcher-item")).toHaveCount(1);
    await input.press("Enter"); // browse into it
    await expect(page.getByTestId("launcher-back")).toContainText("Bedrock");
    await expect(page.getByTestId("launcher-item").first()).toBeVisible();
    await input.press("Escape"); // back to the list, with the filter as it was
    await expect(page.getByTestId("launcher-back")).toHaveCount(0);
    await expect(input).toHaveValue("bedr");
    await input.press("ControlOrMeta+o"); // show in the app
    await expect(page).toHaveURL(/#\/projects\/bedrock$/);
    await expect(page.getByTestId("launcher")).toHaveCount(0);
  });

  test("Ask from the launcher answers with citations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest")).toBeVisible(); // the app is mounted and listening
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByTestId("launcher-input");
    await input.fill("What blocked the Frankfurt launch?");
    await page.getByTestId("launcher-item").filter({ hasText: "Ask Faber" }).click();
    await expect(page.getByTestId("launcher-mode-ask")).toHaveClass(/is-active/);
    await expect(page.getByTestId("launcher-answer")).toBeVisible();
    await expect(page.getByTestId("launcher-item").first()).toContainText("[1]");
  });

  test("Tab cycles sections and Option+letter jumps to one", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest")).toBeVisible(); // the app is mounted and listening
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByTestId("launcher-input");
    await input.press("Tab");
    await expect(page.getByTestId("launcher-mode-recent")).toHaveClass(/is-active/);
    await input.press("Shift+Tab");
    await expect(page.getByTestId("launcher-mode-search")).toHaveClass(/is-active/);
    await input.press("Alt+KeyP");
    await expect(page.getByTestId("launcher-mode-pinned")).toHaveClass(/is-active/);
    await expect(page.getByTestId("launcher-item").first()).toContainText(RATE_LIMIT);
  });
});

test("Ask can be scoped to a project", async ({ page }) => {
  await page.goto("/#/projects/frankfurt");
  await page.getByTestId("project-ask").click();
  await expect(page.getByTestId("ask-scope-select")).toHaveValue("frankfurt");
  const req = page.waitForRequest((r) => r.url().endsWith("/api/ask"));
  await page.getByTestId("ask-input").fill("What blocked the launch?");
  await page.getByTestId("ask-input").press("Enter");
  expect(JSON.parse((await req).postData() ?? "{}").filters).toEqual({ project: ["frankfurt"] });
  await expect(page.getByTestId("ask-answer")).toBeVisible();
});

test("the Ask scope picker switches between all documents and a project", async ({ page }) => {
  await page.goto("/#/ask");
  await page.getByTestId("ask-scope-select").selectOption({ label: "Bedrock" });
  await expect(page).toHaveURL(/#\/ask\?project=bedrock$/);
  await page.getByTestId("ask-scope-select").selectOption({ value: "" });
  await expect(page).toHaveURL(/#\/ask$/);
});
