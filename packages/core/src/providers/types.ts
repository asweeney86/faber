import type { Enrichment } from "@faber/shared";

export interface EnrichInput {
  title: string;
  url: string;
  source: string;
  text: string;
  /** Context the model can use to resolve relative dates ("last quarter"). */
  first_seen_iso: string;
}

export interface Enricher {
  readonly provider: string;
  readonly model: string;
  enrich(input: EnrichInput): Promise<Enrichment>;
}

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  /**
   * Cosine similarity below which a semantic match is treated as noise. Depends
   * on the embedding model; overridable with search.min_semantic in config.
   */
  minSimilarity?: number;
  /** Returns one vector per input, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Free-text completion, used by Ask mode. */
export interface Chat {
  readonly provider: string;
  readonly model: string;
  complete(system: string, user: string): Promise<string>;
}

/** Thrown when config forbids a remote provider. */
export class RemoteProviderRefused extends Error {
  constructor(provider: string, target: string) {
    super(
      `Refusing to use remote provider "${provider}" (${target}) because privacy.allow_remote is false in config.toml`,
    );
    this.name = "RemoteProviderRefused";
  }
}

/** Pull the first JSON object out of a model reply that may include prose or code fences. */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Strip a leading <think>…</think> block some local reasoning models emit even when asked not to. */
export function stripThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "").trim();
}
