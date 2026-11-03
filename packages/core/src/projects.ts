import type { Database } from "bun:sqlite";
import type { ActivityItem, DocType, Overview, ProjectDecision, ProjectDetail, ProjectSummary, ProjectSummaryText } from "@faber/shared";
import { now } from "./db";
import { docsInOrder, getDocs } from "./docs";

/**
 * Projects: inferred from what enrichment found in each document, then corrected
 * by the user.
 *
 * Inference groups every spelling of a name ("Pricing Platform", "pricing
 * platform", "Project Pricing Platform") under one id, a slug of the name.
 * Corrections live in project_rules (keyed by that id) and doc_projects, and
 * always win: renames, merges ("this is part of that"), parents (hierarchy),
 * "not a project", hand-made projects, and per-document add/remove. Because they
 * are stored separately, re-enrichment never undoes them.
 */

const DAY = 86_400_000;

/** Grouping key: case and spacing ignored, and a leading/trailing "project" too ("Project Atlas" = "Atlas"). */
export function projectKey(name: string): string {
  const k = name.toLowerCase().replace(/\s+/g, " ").trim();
  const stripped = k.replace(/^project[\s:-]+/, "").replace(/[\s-]+project$/, "").trim();
  return stripped || k;
}

/**
 * URL-safe id for a project name: letters, digits and dashes only. Case, spacing and
 * punctuation fold together ("Billing v2", "billing-v2"); "+" and "#" are spelled
 * out so "C++", "C#" and "C" stay apart. Names with no letters or digits get a
 * stable hash-based id.
 */
