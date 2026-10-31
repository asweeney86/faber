import type { DocSource, DocType, SearchFilters } from "@faber/shared";
import { DOC_TYPES } from "../enrich/schema";

const SOURCES: DocSource[] = ["gdoc", "gslides", "gsheets", "url"];
const MAX_VALUES = 50;

export class ValidationError extends Error {}

function stringList(name: string, v: unknown, allowed?: readonly string[]): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ValidationError(`filters.${name} must be an array of strings`);
  if (v.length > MAX_VALUES) throw new ValidationError(`filters.${name} has too many values (max ${MAX_VALUES})`);
  const out = v.map((x) => {
    if (typeof x !== "string" || !x.trim() || x.length > 200) throw new ValidationError(`filters.${name} must contain non-empty strings`);
    if (allowed && !allowed.includes(x)) throw new ValidationError(`filters.${name}: unknown value "${x}"`);
    return x.trim();
  });
  return out.length ? out : undefined;
}

function timestamp(name: string, v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`filters.${name} must be a timestamp in ms`);
  return v;
}

/**
 * Type-check filters from untrusted input (HTTP bodies, imported collection
 * files). Returns a clean copy with only known fields, or undefined when empty.
 */
export function validateFilters(raw: unknown): SearchFilters | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("filters must be an object");
  const f = raw as Record<string, unknown>;
  if (f.pinned !== undefined && f.pinned !== null && typeof f.pinned !== "boolean") throw new ValidationError("filters.pinned must be a boolean");
  const out: SearchFilters = {
    doc_type: stringList("doc_type", f.doc_type, DOC_TYPES) as DocType[] | undefined,
    source: stringList("source", f.source, SOURCES) as DocSource[] | undefined,
    tag: stringList("tag", f.tag),
    project: stringList("project", f.project),
    person: stringList("person", f.person),
    pinned: typeof f.pinned === "boolean" ? f.pinned : undefined,
    seen_after: timestamp("seen_after", f.seen_after),
    seen_before: timestamp("seen_before", f.seen_before),
  };
  for (const k of Object.keys(out) as (keyof SearchFilters)[]) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

export function hasFilters(f: SearchFilters | undefined): boolean {
  return Boolean(f && Object.keys(f).length > 0);
}

/** Clamp an untrusted limit to [1, max], defaulting when missing or not a number. */
export function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}
