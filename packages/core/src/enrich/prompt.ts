import type { EnrichInput } from "../providers/types";

/** Bump when the prompt changes materially so old enrichments can be re-run. */
export const PROMPT_VERSION = 2;

export const SYSTEM_PROMPT = `You index internal work documents so their owner can find them later by context rather than by title.
Read the document and return a single JSON object matching the provided schema. Rules:
- Summarise in one or two short sentences (40 words at most): what the document is and what it concludes, not how it is structured.
- Prefer concrete names (projects, people, teams, codenames) exactly as they appear.
- For written_at use dated headers, meeting dates, "Last updated" lines, or quarter references ("Q3 2025" -> "2025-07"). If nothing dates it, return null rather than guessing.
- Tags are short, lowercase, hyphenated topics. Do not tag the document type or the company name.
- If the text is empty or looks like an access-denied page, set doc_type to "other", confidence to 0, and say so in the summary.`;

export function userPrompt(input: EnrichInput): string {
  return [
    `Title: ${input.title || "(untitled)"}`,
    `Source: ${input.source}`,
    `URL: ${input.url}`,
    `First opened by owner: ${input.first_seen_iso}`,
    ``,
    `--- DOCUMENT TEXT ---`,
    input.text,
    `--- END ---`,
  ].join("\n");
}