export function projectId(name: string): string {
  const key = projectKey(name).normalize("NFC");
  const slug = key
    .replace(/\+/g, " plus ")
    .replace(/#/g, " sharp ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (slug) return slug;
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return `project-${h.toString(36)}`;
}

interface Mention {
  doc_id: string;
  doc_type: DocType;
  last_seen_at: number;
  first_seen_at: number;
  visit_count: number;
}

export interface Rule {
  key: string;
  name: string | null;
  merge_into: string | null;
  parent: string | null;
  hidden: number;
  manual: number;
  confirmed: number;
}

export function loadRules(db: Database): Map<string, Rule> {
  return new Map(db.query<Rule, []>(`SELECT key, name, merge_into, parent, hidden, manual, confirmed FROM project_rules`).all().map((r) => [r.key, r]));
}

/** Follow merges to the project an id now belongs to (cycles stop where they loop). */
export function resolveId(rules: Map<string, Rule>, id: string): string {
  const seen = new Set<string>();
  let cur = id;
  while (!seen.has(cur)) {
    seen.add(cur);
    const next = rules.get(cur)?.merge_into;
    if (!next) break;
    cur = next;
  }
  return cur;
}

export interface Group {
  id: string;
  spellings: Map<string, number>;
  /** Documents directly in this project (not its subprojects). */
  docs: Map<string, Mention>;
  rule: Rule | undefined;
  parent: string | null;
  children: string[];
}

const DOC_FIELDS = `d.id AS doc_id, COALESCE(e.doc_type, 'other') AS doc_type, d.last_seen_at, d.first_seen_at, d.visit_count`;

/**
 * Moves on every write: total_changes() counts this connection's, data_version moves when
 * another connection (the CLI, another process) commits. Exact, and costs microseconds.
 */
function writeRevision(db: Database): string {
  const t = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  const v = db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
  return `${t}.${v}`;
}

const groupsCache = new WeakMap<Database, { rev: string; groups: Map<string, Group> }>();

/**
 * Every project (after corrections), keyed by id, with its parent and children.
 * Building this reads the whole library, and every search and doc list needs it (to label
 * docs with their projects), so it is cached until the next write. Callers must not
 * mutate the result.
 */
export function groups(db: Database): Map<string, Group> {
  const rev = writeRevision(db);
  const hit = groupsCache.get(db);
  if (hit?.rev === rev) return hit.groups;
  const built = buildGroups(db);
  groupsCache.set(db, { rev, groups: built });
  return built;
}

function buildGroups(db: Database): Map<string, Group> {
  const rules = loadRules(db);
  const out = new Map<string, Group>();
  const ensure = (id: string) => {
    let g = out.get(id);
    if (!g) out.set(id, (g = { id, spellings: new Map(), docs: new Map(), rule: rules.get(id), parent: null, children: [] }));
    return g;
  };
  const hidden = (id: string) => !!rules.get(id)?.hidden;

  // Per-document corrections. A removal is about the project it was made in (and
  // names merged into it), not everything that project later joins; an explicit
  // add always wins.
  const overrides = db
    .query<Mention & { key: string; state: "add" | "remove" }, []>(
      `SELECT o.key, o.state, ${DOC_FIELDS}
       FROM doc_projects o JOIN documents d ON d.id = o.doc_id
       LEFT JOIN enrichments e ON e.doc_id = d.id AND e.is_current = 1`,
    )
    .all();
  const removed = new Map<string, Set<string>>();
  for (const o of overrides) if (o.state === "remove") removed.set(o.doc_id, (removed.get(o.doc_id) ?? new Set()).add(o.key));
  /** Does this id, following merges, pass through any of these keys? */
  const passesThrough = (id: string, keys: Set<string>) => {
    const seen = new Set<string>();
    for (let cur: string | null = id; cur && !seen.has(cur); cur = rules.get(cur)?.merge_into ?? null) {
      if (keys.has(cur)) return true;
      seen.add(cur);
    }
    return false;
  };

  // 1. What enrichment found.
  const mentions = db
    .query<Mention & { name: string }, []>(
      `SELECT j.value AS name, ${DOC_FIELDS}
       FROM enrichments e, json_each(e.projects) j
       JOIN documents d ON d.id = e.doc_id
       WHERE e.is_current = 1 AND typeof(j.value) = 'text' AND trim(j.value) != ''`,
    )
    .all();
  for (const m of mentions) {
    const raw = projectId(m.name);
    const id = resolveId(rules, raw);
    if (hidden(id)) continue;
    const g = ensure(id);
    const name = m.name.trim(); // exact: shown as an alias
    // Spellings that arrived through a merge only name the project if it has none of its own.
    g.spellings.set(name, (g.spellings.get(name) ?? 0) + (raw === id ? 1 : 0.001));
    const rm = removed.get(m.doc_id);
    if (!rm || !passesThrough(raw, rm)) g.docs.set(m.doc_id, m);
  }

  // 2. Documents the user put in a project.
  for (const o of overrides) {
    if (o.state !== "add") continue;
    const id = resolveId(rules, o.key);
    if (!hidden(id)) ensure(id).docs.set(o.doc_id, o);
  }

  // A merged project's own name lives on as a spelling of the one it joined.
  for (const r of rules.values()) {
    if (r.merge_into && r.name) {
      const g = out.get(resolveId(rules, r.key));
      if (g && !g.spellings.has(r.name)) g.spellings.set(r.name, 0);
    }
  }

  // 3. Projects made by hand exist even before they have documents.
  for (const r of rules.values()) if (r.manual && !r.merge_into && !r.hidden) ensure(r.key);

  // Inferred projects that lost all their documents disappear.
  for (const [id, g] of out) if (g.docs.size === 0 && !g.rule?.manual) out.delete(id);

  // 4. Hierarchy: an explicit parent, or inferred from names ("bedrock gateway fleet" under "bedrock").
  // Compare grouping keys of real names (never hash ids of symbol-only names).
  const keys = new Map(
    [...out.values()]
      .map((g) => [g.id, projectKey(displayName(g))] as const)
      .filter(([, k]) => /\p{L}/u.test(k)),
  );
  for (const g of out.values()) {
    const explicit = g.rule?.parent;
    let parent: string | null = null;
    if (explicit === "") parent = null;
    else if (explicit) parent = resolveId(rules, explicit);
    else {
      const mine = keys.get(g.id);
      for (const [other, k] of mine ? keys : []) {
        if (other !== g.id && k.length >= 3 && mine!.startsWith(`${k} `) && (!parent || k.length > keys.get(parent)!.length)) parent = other;
      }
    }
    if (parent && out.has(parent) && parent !== g.id) g.parent = parent;
  }
  // Break any cycle the corrections could form.
  for (const g of out.values()) {
    const seen = new Set([g.id]);
    let p = g.parent;
    while (p) {
      if (seen.has(p)) {
        g.parent = null;
        break;
      }
      seen.add(p);
      p = out.get(p)?.parent ?? null;
    }
  }
  for (const g of out.values()) if (g.parent) out.get(g.parent)!.children.push(g.id);
  return out;
}

/** The user's name, else the most common spelling (ties: more capitals), else the id. */
export function displayName(g: Group): string {
  if (g.rule?.name) return g.rule.name;
  const caps = (s: string) => (s.match(/\p{Lu}/gu) ?? []).length;
  const best = [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || caps(b[0]) - caps(a[0]) || a[0].localeCompare(b[0]))[0]?.[0];
  return (best ?? g.id.replace(/-/g, " ")).replace(/\s+/g, " ");
}

/** A project's documents including its subprojects', newest first. */
export function rollupDocs(all: Map<string, Group>, g: Group): Mention[] {
  const seen = new Map<string, Mention>();
  const walk = (x: Group, depth: number) => {
    for (const [id, m] of x.docs) seen.set(id, m);
    if (depth < 10) for (const c of x.children) walk(all.get(c)!, depth + 1);
  };
  walk(g, 0);
  return [...seen.values()].sort((a, b) => b.last_seen_at - a.last_seen_at);
}

/** People per document, read once and shared by every project summary. */
function peopleByDoc(db: Database): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of db.query<{ doc_id: string; name: string }, []>(`SELECT dp.doc_id, p.name FROM doc_people dp JOIN people p ON p.id = dp.person_id`).all()) {
    const xs = out.get(r.doc_id);
    if (xs) xs.push(r.name);
    else out.set(r.doc_id, [r.name]);
  }
  return out;
}

