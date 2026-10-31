#!/usr/bin/env bun
/**
 * Snapshot a database written by this version into packages/core/test/fixtures/v<version>.sqlite.gz.
 * Run it once per release (scripts/release.ts checks it exists); the upgrade tests then
 * open every snapshot with newer code, so no release can break data an older one wrote.
 *
 *   bun scripts/fixture.ts            write the fixture for the version in package.json
 *   bun scripts/fixture.ts --force    overwrite an existing one
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveExtension, createView, defaultConfig, listProjects } from "../packages/core/src/index";
import { AppContext } from "../packages/daemon/src/context";
import { seedDemo } from "../packages/daemon/src/demo";

const root = join(import.meta.dir, "..");
const version = ((await Bun.file(join(root, "package.json")).json()) as { version: string }).version;
const target = join(root, "packages/core/test/fixtures", `v${version}.sqlite.gz`);

if (existsSync(target) && !process.argv.includes("--force")) {
  console.log(`${target} already exists (use --force to replace it)`);
  process.exit(0);
}

const home = mkdtempSync(join(tmpdir(), "faber-fixture-"));
try {
  const cfg = defaultConfig(home);
  cfg.embed = { provider: "fake", model: "fake-embed" };
  cfg.enrich = { provider: "fake", model: "fake-enrich" };
  const ctx = new AppContext(cfg);
  await seedDemo(ctx, { log: () => {} });
  const db = ctx.db;
  // The kinds of things people do by hand, which an upgrade must keep.
  approveExtension(db, "abcdefghijklmnopabcdefghijklmnop");
  db.run(`UPDATE documents SET pinned = 1, note = 'Fixture note: keep me' WHERE title LIKE 'Runbook%'`);
  createView(db, { name: "Fixture board", spec: { widgets: [{ kind: "recent", title: "Recent", limit: 5 }] } });
  const project = listProjects(db)[0];
  if (!project) throw new Error("the demo produced no projects");
  db.run(`INSERT INTO project_rules (key, name, confirmed, updated_at) VALUES (?, 'Renamed in fixture', 1, 1)`, [project.id]);
  const snap = join(home, "snapshot.sqlite");
  db.run(`VACUUM INTO ?`, [snap]);
  db.close();
  writeFileSync(target, Bun.gzipSync(new Uint8Array(readFileSync(snap)), { level: 9 }));
  console.log(`Wrote ${target}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}

