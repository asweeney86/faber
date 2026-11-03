/**
 * Start a daemon for end-to-end tests: fresh FABER_HOME in a temp dir, offline
 * "fake" providers, demo data seeded. Playwright's webServer runs this.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.FABER_E2E_PORT ?? 7788);
// One fixed, gitignored home per port, wiped at startup: nothing piles up in the temp dir
// even when Playwright kills this process without a chance to clean up.
const home = join(import.meta.dir, "..", ".tmp", String(port));
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
process.env.FABER_HOME = home;
writeFileSync(
  join(home, "config.toml"),
  `[daemon]
port = ${port}

[embed]
provider = "fake"
model = "fake-embed"

[enrich]
provider = "fake"
model = "fake-enrich"

[privacy]
# Tests never reach the internet; they stub site icons where they need them.
favicons = ${process.env.FABER_E2E_FAVICONS === "1" ? "true" : "false"}
`,
);

const { AppContext } = await import("../../packages/daemon/src/context");
const { startServer } = await import("../../packages/daemon/src/server");
const { seedDemo } = await import("../../packages/daemon/src/demo");

const { saveSettings } = await import("../../packages/core/src/settings");
const { DEFAULT_APPEARANCE } = await import("../../packages/shared/src/theme");

const ctx = new AppContext();
await seedDemo(ctx);
// "System" appearance, so screenshots can flip Latte/Mocha with emulateMedia.
saveSettings(ctx.db, { appearance: { ...DEFAULT_APPEARANCE, theme: "system" } });
const server = startServer(ctx, { log: () => {} });
console.log(`e2e daemon on http://${server.hostname}:${server.port} (FABER_HOME=${home})`);
