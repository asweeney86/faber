import type { DocType, Enrichment } from "@faber/shared";
import type { Chat, Embedder, Enricher, EnrichInput } from "./types";

/**
 * Deterministic, offline providers for tests, demos and CI.
 *
 * The embedder hashes word unigrams and bigrams into a fixed-size vector, so
 * texts that share vocabulary are close — enough for semantic search to behave
 * plausibly without a model. The enricher uses simple heuristics.
 */

const DIMS = 1024;

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with we our you your they them their i".split(" "),
);

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class FakeEmbedder implements Embedder {
  readonly provider = "fake";
  readonly model: string;
  minSimilarity = 0.3;
  constructor(model = "fake-embed") {
    this.model = model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(DIMS);
      const ws = words(t);
      ws.forEach((w, i) => {
        v[hash(w) % DIMS]! += 1;
        const next = ws[i + 1];
        if (next) v[hash(`${w} ${next}`) % DIMS]! += 0.5;
      });
      return v;
    });
  }
}

const TYPE_HINTS: [RegExp, DocType][] = [
  [/\b(postmortem|post-mortem|root cause)\b/i, "postmortem"],
  [/\b(runbook|on-call|playbook)\b/i, "runbook"],
  [/\b(status update|weekly status|weekly update)\b/i, "status_update"],
  [/\b(agenda|attendees|minutes)\b/i, "meeting_notes"],
  [/\b(okrs?|key results?)\b/i, "okrs"],
  [/\b(prd|product requirements|user stories)\b/i, "prd"],
  [/\b(roadmap)\b/i, "roadmap"],
  [/\b(design doc|proposal|architecture|rfc)\b/i, "design_doc"],
  [/\b(policy|compliance|guideline)\b/i, "policy"],
  [/\b(research|study|interview|survey)\b/i, "research"],
];

const NAME = /[A-Z][a-z]+(?:-[A-Z][a-z]+)? [A-Z][a-z]+(?:-[A-Z][a-z]+)?/g;
const PEOPLE_LABELS = /\b(?:author|owner|owners|reviewers?|attendees|researcher|presented by|incident commander|stakeholders|ic)\b[:\s]+([^\n]+)/gi;

/** Words that look like names but are teams or orgs. */
const ORG_WORDS = new Set(["project", "platform", "team", "infra", "legal", "security", "finance", "product", "growth", "engineering", "on-call"]);
/** Boilerplate that makes poor tags. */
const TAG_STOP = new Set(["about", "above", "after", "author", "before", "being", "current", "draft", "every", "items", "should", "their", "there", "these", "under", "until", "which", "while", "would"]);

/** People named on labelled lines ("Author: …", "Attendees: …") plus names mentioned at least twice. */
function extractPeople(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(PEOPLE_LABELS)) for (const n of m[1]!.match(NAME) ?? []) found.push(n);
  const counts = new Map<string, number>();
  for (const n of text.match(NAME) ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
  const labelWords = new Set(found.flatMap((n) => n.split(" ")));
  for (const [n, c] of counts) {
    // Repeated two-word names whose first word is also a known first name.
    if (c >= 2 && labelWords.has(n.split(" ")[0]!)) found.push(n);
  }
  return Array.from(new Set(found))
    .filter((n) => !n.toLowerCase().split(" ").some((w) => ORG_WORDS.has(w)))
    .slice(0, 8);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export class FakeEnricher implements Enricher {
  readonly provider = "fake";
  readonly model: string;
  constructor(model = "fake-enrich") {
    this.model = model;
  }

  async enrich(input: EnrichInput): Promise<Enrichment> {
    const text = `${input.title}\n${input.text}`;
    // The title is the strongest signal ("Runbook: …"), then the body.
    const doc_type: DocType =
      input.source === "gslides"
        ? "deck"
        : input.source === "gsheets"
          ? "spreadsheet"
          : (TYPE_HINTS.find(([re]) => re.test(input.title))?.[1] ?? TYPE_HINTS.find(([re]) => re.test(input.text))?.[1] ?? "other");

    const people = extractPeople(text);
    const projects = Array.from(new Set((text.match(/\bProject ([A-Z][a-z]+)\b/g) ?? []).map((p) => p.replace("Project ", ""))));

    const freq = new Map<string, number>();
    const nameWords = new Set(people.flatMap((p) => p.toLowerCase().split(" ")));
    const raw = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}-]+/u)
      .filter((w) => w.length > 4 && !STOP.has(w) && !TAG_STOP.has(w) && !nameWords.has(w) && !MONTHS.includes(w) && !/^\d/.test(w));
    for (const w of raw) freq.set(w, (freq.get(w) ?? 0) + 1);
    const tags = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([w]) => w);

    let written_at: string | null = null;
    const m = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i").exec(text);
    if (m) {
      const mo = String(MONTHS.indexOf(m[1]!.toLowerCase()) + 1).padStart(2, "0");
      written_at = `${m[3]}-${mo}-${m[2]!.padStart(2, "0")}`;
    }

    const firstLine = input.text.split("\n").find((l) => l.trim().length > 40)?.trim() ?? input.title;
    return {
      summary: `${input.title || "Untitled"}: ${firstLine.slice(0, 180)}`,
      doc_type,
      written_at,
      projects,
      people,
      teams: [],
      tags,
      confidence: input.text.trim() ? 0.6 : 0,
    };
  }
}

export class FakeChat implements Chat {
  readonly provider = "fake";
  readonly model: string;
  constructor(model = "fake-chat") {
    this.model = model;
  }

  /** Picks the sentences that best overlap the question from the first few sources and cites them. */
  async complete(_system: string, user: string): Promise<string> {
    // Project overviews: stitch the first sentences of the newest document summaries.
    const project = /^Project: (.*)$/m.exec(user)?.[1];
    if (project) {
      const docs = [...user.matchAll(/^\[\d+\] ([^(\n]+)\([^)]*\): (.*)$/gm)].slice(0, 3);
      const first = (t: string) => (t.split(/(?<=[.!?])\s+/)[0] ?? t).trim();
      return `${project} spans ${docs.length === 1 ? "one document" : `${docs.length} recent documents`}. ${docs.map((d) => first(d[2]!)).join(" ")}`.trim();
    }
    const question = /^Question: (.*)$/m.exec(user)?.[1] ?? "";
    const qWords = new Set(words(question));
    const sources = [...user.matchAll(/^\[(\d+)\][^\n]*\n([\s\S]*?)(?=\n\n\[\d+\]|\n---)/gm)].map((m) => ({ n: Number(m[1]), text: m[2]! }));
    const picked: { n: number; sentence: string; score: number }[] = [];
    for (const src of sources.slice(0, 4)) {
      for (const sentence of src.text.split(/(?<=[.!?])\s+|\n+/)) {
        const score = words(sentence).filter((w) => qWords.has(w)).length;
        if (score > 0 && sentence.length > 30) picked.push({ n: src.n, sentence: sentence.trim(), score });
      }
    }
    picked.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const lines = picked.filter((p) => !seen.has(p.sentence) && seen.add(p.sentence)).slice(0, 3);
    if (lines.length === 0) return "The sources don't answer that directly. Try searching for related terms.";
    return lines.map((l) => `${l.sentence.replace(/[.!?]?$/, ".")} [${l.n}]`).join(" ");
  }
}