function summarise(all: Map<string, Group>, g: Group, t: number, people: Map<string, string[]>): ProjectSummary {
  const docs = rollupDocs(all, g);
  const types = new Map<DocType, number>();
  for (const d of docs) types.set(d.doc_type, (types.get(d.doc_type) ?? 0) + 1);
  const last = docs.length ? Math.max(...docs.map((d) => d.last_seen_at)) : 0;
  const counts = new Map<string, number>();
  for (const d of docs) for (const name of new Set(people.get(d.doc_id) ?? [])) counts.set(name, (counts.get(name) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  const r = g.rule;
  return {
    id: g.id,
    name: displayName(g),
    doc_count: docs.length,
    last_seen_at: last,
    recent_doc_count: docs.filter((d) => d.last_seen_at >= t - 7 * DAY).length,
    new_doc_count: docs.filter((d) => d.first_seen_at >= t - 7 * DAY).length,
    active: last >= t - 14 * DAY,
    doc_types: [...types.entries()].sort((a, b) => b[1] - a[1]).map(([doc_type, count]) => ({ doc_type, count })),
    top_people: top.map(([name]) => name),
    parent_id: g.parent,
    child_count: g.children.length,
    manual: !!r?.manual,
    confirmed: !!r && (!!r.confirmed || !!r.manual || !!r.name || r.parent !== null),
  };
}

/** Every project: most recently active first, then largest. Flat; parent_id gives the tree. */
export function listProjects(db: Database, at = now()): ProjectSummary[] {
  return summariseAll(db, groups(db), at);
}

export function summariseAll(db: Database, all: Map<string, Group>, at: number): ProjectSummary[] {
  const people = peopleByDoc(db);
  return [...all.values()]
    .map((g) => summarise(all, g, at, people))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.last_seen_at - a.last_seen_at || b.doc_count - a.doc_count || a.name.localeCompare(b.name));
}

/** The project a name or id refers to now (after merges), or null. */
export function findProject(db: Database, nameOrId: string, all = groups(db)): Group | null {
  const rules = loadRules(db);
  for (const candidate of [nameOrId, projectId(nameOrId)]) {
    const g = all.get(resolveId(rules, candidate));
    if (g) return g;
  }
  const lower = nameOrId.trim().toLowerCase();
  return [...all.values()].find((g) => displayName(g).toLowerCase() === lower) ?? null;
}

/**
 * The documents a project filter means: the project's documents and its
 * subprojects', after corrections. Null when no such project exists.
 */
export function projectDocIds(db: Database, nameOrId: string, all = groups(db)): string[] | null {
  const g = findProject(db, nameOrId, all);
  if (g) return rollupDocs(all, g).map((d) => d.doc_id);
  // A project the user said isn't one matches nothing (not its raw spelling).
  const rules = loadRules(db);
  if (rules.get(resolveId(rules, projectId(nameOrId)))?.hidden || rules.get(resolveId(rules, nameOrId))?.hidden) return [];
  return null;
}

/** Every spelling enrichment used for the project a name (or id) belongs to; unknown names map to themselves. */
export function projectSpellings(db: Database, nameOrId: string): string[] {
  const g = findProject(db, nameOrId);
  return g && g.spellings.size ? [...g.spellings.keys()] : [nameOrId];
}

// ---------- decisions ----------

/** Phrases that record a decision being made (not "pending decision", not "Status: Approved"). */
const DECIDED = /\b(we decided|decided to|decided that|decision was|agreed to|agreed that|we will|going with|signed off on|chose to|resolved to)\b/i;
const NOT_A_DECISION = /^(status|owner|author|reviewers?|stakeholders?|dependencies|risks?|date)\s*:|\b(pending|still open|undecided|tbd|to be decided)\b/i;

/** Sentences that record a decision: "Decision: …" lines first, then "we agreed to …" and the like. */
export function extractDecisions(text: string, max = 3): string[] {
  const parts = text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 15 && s.length <= 400);
  const explicit = parts.filter((s) => /(^|\s)decisions?\s*:/i.test(s) && !/\b(pending|tbd)\b/i.test(s));
  const implied = parts.filter((s) => !explicit.includes(s) && DECIDED.test(s) && !NOT_A_DECISION.test(s) && !/\?$/.test(s));
  return [...explicit, ...implied].slice(0, max).map((s) => (s.length > 240 ? `${s.slice(0, 237)}…` : s));
}

