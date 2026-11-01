import { defaultMinSimilarity } from "@faber/shared";
import { isLocalUrl, resolveApiKey, type Config, type ProviderConfig } from "../config";
import { AnthropicChat, AnthropicEnricher } from "./anthropic";
import { ClaudeCliChat, ClaudeCliEnricher } from "./claude-cli";
import { FakeChat, FakeEmbedder, FakeEnricher } from "./fake";
import { OllamaChat, OllamaEmbedder, OllamaEnricher } from "./ollama";
import { OpenAICompatChat, OpenAICompatEmbedder, OpenAICompatEnricher } from "./openai-compat";
import { RemoteProviderRefused, type Chat, type Embedder, type Enricher } from "./types";

export * from "./types";
export { ollamaReachable } from "./ollama";
export { FakeChat, FakeEmbedder, FakeEnricher } from "./fake";

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

/** Where a provider would send document text, for the privacy check and error messages. */
function targetOf(pc: ProviderConfig): { target: string; local: boolean } {
  switch (pc.provider) {
    case "ollama": {
      const url = pc.base_url ?? OLLAMA_DEFAULT;
      return { target: url, local: isLocalUrl(url) };
    }
    case "openai-compatible":
      return { target: pc.base_url ?? "(no base_url)", local: isLocalUrl(pc.base_url) };
    case "anthropic":
      return { target: "api.anthropic.com", local: false };
    case "claude-cli":
      return { target: "claude CLI", local: false };
    case "fake":
      return { target: "in-process", local: true };
    default:
      return { target: "unknown", local: false };
  }
}

function guardRemote(cfg: Config, pc: ProviderConfig) {
  if (cfg.privacy.allow_remote) return;
  const { target, local } = targetOf(pc);
  if (!local) throw new RemoteProviderRefused(pc.provider, target);
}

function requireBaseUrl(pc: ProviderConfig, section: string): string {
  if (!pc.base_url) throw new Error(`${section}.base_url is required for openai-compatible`);
  return pc.base_url;
}

export function makeEnricher(cfg: Config): Enricher {
  const pc = cfg.enrich;
  guardRemote(cfg, pc);
  switch (pc.provider) {
    case "ollama":
      return new OllamaEnricher({ model: pc.model, baseUrl: pc.base_url ?? OLLAMA_DEFAULT });
    case "openai-compatible":
      return new OpenAICompatEnricher({ model: pc.model, baseUrl: requireBaseUrl(pc, "enrich"), apiKey: resolveApiKey(pc.api_key) });
    case "anthropic":
      return new AnthropicEnricher({ model: pc.model, apiKey: resolveApiKey(pc.api_key) });
    case "claude-cli":
      return new ClaudeCliEnricher({ model: pc.model });
    case "fake":
      return new FakeEnricher(pc.model);
    default:
      throw new Error(`Unknown enrich provider: ${String(pc.provider)}`);
  }
}

export function makeEmbedder(cfg: Config): Embedder {
  const e = buildEmbedder(cfg);
  // Tuned per model (packages/shared/src/models.ts); config can override.
  e.minSimilarity = cfg.search.min_semantic ?? e.minSimilarity ?? defaultMinSimilarity(cfg.embed.model);
  return e;
}

function buildEmbedder(cfg: Config): Embedder {
  const pc = cfg.embed;
  guardRemote(cfg, pc);
  switch (pc.provider) {
    case "ollama":
      return new OllamaEmbedder({ model: pc.model, baseUrl: pc.base_url ?? OLLAMA_DEFAULT });
    case "openai-compatible":
      return new OpenAICompatEmbedder({ model: pc.model, baseUrl: requireBaseUrl(pc, "embed"), apiKey: resolveApiKey(pc.api_key) });
    case "fake":
      return new FakeEmbedder(pc.model);
    default:
      throw new Error(`Provider "${pc.provider}" cannot produce embeddings; use ollama, openai-compatible or fake`);
  }
}

export function askConfig(cfg: Config): ProviderConfig {
  return cfg.ask ?? cfg.enrich;
}

export function makeChat(cfg: Config): Chat {
  const pc = askConfig(cfg);
  guardRemote(cfg, pc);
  switch (pc.provider) {
    case "ollama":
      return new OllamaChat({ model: pc.model, baseUrl: pc.base_url ?? OLLAMA_DEFAULT });
    case "openai-compatible":
      return new OpenAICompatChat({ model: pc.model, baseUrl: requireBaseUrl(pc, "ask"), apiKey: resolveApiKey(pc.api_key) });
    case "anthropic":
      return new AnthropicChat({ model: pc.model, apiKey: resolveApiKey(pc.api_key) });
    case "claude-cli":
      return new ClaudeCliChat({ model: pc.model });
    case "fake":
      return new FakeChat(pc.model);
    default:
      throw new Error(`Unknown ask provider: ${String(pc.provider)}`);
  }
}
