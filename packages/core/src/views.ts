import type { Database } from "bun:sqlite";
import { BUILTIN_VIEWS, validateViewSpec, type SavedView, type ViewSpec } from "@faber/shared";
import { newId, now } from "./db";
import { validateFilters } from "./search/filters";

/** Saved views / custom dashboards. Built-ins come first and can't be edited (copy one instead). */

export class ViewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  name: string;
  spec: string;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Row): SavedView => ({ id: r.id, name: r.name, spec: JSON.parse(r.spec) as ViewSpec, builtin: false, created_at: r.created_at, updated_at: r.updated_at });

export function listViews(db: Database): SavedView[] {
  return [...BUILTIN_VIEWS, ...db.query<Row, []>(`SELECT id, name, spec, created_at, updated_at FROM views ORDER BY position, created_at`).all().map(fromRow)];
}

export function getView(db: Database, id: string): SavedView | null {
  const builtin = BUILTIN_VIEWS.find((v) => v.id === id);
  if (builtin) return builtin;
  const r = db.query<Row, [string]>(`SELECT id, name, spec, created_at, updated_at FROM views WHERE id = ?`).get(id);
  return r ? fromRow(r) : null;
}

function clean(input: { name?: unknown; spec?: unknown }, partial: boolean): { name?: string; spec?: ViewSpec } {
  const out: { name?: string; spec?: ViewSpec } = {};
  if (input.name !== undefined || !partial) {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    if (!name) throw new ViewError("name is required");
    out.name = name;
  }
  if (input.spec !== undefined || !partial) {
    try {
      out.spec = validateViewSpec(input.spec);
      // Search filters are checked like any search; a negative seen_after means "days ago".
      for (const w of out.spec.widgets) {
        if (w.kind !== "search" || !w.filters) continue;
        const relative = typeof w.filters.seen_after === "number" && w.filters.seen_after < 0 ? Math.max(w.filters.seen_after, -3650) : undefined;
        const checked = validateFilters({ ...w.filters, ...(relative !== undefined ? { seen_after: undefined } : {}) }) ?? {};
        w.filters = relative !== undefined ? { ...checked, seen_after: relative } : checked;
      }
    } catch (e) {
      throw new ViewError(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

export function createView(db: Database, input: { name?: unknown; spec?: unknown }): SavedView {
  const { name, spec } = clean(input, false);
  const id = newId();
  const t = now();
  const position = (db.query<{ n: number }, []>(`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM views`).get()?.n ?? 1) as number;
  db.run(`INSERT INTO views (id, name, spec, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, name!, JSON.stringify(spec), position, t, t]);
  return getView(db, id)!;
}

export function updateView(db: Database, id: string, input: { name?: unknown; spec?: unknown }): SavedView {
  if (BUILTIN_VIEWS.some((v) => v.id === id)) throw new ViewError("built-in dashboards can't be changed; duplicate one instead");
  if (!getView(db, id)) throw new ViewError("view not found", 404);
  const { name, spec } = clean(input, true);
  if (name !== undefined) db.run(`UPDATE views SET name = ?, updated_at = ? WHERE id = ?`, [name, now(), id]);
  if (spec !== undefined) db.run(`UPDATE views SET spec = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(spec), now(), id]);
  return getView(db, id)!;
}

export function deleteView(db: Database, id: string) {
  if (BUILTIN_VIEWS.some((v) => v.id === id)) throw new ViewError("built-in dashboards can't be deleted");
  db.run(`DELETE FROM views WHERE id = ?`, [id]);
}
