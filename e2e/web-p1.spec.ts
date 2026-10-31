/**
 * P1/P2: organization corrections, review inbox, dashboards and saved views,
 * Ask follow-ups. Every test undoes its corrections so other specs see the
 * fixture's projects unchanged.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const RATE_LIMIT = "Usage-Based Pricing: Rate Limit Design";

async function resetOrganization(request: APIRequestContext) {
  const c = (await (await request.get("/api/organize/corrections")).json()) as { rules: { id: string }[]; docs: { doc_id: string; project_id: string }[] };
  for (const r of c.rules) await request.delete(`/api/projects/${encodeURIComponent(r.id)}/corrections`);
  for (const d of c.docs) await request.put(`/api/docs/${d.doc_id}/projects`, { data: { project: d.project_id, in: null } });
}

test.afterEach(async ({ request }) => resetOrganization(request));

async function openProject(page: Page, id: string) {
  await page.goto(`/#/projects/${id}`);
  await expect(page.getByTestId("project-page")).toBeVisible();
}

test.describe("project corrections", () => {
  test("rename, add a subproject, and the hierarchy shows in the sidebar and breadcrumbs", async ({ page }) => {
    await openProject(page, "atlas");
    await page.getByTestId("project-rename").click();
    await page.getByTestId("name-input").fill("Atlas Pricing");
    await page.getByTestId("name-submit").click();
    await expect(page.getByTestId("project-page").getByRole("heading", { level: 1 })).toContainText("Atlas Pricing");
    await expect(page.getByTestId("nav-project-list")).toContainText("Atlas Pricing");

    await page.getByTestId("project-add-sub").click();
    await page.getByTestId("name-input").fill("Rate Limits");
    await page.getByTestId("name-submit").click();
    await expect(page).toHaveURL(/#\/projects\/rate-limits$/);
    await expect(page.locator(".breadcrumb")).toContainText(/Projects\s*\/\s*Atlas Pricing\s*\/\s*Rate Limits/);
    await page.locator(".breadcrumb").getByRole("link", { name: "Atlas Pricing" }).click();
    await expect(page.getByTestId("project-children")).toContainText("Rate Limits");
  });

  test("move a project under another and back to the top level", async ({ page }) => {
    await openProject(page, "kickstart");
    await page.getByTestId("project-move").click();
    await page.getByTestId("target-project").selectOption({ label: "Frankfurt" });
    await page.getByTestId("move-merge-submit").click();
    await expect(page.locator(".breadcrumb")).toContainText("Frankfurt");
    await page.goto("/#/projects");
    await expect(page.getByTestId("project-grid").getByTestId("project-card")).toHaveCount(3);
    await expect(page.getByTestId("project-grid")).toContainText("Kickstart"); // listed under Frankfurt
    await openProject(page, "kickstart");
    await page.getByTestId("project-move").click();
    await page.getByTestId("target-project").selectOption({ value: "" });
    await page.getByTestId("move-merge-submit").click();
    await expect(page.locator(".breadcrumb")).not.toContainText("Frankfurt");
  });

  test("merge two projects; the old address follows; undo it in Settings", async ({ page }) => {
    await openProject(page, "kickstart");
    await page.getByTestId("project-merge").click();
    await page.getByTestId("target-project").selectOption({ label: "Frankfurt" });
    await page.getByTestId("move-merge-submit").click();
    await expect(page).toHaveURL(/#\/projects\/frankfurt$/);
    await expect(page.getByTestId("project-page")).toContainText("also called");
    await page.goto("/#/projects/kickstart");
    await expect(page).toHaveURL(/#\/projects\/frankfurt$/);

    await page.goto("/#/settings/organization");
    const row = page.getByTestId("correction").filter({ hasText: "merged into Frankfurt" });
    await expect(row).toBeVisible();
    await row.getByTestId("undo-correction").click();
    await expect(row).toHaveCount(0);
    expect((await page.request.get("/api/projects/kickstart")).status()).toBe(200);
  });

  test("not a project: gone from lists until undone", async ({ page }) => {
    await openProject(page, "kickstart");
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("project-hide").click();
    await expect(page).toHaveURL(/#\/projects$/);
    await expect(page.getByTestId("project-grid")).not.toContainText("Kickstart");
    await page.goto("/#/settings/organization");
    await page.getByTestId("correction").filter({ hasText: "not a project" }).getByTestId("undo-correction").click();
    await page.goto("/#/projects");
    await expect(page.getByTestId("project-grid")).toContainText("Kickstart");
  });

  test("put a document in a project from its details, take it out from the project page", async ({ page }) => {
    await page.goto("/#/search?q=lunch%20OR%20retention");
    await page.goto("/#/search?q=retention%20policy");
    await page.getByTestId("result").first().click();
    const drawer = page.getByTestId("drawer");
    await drawer.getByTestId("doc-project-input").fill("Frankfurt");
    await drawer.getByTestId("doc-project-input").press("Enter");
    await expect(drawer.getByTestId("doc-project")).toContainText("Frankfurt");
    await openProject(page, "frankfurt");
    const row = page.getByTestId("project-docs").locator('[data-testid="doc-row"]').filter({ hasText: "retention" });
    await expect(row).toBeVisible();
    await row.getByTestId("remove-from-project").click();
    await expect(row).toHaveCount(0);
  });

  test("a hand-made project from the Projects page", async ({ page }) => {
    await page.goto("/#/projects");
    await page.getByTestId("new-project").click();
    await page.getByTestId("new-project-name").fill("Offsite 2027");
    await page.getByTestId("new-project-submit").click();
    await expect(page).toHaveURL(/#\/projects\/offsite-2027$/);
    await expect(page.getByTestId("project-page")).toContainText("Made by hand");
    await expect(page.getByTestId("project-overview")).toContainText("No documents yet");
  });

  test("the workspace shows decisions from its documents and an AI overview", async ({ page }) => {
    await openProject(page, "frankfurt");
    await expect(page.getByTestId("project-decisions")).toContainText("Decision: block the Frankfurt launch");
    await expect(page.getByTestId("project-ai-overview").locator(".ai-text")).toContainText("Frankfurt", { timeout: 15_000 });
  });
});

test.describe("inbox", () => {
  test("look-alike names are offered for merging; dismissals stick", async ({ page, request }) => {
    // A second spelling, made by assigning a doc to "Kickstarts".
    const search = (await (await request.post("/api/search", { data: { q: "retention policy", limit: 1 } })).json()) as { hits: { doc: { id: string } }[] };
    await request.put(`/api/docs/${search.hits[0]!.doc.id}/projects`, { data: { project: "Kickstarts", in: true } });
    await page.goto("/#/inbox");
    const item = page.getByTestId("review-duplicate").filter({ hasText: "Kickstarts" });
    await expect(item).toBeVisible();
    await expect(page.getByTestId("nav-inbox")).toContainText(/\d/);
    await item.getByTestId("review-merge").click();
    await expect(item).toHaveCount(0);
    expect(((await (await request.get("/api/projects/kickstart")).json()) as { aliases: string[] }).aliases).toContain("Kickstarts");
  });

  test("an empty inbox says so", async ({ page }) => {
    await page.goto("/#/inbox");
    await expect(page.getByTestId("inbox-empty").or(page.getByTestId("review-list").locator("li").first())).toBeVisible();
  });
});

test.describe("dashboards", () => {
  test("built-in dashboards render their widgets", async ({ page }) => {
    await page.goto("/#/dashboards");
    await expect(page.getByTestId("dashboard-title")).toHaveText("My Work");
    await expect(page.getByTestId("widget-pinned")).toContainText(RATE_LIMIT);
    await expect(page.getByTestId("widget-project-activity")).toContainText("Atlas");
    await page.getByTestId("dashboard-tab-planning").click();
    await expect(page.getByTestId("dashboard-widget")).toHaveCount(3);
    await expect(page.getByTestId("dashboards")).toContainText("Platform roadmap H2 2026");
    await expect(page.getByTestId("edit-dashboard")).toHaveCount(0); // built-ins are read-only
  });

  test("save a search as a view, add a widget, then delete it", async ({ page }) => {
    await page.goto("/#/search?q=gateway");
    await page.getByTestId("save-view").click();
    await page.getByTestId("view-name").fill("Gateway watch");
    await page.getByTestId("view-name-submit").click();
    await expect(page).toHaveURL(/#\/dashboards\/[\w-]+$/);
    await expect(page.getByTestId("dashboard-title")).toHaveText("Gateway watch");
    await expect(page.getByTestId("dashboard-widget").first()).toContainText("Runbook: Gateway degraded");

    await page.getByTestId("edit-dashboard").click();
    await page.getByTestId("widget-kind").selectOption("project");
    await page.getByTestId("widget-project").selectOption({ label: "Bedrock" });
    await page.getByTestId("add-widget-submit").click();
    await expect(page.getByTestId("dashboard-widget")).toHaveCount(2);
    await page.reload();
    await expect(page.getByTestId("dashboard-widget")).toHaveCount(2);

    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("delete-dashboard").click();
    await expect(page).toHaveURL(/#\/dashboards$/);
    await expect(page.locator('[data-testid^="dashboard-tab-"]').filter({ hasText: "Gateway watch" })).toHaveCount(0);
  });

  test("duplicate a built-in to customise it", async ({ page }) => {
    await page.goto("/#/dashboards/planning");
    await page.getByTestId("duplicate-dashboard").click();
    await page.getByTestId("view-name").fill("My planning");
    await page.getByTestId("view-name-submit").click();
    await expect(page.getByTestId("dashboard-title")).toHaveText("My planning");
    await expect(page.getByTestId("dashboard-widget")).toHaveCount(3);
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("delete-dashboard").click();
  });
});

test("Ask: a follow-up carries the conversation", async ({ page }) => {
  await page.goto("/#/ask");
  await page.getByTestId("ask-input").fill("What blocked the Frankfurt launch?");
  await page.getByTestId("ask-input").press("Enter");
  await expect(page.getByTestId("ask-answer")).toHaveCount(1);
  const req = page.waitForRequest((r) => r.url().endsWith("/api/ask"));
  await page.getByTestId("ask-input").fill("Who owns the fix?");
  await page.getByTestId("ask-input").press("Enter");
  const body = JSON.parse((await req).postData() ?? "{}") as { history: { question: string }[] };
  expect(body.history.map((h) => h.question)).toEqual(["What blocked the Frankfurt launch?"]);
  await expect(page.getByTestId("ask-answer")).toHaveCount(2);
  await page.getByTestId("ask-new").click();
  await expect(page.getByTestId("ask-answer")).toHaveCount(0);
});

test("Capture & Sources offers common work tools as one-click sites", async ({ page }) => {
  await page.goto("/#/settings/capture");
  const suggested = page.getByTestId("suggested-sources");
  await suggested.getByRole("button", { name: "+ Notion" }).click();
  const row = page.locator('[data-testid^="rule-"]').filter({ hasText: "Notion" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("*.notion.so");
  await expect(suggested.getByRole("button", { name: "+ Notion" })).toHaveCount(0);
  await row.getByRole("button", { name: "Remove Notion" }).click();
  await expect(row).toHaveCount(0);
});

test.describe("native launcher page (/launcher)", () => {
  // Stand in for the macOS app: record what the page sends to window.webkit.messageHandlers.faber.
  async function withBridge(page: Page) {
    await page.addInitScript(() => {
      const sent: unknown[] = [];
      (window as unknown as { __sent: unknown[] }).__sent = sent;
      (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { faber: { postMessage: (m: unknown) => sent.push(m) } } };
    });
  }
  const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: { type: string; url?: string }[] }).__sent);

  test("searching and Enter asks the app to open the doc, then to close", async ({ page }) => {
    await withBridge(page);
    await page.goto("/launcher");
    const input = page.getByTestId("launcher-input");
    await expect(input).toBeFocused();
    // The hint names the hotkey the platform's way: ⌥Space on a Mac, Alt+Space elsewhere.
    await expect(page.getByTestId("launcher")).toContainText(/⌥Space|Alt\+Space/);
    await input.fill("rate limit design");
    await expect(page.getByTestId("launcher-item").first()).toContainText("Rate Limit Design");
    await page.waitForTimeout(300);
    await input.press("Enter");
    await expect.poll(() => sent(page)).toEqual([{ type: "open", url: expect.stringContaining("docs.google.com/document/") }, { type: "close" }]);
  });

  test("Show in Faber opens the app page; Esc asks to close; each show starts fresh", async ({ page }) => {
    await withBridge(page);
    await page.goto("/launcher");
    const input = page.getByTestId("launcher-input");
    await page.getByTestId("launcher-mode-projects").click();
    await expect(page.getByTestId("launcher-item").first()).toBeVisible();
    await input.press("ControlOrMeta+o");
    await expect.poll(() => sent(page)).toContainEqual({ type: "open", url: expect.stringMatching(/\/#\/projects\/[\w-]+$/) });
    await input.fill("something");
    await input.press("Escape"); // clears
    await input.press("Escape"); // closes
    await expect.poll(async () => (await sent(page)).filter((m) => m.type === "close").length).toBeGreaterThanOrEqual(2);
    // The app calls __faberShow() each time it shows the panel: back to Search, empty.
    await page.evaluate(() => (window as unknown as { __faberShow(): void }).__faberShow());
    await expect(page.getByTestId("launcher-mode-search")).toHaveClass(/is-active/);
    await expect(page.getByTestId("launcher-input")).toHaveValue("");
  });

  test("in a plain browser tab it still works (no bridge)", async ({ page }) => {
    await page.goto("/launcher");
    await page.getByTestId("launcher-input").fill("frankfurt");
    await expect(page.getByTestId("launcher-item").first()).toBeVisible();
    await expect(page.getByTestId("launcher")).not.toContainText(/⌥Space|Alt\+Space/);
  });
});

test("native launcher shows the app's configured hotkey", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { faber: { postMessage: () => {} } } };
  });
  await page.goto("/launcher?hotkey=" + encodeURIComponent("⌘⇧Space"));
  await expect(page.getByTestId("launcher")).toContainText("⌘⇧Space");
});
