import { Database } from "bun:sqlite";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

/**
 * The schema this build writes. Upgrade rules (see CONTRIBUTING.md, "Upgrades"):
 * changes are additive (new tables, nullable or defaulted columns), so a database
 * migrated by a newer Faber still opens in an older one. A change an older build
 * can't live with must raise MIN_READER_VERSION to the new SCHEMA_VERSION.
 */
export const SCHEMA_VERSION = 4;
/** The oldest schema an app must understand to use a database this build wrote. */
export const MIN_READER_VERSION = 1;
/** How many pre-upgrade backups to keep in <home>/backups. */
export const KEEP_BACKUPS = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  source             TEXT NOT NULL,
  canonical_url      TEXT NOT NULL UNIQUE,
  external_id        TEXT,
  google_authuser    INTEGER,
  fts_rowid          INTEGER,
  title              TEXT NOT NULL DEFAULT '',
  content            TEXT,
  content_hash       TEXT,
  content_fetched_at INTEGER,
  content_error      TEXT,
  content_attempts   INTEGER NOT NULL DEFAULT 0,
  meta               TEXT,
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  visit_count        INTEGER NOT NULL DEFAULT 0,
  pinned             INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_last_seen ON documents(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS documents_external ON documents(external_id);

CREATE TABLE IF NOT EXISTS visits (
  id       INTEGER PRIMARY KEY,
  doc_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ts       INTEGER NOT NULL,
  referrer TEXT,
  dwell_ms INTEGER,
  origin   TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS visits_doc ON visits(doc_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS visits_dedupe ON visits(doc_id, ts, origin);

CREATE TABLE IF NOT EXISTS enrichments (
  id             INTEGER PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  content_hash   TEXT,
  summary        TEXT NOT NULL,
  doc_type       TEXT NOT NULL,
  written_at     TEXT,
  projects       TEXT NOT NULL,
  people         TEXT NOT NULL,
  teams          TEXT NOT NULL,
  tags           TEXT NOT NULL,
  confidence     REAL NOT NULL,
  raw            TEXT,
  is_current     INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS enrichments_doc ON enrichments(doc_id, is_current);

CREATE TABLE IF NOT EXISTS tags (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  source     TEXT NOT NULL,
  confidence REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_people (
  doc_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role      TEXT NOT NULL,
  PRIMARY KEY (doc_id, person_id, role)
);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  query       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_docs (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  state         TEXT NOT NULL,
  shared_note   TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (collection_id, doc_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A meeting is a recurring calendar series, keyed by its normalised title.
CREATE TABLE IF NOT EXISTS meetings (
  id           TEXT PRIMARY KEY,
  series_key   TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  url          TEXT,
  last_seen_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_meetings (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  linked_at  INTEGER NOT NULL,
  PRIMARY KEY (doc_id, meeting_id)
);
CREATE INDEX IF NOT EXISTS doc_meetings_meeting ON doc_meetings(meeting_id);
CREATE INDEX IF NOT EXISTS doc_people_person ON doc_people(person_id);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ix          INTEGER NOT NULL,
  text        TEXT NOT NULL,
  embedding   BLOB,
  embed_model TEXT,
  UNIQUE (doc_id, ix)
);

CREATE TABLE IF NOT EXISTS enrich_queue (
  doc_id          TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  priority        REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  -- Failed jobs wait until this time before being retried.
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  -- content_hash of the document when the running job was claimed.
  claimed_hash    TEXT,
  -- 1 when the user asked to re-enrich: skip the "same content, same model" shortcut.
  force           INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS enrich_queue_status ON enrich_queue(status, priority DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  doc_id UNINDEXED,
  title,
  summary,
  note,
  tags,
  people,
  projects,
  content,
  tokenize = 'porter unicode61'
);

-- Organization corrections (PRD P1). Projects are inferred from enrichment; these
-- rows are the user's corrections on top, keyed by the project's grouping key, and
-- always win over inference.
CREATE TABLE IF NOT EXISTS project_rules (
  key         TEXT PRIMARY KEY,
  name        TEXT,                        -- display-name override
  merge_into  TEXT,                        -- key of the project this one is part of
  parent      TEXT,                        -- NULL = infer, '' = top level, else a key
  hidden      INTEGER NOT NULL DEFAULT 0,  -- "not a project"
  manual      INTEGER NOT NULL DEFAULT 0,  -- created by hand (exists without docs)
  confirmed   INTEGER NOT NULL DEFAULT 0,  -- reviewed: no longer in the Inbox
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_projects (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('add', 'remove')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, key)
);
CREATE TABLE IF NOT EXISTS review_dismissed (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_summaries (
  key        TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  summary    TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Saved views / custom dashboards (PRD P2).
CREATE TABLE IF NOT EXISTS views (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  spec       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface OpenOptions {
  /** Where pre-upgrade backups go; defaults to "backups" next to the database. */
  backupDir?: string;
}

/** The database was last written by a Faber too new for this one to use safely. */
export class DatabaseTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly needs: number,
  ) {
    super(
      `${path} was upgraded by a newer version of Faber (it needs schema ${needs}; this version knows ${SCHEMA_VERSION}). ` +
        `Update Faber (brew upgrade faber), or restore the copy saved before that upgrade from ${join(dirname(path), "backups")}.`,
    );
  }
}

function readMeta(db: Database, key: string): number | null {
  const hasMeta = db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
  if (!hasMeta) return null;
  const row = db.query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`).get(key);
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) ? n : null;
}

/** Whether the file holds any of our tables (an empty file is a fresh database, not an upgrade). */
function hasData(db: Database): boolean {
  return !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'`).get();
}

/**
 * Copy the database aside before migrating it, so an upgrade can always be undone.
 * Called inside the migration's write lock: the copy is exactly what the old version
 * left, and no other process can change it (or back it up again) meanwhile.
 */
export function backupDatabase(db: Database, dbPath: string, dir: string, label: string): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const unique = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const target = join(dir, `${basename(dbPath).replace(/\.sqlite$/, "")}-${stamp}-${label}-${unique}.sqlite`);
  writeFileSync(target, new Uint8Array(db.serialize()), { flag: "wx" });
  const old = readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .sort()
    .reverse()
    .slice(KEEP_BACKUPS);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return target;
}

function withBusyRetry(fn: () => void, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      const busy = err instanceof Error && /SQLITE_BUSY|database is locked/.test(`${(err as { code?: string }).code} ${err.message}`);
      if (!busy || Date.now() > until) throw err;
      Bun.sleepSync(20 + Math.random() * 30);
    }
  }
}

export function openDatabase(path: string, opts: OpenOptions = {}): Database {
  const file = path !== ":memory:";
  if (file) mkdirSync(dirname(path), { recursive: true });
  const existed = file && existsSync(path);
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    // Switching a database to WAL can report "locked" without waiting for the busy timeout,
    // when another process is opening it at the same moment; retry for a while.
    withBusyRetry(() => db.exec("PRAGMA journal_mode = WAL"));
    db.exec("PRAGMA foreign_keys = ON");
    // Take the write lock before looking: when the daemon and a CLI command start together,
    // one migrates (and backs up) while the other waits, then sees the finished result.
    withBusyRetry(() => db.exec("BEGIN IMMEDIATE"));
    try {
      const stored = readMeta(db, "schema_version");
      const needs = readMeta(db, "min_reader_version") ?? 1;
      if (needs > SCHEMA_VERSION) throw new DatabaseTooNewError(path, needs);
      const upgrading = existed && hasData(db) && (stored === null || stored < SCHEMA_VERSION);
      if (upgrading) {
        const saved = backupDatabase(db, path, opts.backupDir ?? join(dirname(path), "backups"), `schema${stored ?? 0}`);
        console.error(`Upgrading your Faber database to schema ${SCHEMA_VERSION}; saved a copy first: ${saved}`);
      }
      // All or nothing: a failed migration leaves the database as the previous version left it.
      db.exec(SCHEMA);
      migrate(db, stored);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/**
 * Bring databases created by older versions up to SCHEMA_VERSION. New tables come
 * from CREATE IF NOT EXISTS above; columns are added when missing, so this is
 * idempotent and safe even when the stored version is wrong or absent.
 */
function migrate(db: Database, stored: number | null) {
  const addColumn = (table: string, column: string, type: string) => {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn("collection_docs", "shared_note", "TEXT");
  addColumn("documents", "google_authuser", "INTEGER");
  addColumn("enrich_queue", "next_attempt_at", "INTEGER NOT NULL DEFAULT 0");
  addColumn("enrich_queue", "claimed_hash", "TEXT");
  addColumn("enrich_queue", "force", "INTEGER NOT NULL DEFAULT 0");
  if (!hasColumn(db, "documents", "fts_rowid")) {
    db.exec("ALTER TABLE documents ADD COLUMN fts_rowid INTEGER");
    rebuildFts(db);
  }
  db.exec("CREATE INDEX IF NOT EXISTS documents_fts_rowid ON documents(fts_rowid)");
  // Older versions queued docs before their text arrived; those jobs could never run and showed as pending forever.
  db.exec(`DELETE FROM enrich_queue WHERE status = 'pending' AND doc_id IN (SELECT id FROM documents WHERE content IS NULL)`);
  const setMeta = (key: string, value: number) =>
    db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
  // Never lower these: an older Faber opening a newer database must not hide what the newer one added.
  setMeta("schema_version", Math.max(stored ?? 0, SCHEMA_VERSION));
  setMeta("min_reader_version", Math.max(readMeta(db, "min_reader_version") ?? 1, MIN_READER_VERSION));
}

/** Recreate the full-text index from documents, recording each row's FTS rowid. */
export function rebuildFts(db: Database) {
  db.transaction(() => {
    db.exec("DELETE FROM docs_fts");
    db.exec(`INSERT INTO docs_fts (rowid, doc_id, title, summary, note, tags, people, projects, content)
      SELECT d.rowid, d.id, d.title, COALESCE(e.summary, ''), COALESCE(d.note, ''),
        COALESCE((SELECT group_concat(t.tag, ' ') FROM tags t WHERE t.doc_id = d.id), ''),
        COALESCE((SELECT group_concat(j.value, ' ') FROM json_each(e.people) j), ''),
        COALESCE((SELECT group_concat(j.value, ' ') FROM json_each(e.projects) j), '') || ' ' ||
          COALESCE((SELECT group_concat(j.value, ' ') FROM json_each(e.teams) j), ''),
        substr(COALESCE(d.content, ''), 1, 200000)
      FROM documents d LEFT JOIN enrichments e ON e.doc_id = d.id AND e.is_current = 1`);
    db.exec("UPDATE documents SET fts_rowid = rowid");
  })();
}

export const now = () => Date.now();

export function newId(): string {
  return crypto.randomUUID();
}
