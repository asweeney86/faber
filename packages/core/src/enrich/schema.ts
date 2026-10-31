import { z } from "zod";
import type { Enrichment } from "@faber/shared";

export const DOC_TYPES = [
  "prd",
  "design_doc",
  "meeting_notes",
  "postmortem",
  "okrs",
  "roadmap",
  "deck",
  "spreadsheet",
  "runbook",
  "policy",
  "research",
  "status_update",
  "other",
] as const;

export const EnrichmentSchema = z.object({
  summary: z.string().describe("Two to three sentences: what the document is, what it decides or proposes, and who it is for."),
  doc_type: z.enum(DOC_TYPES),
  written_at: z
    .string()
    .nullable()
    .describe('Best estimate of when the document was written, as "YYYY-MM" or "YYYY-MM-DD". Null if there is no evidence.'),
  projects: z.array(z.string()).describe("Project, initiative or product codenames the document is about. Use the names as written."),
  people: z.array(z.string()).describe("Full names of people who authored, own or are significantly involved. No generic roles."),
  teams: z.array(z.string()).describe("Teams or orgs the document belongs to or addresses."),
  tags: z.array(z.string()).describe("Three to eight short lowercase topical tags, e.g. 'pricing', 'rate-limits', 'q3-planning'."),
  confidence: z.number().min(0).max(1).describe("How confident you are in the extraction overall."),
});

export type EnrichmentOutput = z.infer<typeof EnrichmentSchema>;

/** JSON Schema form, for providers that take a raw schema (Ollama, OpenAI-compatible). */
export const ENRICHMENT_JSON_SCHEMA = z.toJSONSchema(EnrichmentSchema) as Record<string, unknown>;

/** Normalise whatever a model returned into a clean Enrichment, throwing on schema violations. */
export function coerceEnrichment(raw: unknown): Enrichment {
  const parsed = EnrichmentSchema.parse(raw);
  const clean = (xs: string[]) =>
    Array.from(new Set(xs.map((s) => s.trim()).filter((s) => s.length > 0 && s.length < 80)));
  return {
    summary: parsed.summary.trim(),
    doc_type: parsed.doc_type,
    written_at: normaliseDate(parsed.written_at),
    projects: clean(parsed.projects),
    people: clean(parsed.people),
    teams: clean(parsed.teams),
    tags: clean(parsed.tags.map((t) => t.toLowerCase().replace(/\s+/g, "-"))),
    confidence: parsed.confidence,
  };
}

function normaliseDate(d: string | null): string | null {
  if (!d) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(d.trim());
  if (!m) return null;
  const [, y, mo, da] = m;
  if (!mo) return `${y}-01`;
  return da ? `${y}-${mo}-${da}` : `${y}-${mo}`;
}
