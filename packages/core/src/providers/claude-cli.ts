import type { Enrichment } from "@faber/shared";
import { ENRICHMENT_JSON_SCHEMA, coerceEnrichment } from "../enrich/schema";
import { SYSTEM_PROMPT, userPrompt } from "../enrich/prompt";
import { extractJsonObject, type Chat, type Enricher, type EnrichInput } from "./types";

/**
 * Run the `claude` CLI in print mode, so a Claude Code subscription works as a
 * backend without a separate API key. Returns the reply text.
 */
async function runClaude(model: string, prompt: string): Promise<string> {
  const proc = Bun.spawn(["claude", "-p", "--model", model, "--output-format", "json"], {
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 5 * 60_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`claude CLI exited ${code}: ${stderr.slice(0, 300)}`);
  // --output-format json wraps the reply: {"result": "<text>", ...}
  try {
    const wrapped = JSON.parse(stdout) as { result?: string };
    if (typeof wrapped.result === "string") return wrapped.result;
  } catch {
    /* fall through: treat stdout as the raw reply */
  }
  return stdout;
}

export class ClaudeCliEnricher implements Enricher {
  readonly provider = "claude-cli";
  readonly model: string;
  constructor(opts: { model: string }) {
    this.model = opts.model || "sonnet";
  }

  async enrich(input: EnrichInput): Promise<Enrichment> {
    const prompt = [
      SYSTEM_PROMPT,
      "",
      "Respond with ONLY a JSON object matching this JSON Schema, no prose:",
      JSON.stringify(ENRICHMENT_JSON_SCHEMA),
      "",
      userPrompt(input),
    ].join("\n");
    return coerceEnrichment(extractJsonObject(await runClaude(this.model, prompt)));
  }
}

export class ClaudeCliChat implements Chat {
  readonly provider = "claude-cli";
  readonly model: string;
  constructor(opts: { model: string }) {
    this.model = opts.model || "sonnet";
  }

  async complete(system: string, user: string): Promise<string> {
    return (await runClaude(this.model, `${system}\n\n${user}`)).trim();
  }
}