function decisionsFor(db: Database, docIds: string[]): ProjectDecision[] {
  if (docIds.length === 0) return [];
  const rows = db
    .query<{ id: string; title: string; content: string | null; last_seen_at: number }, [string]>(
      `SELECT id, title, content, last_seen_at FROM documents WHERE id IN (SELECT value FROM json_each(?)) AND content IS NOT NULL`,
    )
    .all(JSON.stringify(docIds));
  const out: ProjectDecision[] = [];
  for (const r of rows.sort((a, b) => b.last_seen_at - a.last_seen_at)) {
    for (const text of extractDecisions(r.content!, 2)) out.push({ text, doc_id: r.id, doc_title: r.title, at: r.last_seen_at });
  }
  return out.slice(0, 10);
}

// ---------- AI summary (cached) ----------

/** Identifies what a summary was written from: changes when the docs or their enrichments do. */
/** The (up to) 24 newest enriched documents an overview is written from. */
export function summaryDocs(db: Database, all: Map<string, Group>, g: Group) {
  const ids = rollupDocs(all, g).map((d) => d.doc_id);
  return [...getDocs(db, ids).values()]
    .filter((d) => d.enrichment)
    .sort((a, b) => b.last_seen_at - a.last_seen_at)
    .slice(0, 24);
}

