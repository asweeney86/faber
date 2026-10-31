/**
 * Upgrades must never lose data or strand an older version. Every release adds a
 * snapshot of a real database it wrote (test/fixtures/v<version>.sqlite.gz, made with
 * `bun scripts/fixture.ts`); these tests open each one with the current code.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseTooNewError, KEEP_BACKUPS, MIN_READER_VERSION, openDatabase, SCHEMA_VERSION } from "../src/db";
import { isExtensionApproved } from "../src/extensions";
import { listCollections } from "../src/collections";
import { listProjects } from "../src/projects";
import { listViews } from "../src/views";
import { search } from "../src/search/hybrid";
import { VectorIndex } from "../src/search/vectors";
import { FakeEmbedder } from "../src/providers/fake";

const fixtures = join(import.meta.dir, "fixtures");
const versions = readdirSync(fixtures)
  .filter((f) => /^v\d+\.\d+\.\d+\.sqlite\.gz$/.test(f))
  .map((f) => f.slice(1, -".sqlite.gz".length));

/** Restore a fixture dump into a fresh home; returns the database path. */
function restore(version: string): string {
  const home = mkdtempSync(join(tmpdir(), `faber-upgrade-${version}-`));
  const path = join(home, "faber.sqlite");
  writeFileSync(path, Bun.gunzipSync(readFileSync(join(fixtures, `v${version}.sqlite.gz`))));
  return path;
}

