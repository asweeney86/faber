import type { DocType, SearchFilters } from "./api";

/**
 * Dashboards and saved views (PRD 2.6 and P2): a named list of widgets. The three
 * built-in dashboards are specs like any other; users make their own from a
 * search ("Save as view") or from the dashboard editor.
 */
/** In a widget's filters, a negative seen_after means "this many days ago" (resolved when shown). */
export type ViewWidget =
  | { kind: "search"; title: string; q: string; filters?: SearchFilters; limit?: number }
  | { kind: "project"; project_id: string }
  | { kind: "collection"; collection_id: string }
  | { kind: "recent" }
  | { kind: "pinned" }
  | { kind: "frequent" }
  | { kind: "project_activity" };

export interface ViewSpec {
  widgets: ViewWidget[];
}

export interface SavedView {
  id: string;
  name: string;
  spec: ViewSpec;
  builtin: boolean;
  created_at: number;
  updated_at: number;
}

const PLANNING_TYPES: DocType[] = ["roadmap", "okrs", "prd", "design_doc", "research"];

export const BUILTIN_VIEWS: SavedView[] = [
  {
    id: "my-work",
    name: "My Work",
    builtin: true,
    created_at: 0,
    updated_at: 0,
    spec: { widgets: [{ kind: "pinned" }, { kind: "recent" }, { kind: "project_activity" }, { kind: "frequent" }] },
  },
  {
    id: "planning",
    name: "Planning",
    builtin: true,
    created_at: 0,
    updated_at: 0,
    spec: {
      widgets: [
        { kind: "search", title: "Roadmaps, OKRs and PRDs", q: "", filters: { doc_type: ["roadmap", "okrs", "prd"] }, limit: 10 },
        { kind: "search", title: "Design docs and research", q: "", filters: { doc_type: ["design_doc", "research"] }, limit: 10 },
        { kind: "search", title: "Planning, last 30 days", q: "", filters: { doc_type: PLANNING_TYPES, seen_after: -30 }, limit: 10 },
      ],
    },
  },
  {
    id: "project-activity",
    name: "Recent Project Activity",
    builtin: true,
    created_at: 0,
    updated_at: 0,
    spec: { widgets: [{ kind: "project_activity" }] },
  },
];

const KINDS = new Set(["search", "project", "collection", "recent", "pinned", "frequent", "project_activity"]);

/** Validate a spec from the API; throws with a readable message. */
export function validateViewSpec(spec: unknown): ViewSpec {
  if (!spec || typeof spec !== "object" || !Array.isArray((spec as ViewSpec).widgets)) throw new Error("spec.widgets must be an array");
  const widgets = (spec as ViewSpec).widgets;
  if (widgets.length > 24) throw new Error("a view can have at most 24 widgets");
  return {
    widgets: widgets.map((w, i) => {
      if (!w || typeof w !== "object" || !KINDS.has((w as ViewWidget).kind)) throw new Error(`widget ${i + 1}: unknown kind`);
      switch (w.kind) {
        case "search":
          if (typeof w.q !== "string") throw new Error(`widget ${i + 1}: q must be a string`);
          if (w.title !== undefined && typeof w.title !== "string") throw new Error(`widget ${i + 1}: title must be a string`);
          if (w.filters !== undefined && (typeof w.filters !== "object" || w.filters === null || Array.isArray(w.filters))) throw new Error(`widget ${i + 1}: filters must be an object`);
          return { kind: "search", title: (w.title ?? w.q).slice(0, 120) || "Search", q: w.q.slice(0, 500), filters: w.filters, limit: Math.min(Math.max(Number(w.limit) || 8, 1), 25) };
        case "project":
          if (typeof w.project_id !== "string" || !w.project_id) throw new Error(`widget ${i + 1}: project_id is required`);
          return { kind: "project", project_id: w.project_id };
        case "collection":
          if (typeof w.collection_id !== "string" || !w.collection_id) throw new Error(`widget ${i + 1}: collection_id is required`);
          return { kind: "collection", collection_id: w.collection_id };
        default:
          return { kind: w.kind };
      }
    }),
  };
}
