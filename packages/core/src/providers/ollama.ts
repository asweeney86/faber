import type { Enrichment } from "@faber/shared";
import { ENRICHMENT_JSON_SCHEMA, coerceEnrichment } from "../enrich/schema";
import { SYSTEM_PROMPT, userPrompt } from "../enrich/prompt";
import { stripThinking, type Chat, type Embedder, type Enricher, type EnrichInput } from "./types";

interface OllamaOpts {
  model: string;
  baseUrl: string;
}

/** Local models can be slow to load and generate; give up eventually so the queue never wedges. */
const TIMEOUT_MS = 5 * 60_000;

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export class OllamaEnricher implements Enricher {
  readonly provider = "ollama";
  readonly model: string;
  private baseUrl: string;

  constructor(opts: OllamaOpts) {
    this.model = opts.model;
    this.baseUrl = opts.baseUrl;
  }

  async enrich(input: EnrichInput): Promise<Enrichment> {
    const res = await post<{ message: { content: string } }>(this.baseUrl, "/api/chat", {
      model: this.model,
      stream: false,
      // Qwen3 "thinks" by default; it is slow and unnecessary for extraction.
      think: false,
      format: ENRICHMENT_JSON_SCHEMA,
      options: { temperature: 0.1, num_ctx: 16384 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(input) },
      ],
    });
    return coerceEnrichment(JSON.parse(res.message.content));
  }
}

export class OllamaEmbedder implements Embedder {
  readonly provider = "ollama";
  readonly model: string;
  private baseUrl: string;

  constructor(opts: OllamaOpts) {
    this.model = opts.model;
    this.baseUrl = opts.baseUrl;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await post<{ embeddings: number[][] }>(this.baseUrl, "/api/embed", {
      model: this.model,
      input: texts,
    });
    return res.embeddings.map((e) => Float32Array.from(e));
  }
}

/** True if an Ollama server answers at baseUrl. */
export async function ollamaReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export class OllamaChat implements Chat {
  readonly provider = "ollama";
  readonly model: string;
  private baseUrl: string;

  constructor(opts: OllamaOpts) {
    this.model = opts.model;
    this.baseUrl = opts.baseUrl;
  }

  async complete(system: string, user: string): Promise<string> {
    const res = await post<{ message: { content: string } }>(this.baseUrl, "/api/chat", {
      model: this.model,
      stream: false,
      think: false,
      options: { temperature: 0.2, num_ctx: 16384 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return stripThinking(res.message.content);
  }
}
