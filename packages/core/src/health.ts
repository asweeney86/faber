import type { Config, ProviderConfig } from "./config";
import { askConfig, makeChat, makeEmbedder, makeEnricher } from "./providers";

export interface ProviderHealth {
  ok: boolean;
  /** Human-readable problem, when not ok. */
  problem?: string;
}

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";
let cache: { at: number; value: Record<string, ProviderHealth> } | null = null;

/** Forget cached health, e.g. after the models changed. */
export function resetProviderHealth() {
  cache = null;
}

export async function ollamaModels(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const j = (await res.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  } catch {
    return null;
  }
}

/** "qwen3-embedding" is pulled as "qwen3-embedding:latest". */
export function hasModel(models: string[], wanted: string): boolean {
  return models.some((m) => m === wanted || m === `${wanted}:latest` || m.replace(/:latest$/, "") === wanted);
}

async function check(pc: ProviderConfig): Promise<ProviderHealth> {
  if (pc.provider !== "ollama") return { ok: true };
  const base = pc.base_url ?? OLLAMA_DEFAULT;
  const models = await ollamaModels(base);
  if (!models) return { ok: false, problem: `Ollama isn't reachable at ${base}. Start it with \`brew services start ollama\` (or \`ollama serve\`).` };
  if (!hasModel(models, pc.model)) return { ok: false, problem: `Ollama doesn't have "${pc.model}". Run \`ollama pull ${pc.model}\`.` };
  return { ok: true };
}

/**
 * Whether each configured provider can actually be used right now: for Ollama,
 * that the server answers and the model is pulled. Cached briefly because the
 * web UI polls status every few seconds.
 */
export async function providerHealth(cfg: Config, maxAgeMs = 10_000): Promise<Record<"embed" | "enrich" | "ask", ProviderHealth>> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value as Record<"embed" | "enrich" | "ask", ProviderHealth>;
  const [embed, enrich, ask] = await Promise.all([check(cfg.embed), check(cfg.enrich), check(askConfig(cfg))]);
  const value = { embed, enrich, ask };
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Every reason a provider can't be used: config refusing it (e.g. a remote provider
 * with allow_remote = false, or one that can't embed) plus live Ollama health.
 */
export async function providerProblems(cfg: Config): Promise<{ problems: string[]; embedOk: boolean; enrichOk: boolean }> {
  const problems: string[] = [];
  const build = (make: () => unknown) => {
    try {
      make();
      return true;
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  const embedBuilt = build(() => makeEmbedder(cfg));
  const enrichBuilt = build(() => makeEnricher(cfg));
  build(() => makeChat(cfg));
  const health = await providerHealth(cfg);
  for (const h of [health.embed, health.enrich, health.ask]) if (h.problem) problems.push(h.problem);
  return { problems: [...new Set(problems)], embedOk: embedBuilt && health.embed.ok, enrichOk: enrichBuilt && health.enrich.ok };
}
