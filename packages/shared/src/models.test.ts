import { expect, test } from "bun:test";
import { DEFAULT_EMBED_MODEL, DEFAULT_ENRICH_MODEL, defaultMinSimilarity, MODEL_CHOICES, sameModel, validModelName } from "./models";

test("the defaults are the first (recommended) choices", () => {
  expect(MODEL_CHOICES.enrich[0]!.id).toBe(DEFAULT_ENRICH_MODEL);
  expect(MODEL_CHOICES.embed[0]!.id).toBe(DEFAULT_EMBED_MODEL);
});

test(":latest is the same model", () => {
  expect(sameModel("qwen3-embedding", "qwen3-embedding:latest")).toBe(true);
  expect(sameModel("qwen3-embedding", "qwen3-embedding:0.6b")).toBe(false);
});

test("Ollama model names are accepted; anything else isn't", () => {
  for (const ok of ["qwen3:4b", "llama3.2", "library/llama3.2:3b-instruct-q4_K_M", "hf.co/org/repo:Q4_K_M", "nomic-embed-text"]) expect(validModelName(ok)).toBe(true);
  for (const bad of ["", " qwen3", "rm -rf /", "../etc", "a:b:c", "x".repeat(200), 5, null]) expect(validModelName(bad)).toBe(false);
});

test("each embedding model gets its own similarity floor", () => {
  expect(defaultMinSimilarity("qwen3-embedding:0.6b")).toBe(0.47);
  expect(defaultMinSimilarity("qwen3-embedding")).toBe(0.48);
  expect(defaultMinSimilarity("nomic-embed-text")).toBe(0.48);
});
