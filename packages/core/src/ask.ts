import type { AskCitation, AskRequest, AskResponse, AskTurn, DocSource } from "@faber/shared";
import type { Chat } from "./providers/types";
import { clampLimit, validateFilters, ValidationError } from "./search/filters";
import { embedQuery, search, type SearchDeps } from "./search/hybrid";

const MAX_PER_DOC = 3;
const PASSAGE_CHARS = 1800;

export const ASK_SYSTEM = `You answer questions using only the user's own work documents, which are given to you as numbered sources.
- Cite every claim inline with the source number in square brackets, e.g. [1] or [2][3].
- Use ONLY the sources. If they do not contain the answer, reply that your documents don't cover it and suggest what to search for. Never answer from general knowledge, even if you know the answer, and never cite a source for a claim it does not make.
- Be concise: a short paragraph or a few bullets. Mention dates and owners when the sources give them.`;

export class AskError extends Error {}

interface Passage {
  doc_id: string;
  title: string;
  url: string;
  source: DocSource;
  meta: string;
  text: string;
}

/** Retrieve passages for a question: hybrid doc search, then the best chunks inside those docs. */
export async function retrievePassages(deps: SearchDeps, req: AskRequest): Promise<Passage[]> {
  const { db, index, embedder } = deps;
  const k = clampLimit(req.k, 8, 20);
  const res = await search(deps, { q: req.question, filters: req.filters, limit: Math.max(6, Math.ceil(k / 2)) });
  if (res.hits.length === 0) return [];
  const docs = new Map(res.hits.map((h) => [h.doc.id, h.doc]));

  let ranked: { doc_id: string; ix: number }[] = [];
  if (embedder && index.size > 0) {
    try {
      const qv = await embedQuery(embedder, req.question);
      // Chunk 0 is the title + AI summary: good for finding a doc, not evidence for an answer.
      if (qv) ranked = index.searchChunks(qv, k * 4, new Set(docs.keys())).filter((r) => r.ix !== 0);
    } catch {
      // fall back to leading chunks below
    }
  }
  if (ranked.length === 0) ranked = res.hits.flatMap((h) => [1, 2].map((ix) => ({ doc_id: h.doc.id, ix })));

  const perDoc = new Map<string, number>();
  const passages: Passage[] = [];
  const chunkText = db.query<{ text: string }, [string, number]>(`SELECT text FROM chunks WHERE doc_id = ? AND ix = ?`);
  const contentOf = db.query<{ content: string | null }, [string]>(`SELECT content FROM documents WHERE id = ?`);
  for (const r of ranked) {
    if (passages.length >= k) break;
    const n = perDoc.get(r.doc_id) ?? 0;
    if (n >= MAX_PER_DOC) continue;
    const doc = docs.get(r.doc_id)!;
    let text = chunkText.get(r.doc_id, r.ix)?.text;
    // Not embedded yet: fall back to the start of the document's own text (never the summary).
    if (!text && r.ix === 1) text = contentOf.get(r.doc_id)?.content?.slice(0, PASSAGE_CHARS) ?? undefined;
    if (!text) continue;
    perDoc.set(r.doc_id, n + 1);
    const e = doc.enrichment;
    const meta = [e?.doc_type, e?.written_at ? `written ~${e.written_at}` : null, e?.people.slice(0, 3).join(", ") || null]
      .filter(Boolean)
      .join(" · ");
    passages.push({ doc_id: doc.id, title: doc.title || "Untitled", url: doc.canonical_url, source: doc.source, meta, text: text.slice(0, PASSAGE_CHARS) });
  }
  return passages;
}

/** Merge passages from the same document into one source, keeping first-seen order. */
export function groupByDoc(passages: Passage[]): Passage[] {
  const byDoc = new Map<string, Passage>();
  for (const p of passages) {
    const cur = byDoc.get(p.doc_id);
    if (cur) cur.text = `${cur.text}\n…\n${p.text}`;
    else byDoc.set(p.doc_id, { ...p });
  }
  return [...byDoc.values()];
}

export function buildAskPrompt(question: string, passages: Passage[], history: AskTurn[] = []): string {
  const sources = passages
    .map((p, i) => `[${i + 1}] ${p.title}${p.meta ? ` (${p.meta})` : ""}\n${p.text.trim()}`)
    .join("\n\n");
  // Earlier turns give a follow-up its meaning ("who owns it?"); the sources are still the only evidence.
  const earlier = history.length
    ? `Earlier in this conversation (context only; cite the sources below, not these answers):\n${history.map((t) => `Q: ${t.question}\nA: ${t.answer.replace(/\s*\[\d+\]/g, "")}`).join("\n\n")}\n\n`
    : "";
  return `${earlier}Question: ${question}\n\nSources:\n${sources}\n---\nAnswer the question using the sources above, citing them as [n].`;
}

/** At most the last four turns, trimmed, so a long conversation can't crowd out the sources. */
function cleanHistory(h: unknown): AskTurn[] {
  if (!Array.isArray(h)) return [];
  return h
    .filter((t): t is AskTurn => !!t && typeof t.question === "string" && typeof t.answer === "string")
    .slice(-4)
    .map((t) => ({ question: t.question.trim().slice(0, 500), answer: t.answer.trim().slice(0, 1500) }));
}

export async function ask(deps: SearchDeps & { chat: Chat }, req: AskRequest): Promise<AskResponse> {
  const started = performance.now();
  const question = typeof req.question === "string" ? req.question.trim() : "";
  if (!question) throw new AskError("question is required");
  if (question.length > 2000) throw new AskError("question is too long");

  let filters;
  try {
    filters = validateFilters(req.filters);
  } catch (e) {
    throw new AskError(e instanceof ValidationError ? e.message : String(e));
  }
  const history = cleanHistory(req.history);
  // A follow-up ("and who owns that?") is searched together with the question it follows.
  const searchQuestion = history.length ? `${history.at(-1)!.question} ${question}` : question;
  const passages = await retrievePassages(deps, { ...req, question: searchQuestion, filters });
  const base = { provider: deps.chat.provider, model: deps.chat.model };
  if (passages.length === 0) {
    return {
      ...base,
      answer: "I couldn't find anything in your documents about that. Try different words, or check that the relevant docs have been captured.",
      citations: [],
      took_ms: Math.round(performance.now() - started),
    };
  }

  // One numbered source per document (its passages joined), so citations never repeat a doc.
  const sources = groupByDoc(passages);
  const answer = await deps.chat.complete(ASK_SYSTEM, buildAskPrompt(question, sources, history));
  const citations: AskCitation[] = sources.map((p, i) => ({ n: i + 1, doc_id: p.doc_id, title: p.title, url: p.url, source: p.source, passage: p.text }));
  return { ...base, answer, citations, took_ms: Math.round(performance.now() - started) };
}
