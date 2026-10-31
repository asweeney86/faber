import type { Database } from "bun:sqlite";
import type { DocProjectOverride, OrganizeRule, ProjectSummary, ProjectUpdate, ReviewItem, ReviewQueue } from "@faber/shared";
import { now } from "./db";
import { getDocs } from "./docs";
import { displayName, findProject, groups, loadRules, projectId, resolveId, rollupDocs, summariseAll, summaryDocs, summaryInputHash, type Group } from "./projects";
import type { Chat } from "./providers/types";

/**
 * Corrections to the inferred organization (PRD 2.4): rename, merge, move in the
 * hierarchy, "not a project", hand-made projects, per-document assignment, plus
 * the review queue of uncertain inferences. Every correction is a row the user
 * can see and undo (Settings → Organization).
 */

export class OrganizeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type RuleFields = { name?: string | null; merge_into?: string | null; parent?: string | null; hidden?: number; manual?: number; confirmed?: number };

function upsertRule(db: Database, key: string, fields: RuleFields) {
  const existing = db.query<{ key: string }, [string]>(`SELECT key FROM project_rules WHERE key = ?`).get(key);
  if (!existing) db.run(`INSERT INTO project_rules (key, updated_at) VALUES (?, ?)`, [key, now()]);
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  if (sets.length) db.run(`UPDATE project_rules SET ${sets.join(", ")}, updated_at = ? WHERE key = ?`, [...(Object.values(fields) as (string | number | null)[]), now(), key]);
}

function requireProject(db: Database, id: string, all = groups(db)): Group {
  const g = findProject(db, id, all);
  if (!g) throw new OrganizeError("project not found", 404);
  return g;
}

const optionalId = (v: unknown, field: string): string | null | undefined => {
  if (v === undefined || v === null || v === "") return v as string | null | undefined;
  if (typeof v !== "string" || v.length > 200) throw new OrganizeError(`${field} must be a project id`);
  return v;
};
const optionalBool = (v: unknown, field: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new OrganizeError(`${field} must be true or false`);
  return v;
};

const cleanName = (name: unknown) => {
  if (typeof name !== "string") throw new OrganizeError("name must be a string");
  const n = name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!n) throw new OrganizeError("name can't be empty");
  return n;
};

/** Make a project by hand (it exists before any document is in it). */
export function createProject(db: Database, input: { name: unknown; parent_id?: unknown }): string {
  const name = cleanName(input?.name);
  const parentId = optionalId(input?.parent_id, "parent_id");
  const id = projectId(name);
  const all = groups(db);
  if (all.has(id)) throw new OrganizeError(`“${displayName(all.get(id)!)}” already exists`, 409);
  // Don't quietly undo an earlier correction by re-creating the name.
  const rule = loadRules(db).get(id);
  if (rule?.merge_into) throw new OrganizeError(`“${name}” was merged into another project; undo that in Settings → Organization first`, 409);
  if (rule?.hidden) throw new OrganizeError(`“${name}” was marked as not a project; undo that in Settings → Organization first`, 409);
  const parent = parentId ? requireProject(db, parentId, all).id : null;
  upsertRule(db, id, { name, manual: 1, confirmed: 1, hidden: 0, merge_into: null, parent });
  return id;
}