export function summaryInputHash(db: Database, docIds: string[], name = ""): string {
  const rows = db
    .query<{ doc_id: string; id: number }, [string]>(
      `SELECT doc_id, id FROM enrichments WHERE is_current = 1 AND doc_id IN (SELECT value FROM json_each(?)) ORDER BY doc_id`,
    )
    .all(JSON.stringify(docIds));
  return String(Bun.hash(`${name}\n${rows.map((r) => `${r.doc_id}:${r.id}`).join("|")}`));
}

function cachedSummary(db: Database, id: string, hash: string): ProjectSummaryText | null {
  const row = db
    .query<{ input_hash: string; summary: string; model: string; created_at: number }, [string]>(`SELECT input_hash, summary, model, created_at FROM project_summaries WHERE key = ?`)
    .get(id);
  return row ? { text: row.summary, model: row.model, created_at: row.created_at, stale: row.input_hash !== hash } : null;
}

// ---------- detail ----------

export function getProject(db: Database, id: string, at = now()): ProjectDetail | null {
  const all = groups(db);
  const g = findProject(db, id, all);
  if (!g) return null;
  const people = peopleByDoc(db);
  const summary = summarise(all, g, at, people);
  const mentions = rollupDocs(all, g);
  const ids = mentions.map((d) => d.doc_id);
  const docs = docsInOrder(db, ids);
  const idsJson = JSON.stringify(ids);

  const projectPeople = db
    .query<{ id: string; name: string; count: number }, [string]>(
      `SELECT p.id, p.name, COUNT(DISTINCT dp.doc_id) AS count FROM doc_people dp JOIN people p ON p.id = dp.person_id
       WHERE dp.doc_id IN (SELECT value FROM json_each(?)) GROUP BY p.id ORDER BY count DESC, p.name LIMIT 12`,
    )
    .all(idsJson);
  // Topics: the tags most shared across the project's documents.
  const topics = db
    .query<{ tag: string; count: number }, [string]>(
      `SELECT j.value AS tag, COUNT(DISTINCT e.doc_id) AS count FROM enrichments e, json_each(e.tags) j
       WHERE e.is_current = 1 AND e.doc_id IN (SELECT value FROM json_each(?)) GROUP BY j.value HAVING count >= 2 ORDER BY count DESC, tag LIMIT 10`,
    )
    .all(idsJson);
  const mine = new Set(ids);
  const family = new Set<string>([g.id, ...g.children]);
  const related = [...all.values()]
    .filter((o) => !family.has(o.id) && o.id !== g.parent)
    .map((o) => ({ id: o.id, name: displayName(o), shared: [...o.docs.keys()].filter((d) => mine.has(d)).length }))
    .filter((o) => o.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name))
    .slice(0, 6);

  const ancestors: { id: string; name: string }[] = [];
  for (let p = g.parent; p && ancestors.length < 10; p = all.get(p)?.parent ?? null) ancestors.unshift({ id: p, name: displayName(all.get(p)!) });

  const key = docs.filter((d) => d.pinned).concat([...docs].filter((d) => !d.pinned).sort((a, b) => b.visit_count - a.visit_count)).slice(0, 5);
  return {
    ...summary,
    docs,
    key_docs: key,
    meetings: docs.filter((d) => d.enrichment?.doc_type === "meeting_notes").slice(0, 8),
    people: projectPeople,
    topics,
    related_projects: related,
    ancestors,
    children: g.children.map((c) => summarise(all, all.get(c)!, at, people)).sort((a, b) => b.doc_count - a.doc_count || a.name.localeCompare(b.name)),
    decisions: decisionsFor(db, ids),
    summary: cachedSummary(db, g.id, summaryInputHash(db, summaryDocs(db, all, g).map((d) => d.id), summary.name)),
    aliases: [...g.spellings.keys()].filter((s) => s !== summary.name),
    own_doc_ids: [...g.docs.keys()],
  };
}