const count = (db: Database, table: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
const meta = (db: Database, key: string) => db.query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`).get(key)?.value;

test("there is a fixture for this release's schema", () => {
  // When SCHEMA_VERSION goes up, snapshot the previous release's database first (bun scripts/fixture.ts).
  expect(versions.length).toBeGreaterThan(0);
  const schemas = versions.map((v) => {
    const db = new Database(restore(v));
    const s = Number(meta(db, "schema_version"));
    db.close();
    return s;
  });
  expect(Math.max(...schemas)).toBeLessThanOrEqual(SCHEMA_VERSION);
});

describe.each(versions)("upgrading a database from v%s", (version) => {
  test("keeps every document, enrichment, correction and setting", async () => {
    const path = restore(version);
    const before = new Database(path, { readonly: true });
    const tables = ["documents", "enrichments", "tags", "collections", "collection_docs", "chunks", "views", "project_rules", "settings", "visits"];
    const counts = Object.fromEntries(tables.map((t) => [t, count(before, t)]));
    const pinned = before.query<{ id: string; note: string }, []>(`SELECT id, note FROM documents WHERE pinned = 1`).all();
    before.close();
    expect(counts.documents).toBeGreaterThan(0);

    const db = openDatabase(path);
    for (const t of tables) expect(count(db, t)).toBe(counts[t]!);
    expect(db.query<{ id: string; note: string }, []>(`SELECT id, note FROM documents WHERE pinned = 1`).all()).toEqual(pinned);
    expect(Number(meta(db, "schema_version"))).toBe(SCHEMA_VERSION);

    // The upgraded data still works through the real code paths.
    expect(isExtensionApproved(db, "abcdefghijklmnopabcdefghijklmnop")).toBe(true);
    expect(listCollections(db).length).toBe(counts.collections);
    expect(listViews(db).some((v) => v.name === "Fixture board")).toBe(true);
    expect(listProjects(db).some((p) => p.name === "Renamed in fixture")).toBe(true);
    const embedder = new FakeEmbedder();
    const hits = await search({ db, index: VectorIndex.load(db, embedder.model), embedder }, { q: "gateway", mode: "hybrid" });
    expect(hits.hits.length).toBeGreaterThan(0);
    db.close();
  });

  test("saves a copy first when the schema changes, and only then", () => {
    const path = restore(version);
    const raw = new Database(path);
    const stored = Number(meta(raw, "schema_version"));
    raw.close();
    openDatabase(path).close();
    const dir = join(path, "..", "backups");
    if (stored < SCHEMA_VERSION) {
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const copy = new Database(join(dir, files[0]!), { readonly: true });
      expect(Number(meta(copy, "schema_version"))).toBe(stored);
      copy.close();
    } else {
      expect(existsSync(dir)).toBe(false);
    }
    // Opening an up-to-date database again never makes another copy.
    openDatabase(path).close();
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(stored < SCHEMA_VERSION ? 1 : 0);
  });
});

describe("rolling back to an older Faber", () => {
  function dbWith(schema: number, minReader?: number): string {
    const path = join(mkdtempSync(join(tmpdir(), "faber-rollback-")), "faber.sqlite");
    openDatabase(path).close();
    const db = new Database(path);
    db.run(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, [String(schema)]);
    if (minReader !== undefined) db.run(`UPDATE meta SET value = ? WHERE key = 'min_reader_version'`, [String(minReader)]);
    db.close();
    return path;
  }

  test("an additive newer schema still opens, and its version isn't lowered", () => {
    const path = dbWith(SCHEMA_VERSION + 3);
    const db = openDatabase(path);
    expect(Number(meta(db, "schema_version"))).toBe(SCHEMA_VERSION + 3);
    db.close();
    expect(existsSync(join(path, "..", "backups"))).toBe(false);
  });

  test("a database that needs a newer reader is refused with a way out, untouched", () => {
    const path = dbWith(SCHEMA_VERSION + 1, SCHEMA_VERSION + 1);
    expect(() => openDatabase(path)).toThrow(DatabaseTooNewError);
    expect(() => openDatabase(path)).toThrow(/brew upgrade faber.*backups/);
    const db = new Database(path, { readonly: true });
    expect(Number(meta(db, "min_reader_version"))).toBe(SCHEMA_VERSION + 1);
    db.close();
  });

  test("this build can always read what it writes", () => {
    expect(MIN_READER_VERSION).toBeLessThanOrEqual(SCHEMA_VERSION);
  });
});

describe("pre-upgrade backups", () => {
  test("keep only the newest few", async () => {
    const home = mkdtempSync(join(tmpdir(), "faber-backups-"));
    const path = join(home, "faber.sqlite");
    for (let i = 0; i < KEEP_BACKUPS + 2; i++) {
      openDatabase(path).close();
      const db = new Database(path);
      db.run(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`);
      db.close();
      await Bun.sleep(2); // distinct timestamps
    }
    openDatabase(path).close();
    expect(readdirSync(join(home, "backups"))).toHaveLength(KEEP_BACKUPS);
  });

  test("a failed migration leaves the old database as it was", () => {
    const path = join(mkdtempSync(join(tmpdir(), "faber-failmig-")), "faber.sqlite");
    const old = new Database(path);
    // A v1-era table whose shape the migration can't extend: 'documents' as a view.
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE docs_old (id TEXT);
      CREATE VIEW documents AS SELECT id FROM docs_old;`);
    old.close();
    expect(() => openDatabase(path)).toThrow();
    const db = new Database(path, { readonly: true });
    expect(meta(db, "schema_version")).toBe("1");
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'enrich_queue'`).get()).toBeNull();
    db.close();
  });
});

describe("several processes opening at once (the daemon restarting while a CLI command runs)", () => {
  const opener = join(import.meta.dir, "fixtures", "open-db.ts");

  async function openTogether(path: string, n: number): Promise<number[]> {
    const procs = Array.from({ length: n }, () => Bun.spawn(["bun", opener, path], { stdout: "ignore", stderr: "pipe" }));
    return Promise.all(procs.map((p) => p.exited));
  }

  test("an up-to-date database opens in all of them", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "faber-race-")), "faber.sqlite");
    openDatabase(path).close();
    expect(await openTogether(path, 8)).toEqual(Array(8).fill(0));
  });

  test("an upgrade happens once, with one backup, while the others wait", async () => {
    const path = restore(versions[0]!);
    const raw = new Database(path);
    raw.run(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`);
    raw.close();
    expect(await openTogether(path, 8)).toEqual(Array(8).fill(0));
    expect(readdirSync(join(path, "..", "backups"))).toHaveLength(1);
  });
});