export function updateProject(db: Database, id: string, patch: ProjectUpdate) {
  if (!patch || typeof patch !== "object") throw new OrganizeError("send the fields to change");
  const hidden = optionalBool(patch.hidden, "hidden");
  const confirmed = optionalBool(patch.confirmed, "confirmed");
  const parentId = optionalId(patch.parent_id, "parent_id");
  const all = groups(db);
  // A hidden project isn't in the lists, but can still be brought back.
  const rules = loadRules(db);
  if (!findProject(db, id, all) && rules.get(id)?.hidden && hidden === false) {
    upsertRule(db, id, { hidden: 0, confirmed: 1 });
    return;
  }
  const g = requireProject(db, id, all);
  const fields: RuleFields = { confirmed: 1 };
  if (patch.name !== undefined) {
    fields.name = patch.name === null ? null : cleanName(patch.name);
    // Two projects can't share a name (it would make them indistinguishable everywhere).
    if (fields.name) {
      const lower = fields.name.toLowerCase();
      const clash = [...all.values()].find((o) => o.id !== g.id && (o.id === projectId(fields.name!) || displayName(o).toLowerCase() === lower));
      if (clash) throw new OrganizeError(`“${displayName(clash)}” already exists; merge into it instead`, 409);
    }
  }
  if (parentId !== undefined) {
    if (parentId === null || parentId === "") fields.parent = parentId;
    else {
      const parent = requireProject(db, parentId, all);
      // A project can't be moved under itself or its own descendants.
      if (new Set(rollupIds(all, g)).has(parent.id)) throw new OrganizeError("a project can't be moved inside itself");
      fields.parent = parent.id;
    }
  }
  if (hidden !== undefined) fields.hidden = hidden ? 1 : 0;
  if (confirmed !== undefined) fields.confirmed = confirmed ? 1 : 0;
  upsertRule(db, g.id, fields);
}

function rollupIds(all: Map<string, Group>, g: Group): string[] {
  const out: string[] = [];
  const walk = (x: Group, d: number) => {
    out.push(x.id);
    if (d < 10) for (const c of x.children) walk(all.get(c)!, d + 1);
  };
  walk(g, 0);
  return out;
}

/** "These are the same project": everything in `id` now belongs to `into`. */
export function mergeProject(db: Database, id: string, into: unknown) {
  if (typeof into !== "string" || !into) throw new OrganizeError("into is required");
  const all = groups(db);
  const a = requireProject(db, id, all);
  const b = requireProject(db, into, all);
  if (a.id === b.id) throw new OrganizeError("a project can't be merged into itself");
  if (rollupIds(all, a).includes(b.id)) throw new OrganizeError(`“${displayName(b)}” is inside “${displayName(a)}”; move it out first, or merge the other way`);
  db.transaction(() => {
    upsertRule(db, a.id, { merge_into: b.id, confirmed: 1 });
    // The target keeps its own name, however many documents the merged one brings.
    upsertRule(db, b.id, { confirmed: 1, ...(b.rule?.name ? {} : { name: displayName(b) }) });
    // Subprojects with an explicit parent follow automatically (parents resolve through merges).
  })();
}

/** Undo every correction to a project (it goes back to what inference says). */
export function resetProject(db: Database, id: string) {
  const rule = loadRules(db).get(id);
  db.transaction(() => {
    db.run(`DELETE FROM project_rules WHERE key = ?`, [id]);
    // Deleting a hand-made project takes its hand-added documents with it, so it can't
    // come back as an inferred one.
    if (rule?.manual) db.run(`DELETE FROM doc_projects WHERE key = ?`, [id]);
    db.run(`DELETE FROM project_summaries WHERE key = ?`, [id]);
  })();
}

