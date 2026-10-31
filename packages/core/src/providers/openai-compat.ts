import type { Enrichment } from "@faber/shared";
import { ENRICHMENT_JSON_SCHEMA, coerceEnrichment } from "../enrich/schema";
import { SYSTEM_PROMPT, userPrompt } from "../enrich/prompt";
import { extractJsonObject, stripThinking, type Chat, type Embedder, type Enricher, type EnrichInput } from "./types";

interface Opts {
  model: string;
  baseUrl: string;
  apiKey?: string;
}

/**
 * Works with anything that speaks the OpenAI chat/embeddings wire format:
 * LM Studio, vLLM, llama.cpp server, OpenRouter, Groq, Together, Gemini's compat endpoint.
 */
async function post<T>(opts: Opts, path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${opts.baseUrl}${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export class OpenAICompatEnricher implements Enricher {
  readonly provider = "openai-compatible";
  readonly model: string;
  constructor(private opts: Opts) {
    this.model = opts.model;
  }

  async enrich(input: EnrichInput): Promise<Enrichment> {
    const res = await post<{ choices: { message: { content: string } }[] }>(this.opts, "/chat/completions", {
      model: this.model,
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: { name: "enrichment", schema: ENRICHMENT_JSON_SCHEMA, strict: true },
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(input) },
      ],
    });
    const content = res.choices[0]?.message.content ?? "";
    return coerceEnrichment(extractJsonObject(content));
  }
}

export class OpenAICompatEmbedder implements Embedder {
  readonly provider = "openai-compatible";
  readonly model: string;
  constructor(private opts: Opts) {
    this.model = opts.model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await post<{ data: { index: number; embedding: number[] }[] }>(this.opts, "/embeddings", {
      model: this.model,
      input: texts,
    });
    return res.data
      .sort((a, b) => a.index - b.index)
      .map((d) => Float32Array.from(d.embedding));
  }
}

export class OpenAICompatChat implements Chat {
  readonly provider = "openai-compatible";
  readonly model: string;
  constructor(private opts: Opts) {
    this.model = opts.model;
  }

  async complete(system: string, user: string): Promise<string> {
    const res = await post<{ choices: { message: { content: string } }[] }>(this.opts, "/chat/completions", {
      model: this.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return stripThinking(res.choices[0]?.message.content ?? "");
  }
}
