import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.FABER_E2E_PORT ?? 7788);
const daemon = `http://127.0.0.1:${port}`;
process.env.FABER_E2E_DAEMON = daemon;

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  use: {
    baseURL: daemon,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `FABER_E2E_PORT=${port} bun e2e/fixtures/serve.ts`,
    url: `${daemon}/api/status`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
  },
  projects: [
    { name: "web", testMatch: /web.*\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "extension", testMatch: /extension.*\.spec\.ts/ },
  ],
});
