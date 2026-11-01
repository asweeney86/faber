/**
 * The local (Ollama) models Faber offers, for `faber setup`, `faber models` and
 * Settings → AI & Processing. Any other Ollama model can be chosen by name too.
 *
 * Timings are from an M1 Max: a typical document is summarised in 5–10 s by
 * qwen3:4b and about twice that by qwen3:8b. Embedding a long document takes about
 * 1.5 s with qwen3-embedding:0.6b and about 23 s with the full qwen3-embedding (8B).
 */

export type ModelKind = "enrich" | "embed";

export interface ModelChoice {
  id: string;
  label: string;
  detail: string;
  /** Download size, roughly. */
  size_gb: number;
}

export const DEFAULT_ENRICH_MODEL = "qwen3:4b";
export const DEFAULT_EMBED_MODEL = "qwen3-embedding:0.6b";

export const MODEL_CHOICES: Record<ModelKind, ModelChoice[]> = {
  enrich: [
    { id: "qwen3:4b", label: "Fast", detail: "Summarises a typical document in 5–10 seconds. Recommended.", size_gb: 2.5 },
    { id: "qwen3:8b", label: "Thorough", detail: "A little more detail in summaries and tags, about twice as slow. Needs 16 GB of memory.", size_gb: 5.2 },
  ],
  embed: [
    { id: "qwen3-embedding:0.6b", label: "Fast", detail: "Indexes a document for search in about a second. Recommended.", size_gb: 0.6 },
    { id: "qwen3-embedding", label: "Most accurate", detail: "Tells related and unrelated documents apart more cleanly, but indexes about 15× slower.", size_gb: 4.7 },
  ],
};

/** "qwen3-embedding" and "qwen3-embedding:latest" are the same model. */
export function sameModel(a: string, b: string): boolean {
  const n = (m: string) => m.trim().replace(/:latest$/, "");
  return n(a) === n(b);
}

/** An Ollama model name: "qwen3:4b", "library/llama3.2:3b-instruct-q4_K_M", "hf.co/org/repo:tag". */
export function validModelName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 120 && /^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$/i.test(name);
}

/**
 * The similarity floor for semantic matches, per embedding model, tuned on the demo docs:
 * the full qwen3-embedding puts off-topic queries at ≤0.34 and relevant ones at ≥0.48;
 * the 0.6B model is tighter (off-topic up to 0.46, relevant from 0.45).
 */
export function defaultMinSimilarity(embedModel: string): number {
  if (sameModel(embedModel, "qwen3-embedding:0.6b")) return 0.47;
  return 0.48;
}