/** Put a document in a project, or take it out (overriding what enrichment found). */
export function setDocProject(db: Database, docId: string, projectIdOrName: string, inProject: boolean) {
  if (typeof projectIdOrName !== "string" || !projectIdOrName.trim()) throw new OrganizeError("project is required");
  if (projectIdOrName.length > 1000) throw new OrganizeError("project name is too long");
  if (!db.query(`SELECT 1 FROM documents WHERE id = ?`).get(docId)) throw new OrganizeError("document not found", 404);
  const all = groups(db);
  let g = findProject(db, projectIdOrName, all);
  if (!g) {
    if (!inProject) throw new OrganizeError("project not found", 404);
    // Adding to a project that doesn't exist yet makes it.
    g = requireProject(db, createProject(db, { name: projectIdOrName }));
  }
  db.run(
    `INSERT INTO doc_projects (doc_id, key, state, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(doc_id, key) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    [docId, g.id, inProject ? "add" : "remove", now()],
  );
}

/** Forget a per-document correction. */
export function clearDocProject(db: Database, docId: string, projectIdOrName: string) {
  const rules = loadRules(db);
  const target = new Set([projectIdOrName, resolveId(rules, projectIdOrName), resolveId(rules, projectId(projectIdOrName))]);
  // Corrections keyed to a name that was later merged in count as this project's too.
  for (const r of db.query<{ key: string }, [string]>(`SELECT key FROM doc_projects WHERE doc_id = ?`).all(docId)) {
    if (target.has(r.key) || target.has(resolveId(rules, r.key))) db.run(`DELETE FROM doc_projects WHERE doc_id = ? AND key = ?`, [docId, r.key]);
  }
}

/** The projects a document is in now (after corrections). */
export function projectsForDoc(db: Database, docId: string): { id: string; name: string; corrected: boolean }[] {
  const all = groups(db);
  const rules = loadRules(db);
  const overrides = new Set(db.query<{ key: string }, [string]>(`SELECT key FROM doc_projects WHERE doc_id = ? AND state = 'add'`).all(docId).map((r) => resolveId(rules, r.key)));
  return [...all.values()].filter((g) => g.docs.has(docId)).map((g) => ({ id: g.id, name: displayName(g), corrected: overrides.has(g.id) }));
}

/** Every correction, for review and undo. */
export function listCorrections(db: Database): { rules: OrganizeRule[]; docs: DocProjectOverride[] } {
  const all = groups(db);
  const name = (id: string) => (all.get(id) ? displayName(all.get(id)!) : id.replace(/-/g, " "));
  const ruleMap = loadRules(db);
  const rules = [...ruleMap.values()]
    .filter((r) => r.name || r.merge_into || r.parent !== null || r.hidden || r.manual)
    .map(
      (r): OrganizeRule => ({
        id: r.key,
        label: r.merge_into || r.hidden ? (r.name ?? r.key.replace(/-/g, " ")) : name(r.key),
        name: r.name,
        merged_into: r.merge_into ? { id: resolveId(ruleMap, r.merge_into), name: name(resolveId(ruleMap, r.merge_into)) } : null,
        parent: r.parent === "" ? "top" : r.parent ? { id: r.parent, name: name(r.parent) } : null,
        hidden: !!r.hidden,
        manual: !!r.manual,
        confirmed: !!r.confirmed,
      }),
    );
  const docs = db
    .query<{ doc_id: string; title: string; key: string; state: "add" | "remove" }, []>(
      `SELECT o.doc_id, d.title, o.key, o.state FROM doc_projects o JOIN documents d ON d.id = o.doc_id ORDER BY o.updated_at DESC`,
    )
    .all()
    .map((r) => ({ doc_id: r.doc_id, doc_title: r.title, project_id: r.key, project_name: name(r.key), state: r.state }));
  return { rules, docs };
}

// ---------- review queue ----------

/** Edit distance, for spotting near-duplicate names ("Kickstart" / "Kick-start" / "Kickstarter"). */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

const LOW_CONFIDENCE = 0.5;

/**
 * Inferences worth a second look (PRD: "surface uncertain classifications for
 * optional review"): projects seen in only one or two documents that nobody has
 * confirmed, names that look like the same project, and documents the model was
 * unsure about. Each item disappears once acted on or dismissed.
 */
export function reviewQueue(db: Database, at = now()): ReviewQueue {
  const dismissed = new Set(db.query<{ id: string }, []>(`SELECT id FROM review_dismissed`).all().map((r) => r.id));
  const all = groups(db);
  const summaries = new Map(summariseAll(db, all, at).map((p) => [p.id, p]));
  const items: ReviewItem[] = [];

  for (const p of summaries.values()) {
    if (p.manual || p.confirmed || p.doc_count > 2 || p.parent_id) continue;
    items.push({ id: `new:${p.id}`, kind: "new_project", project: p });
  }

  const list = [...summaries.values()];
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i]!, list[j]!];
      // Family members and versioned/numbered siblings (Billing v1/v2, Q3/Q4 Planning) aren't duplicates.
      if (a.parent_id === b.id || b.parent_id === a.id || (a.parent_id && a.parent_id === b.parent_id)) continue;
      if (squash(a.name).replace(/\d+/g, "#") === squash(b.name).replace(/\d+/g, "#") && squash(a.name) !== squash(b.name)) continue;
      const [x, y] = [squash(a.name), squash(b.name)];
      if (x.length < 4 || y.length < 4) continue;
      const similar = x === y || distance(x, y) <= (Math.min(x.length, y.length) >= 8 ? 2 : 1);
      if (!similar) continue;
      const [first, second] = a.doc_count >= b.doc_count ? [a, b] : [b, a];
      items.push({ id: `dup:${[a.id, b.id].sort().join("|")}`, kind: "duplicate", a: first, b: second });
    }
  }

  const unsure = db
    .query<{ doc_id: string; id: number; confidence: number }, [number]>(
      `SELECT e.doc_id, e.id, e.confidence FROM enrichments e JOIN documents d ON d.id = e.doc_id
       WHERE e.is_current = 1 AND d.content IS NOT NULL AND e.confidence < ? ORDER BY d.last_seen_at DESC LIMIT 20`,
    )
    .all(LOW_CONFIDENCE);
  const docs = getDocs(
    db,
    unsure.map((u) => u.doc_id),
  );
  for (const u of unsure) {
    const doc = docs.get(u.doc_id);
    if (doc) items.push({ id: `low:${u.doc_id}:${u.id}`, kind: "low_confidence", doc, confidence: u.confidence });
  }

  return { items: items.filter((i) => !dismissed.has(i.id)) };
}

export function dismissReviewItem(db: Database, id: string) {
  if (!/^(new|dup|low):/.test(id) || id.length > 300) throw new OrganizeError("not a review item");
  db.run(`INSERT INTO review_dismissed (id, at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at`, [id, now()]);
}

// ---------- AI summary ----------

export const PROJECT_SUMMARY_SYSTEM = `You write a short overview of one work project for the person who owns these notes, using only the document summaries given.
- 3 to 5 sentences: what the project is, its current state, open questions or risks, and who is involved.
- Mention concrete dates, owners and decisions when the summaries give them. Never invent anything.
- Plain prose, no headings or bullet points.`;

/** Write (and cache) the AI overview of a project from its documents' summaries. */
export async function writeProjectSummary(db: Database, chat: Chat, id: string): Promise<{ text: string; model: string; created_at: number }> {
  const all = groups(db);
  const g = requireProject(db, id, all);
  const docs = summaryDocs(db, all, g);
  if (docs.length === 0) throw new OrganizeError("this project has no summarised documents yet", 409);
  const lines = docs.map((d, i) => `[${i + 1}] ${d.title} (${d.enrichment!.doc_type}${d.enrichment!.written_at ? `, ${d.enrichment!.written_at}` : ""}): ${d.enrichment!.summary}`);
  const text = (await chat.complete(PROJECT_SUMMARY_SYSTEM, `Project: ${displayName(g)}\n\nDocuments:\n${lines.join("\n")}\n\nWrite the overview.`)).trim();
  const created_at = now();
  db.run(
    `INSERT INTO project_summaries (key, input_hash, summary, model, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET input_hash = excluded.input_hash, summary = excluded.summary, model = excluded.model, created_at = excluded.created_at`,
    [g.id, summaryInputHash(db, docs.map((d) => d.id), displayName(g)), text, `${chat.provider}/${chat.model}`, created_at],
  );
  return { text, model: `${chat.provider}/${chat.model}`, created_at };
}

export type { ProjectSummary };