/** Counts for "Your work at a glance" plus a short activity feed. */
export function getOverview(db: Database, at = now()): Overview {
  const count = (sql: string, ...p: number[]) => db.query<{ n: number }, number[]>(sql).get(...p)?.n ?? 0;
  const projects = listProjects(db, at);
  const activity: ActivityItem[] = [];

  const window = (sinceMs: number) => {
    const enriched = db
      .query<{ n: number; at: number | null }, [number]>(`SELECT COUNT(DISTINCT doc_id) AS n, MAX(created_at) AS at FROM enrichments WHERE is_current = 1 AND created_at >= ?`)
      .get(sinceMs);
    const captured = db.query<{ n: number; at: number | null }, [number]>(`SELECT COUNT(*) AS n, MAX(first_seen_at) AS at FROM documents WHERE first_seen_at >= ?`).get(sinceMs);
    return { enriched, captured };
  };
  // Today's activity if there is any, otherwise this week's.
  let w = window(at - DAY);
  if (!w.enriched?.n && !w.captured?.n) w = window(at - 7 * DAY);
  if (w.enriched?.n && w.enriched.at) activity.push({ kind: "enriched", count: w.enriched.n, at: w.enriched.at, label: `${w.enriched.n} ${w.enriched.n === 1 ? "doc" : "docs"} enriched` });
  if (w.captured?.n && w.captured.at) activity.push({ kind: "captured", count: w.captured.n, at: w.captured.at, label: `${w.captured.n} ${w.captured.n === 1 ? "doc" : "docs"} captured` });
  for (const p of projects.filter((p) => p.new_doc_count > 0 && !p.parent_id).slice(0, 3)) {
    activity.push({ kind: "project", count: p.new_doc_count, at: p.last_seen_at, label: `Project updated: ${p.name}`, project_id: p.id });
  }
  activity.sort((a, b) => b.at - a.at);

  return {
    docs: count(`SELECT COUNT(*) AS n FROM documents`),
    projects: projects.length,
    new_projects: projects.filter((p) => p.doc_count > 0 && p.doc_count === p.new_doc_count).length,
    collections: count(`SELECT COUNT(*) AS n FROM collections`),
    people: count(`SELECT COUNT(DISTINCT person_id) AS n FROM doc_people`),
    activity,
  };
}

/** Projects with documents opened lately, each with those documents (newest first). */
export function recentProjectActivity(db: Database, opts: { days?: number; projects?: number; docs?: number; at?: number } = {}) {
  const at = opts.at ?? now();
  const since = at - (opts.days ?? 14) * DAY;
  const all = groups(db);
  const summaries = new Map(summariseAll(db, all, at).map((p) => [p.id, p]));
  const rows = [...all.values()]
    .map((g) => ({ g, recent: rollupDocs(all, g).filter((d) => d.last_seen_at >= since) }))
    .filter((x) => x.recent.length > 0)
    // Show parents rather than repeating their subprojects' documents.
    .filter((x) => !x.g.parent || !all.get(x.g.parent)!.docs.size)
    .sort((a, b) => b.recent[0]!.last_seen_at - a.recent[0]!.last_seen_at)
    .slice(0, opts.projects ?? 6);
  return rows.map(({ g, recent }) => ({ project: summaries.get(g.id)!, docs: docsInOrder(db, recent.slice(0, opts.docs ?? 5).map((d) => d.doc_id)) }));
}

/** For each document asked about, the projects it is in now ({ id, name }, corrections applied). */
export function projectRefsByDoc(db: Database, docIds: Set<string>): Map<string, { id: string; name: string }[]> {
  const out = new Map<string, { id: string; name: string }[]>();
  for (const g of groups(db).values()) {
    for (const id of g.docs.keys()) {
      if (!docIds.has(id)) continue;
      const list = out.get(id) ?? [];
      list.push({ id: g.id, name: displayName(g) });
      out.set(id, list);
    }
  }
  return out;
}
