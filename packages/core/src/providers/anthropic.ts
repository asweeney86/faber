import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Enrichment } from "@faber/shared";
import { EnrichmentSchema, coerceEnrichment } from "../enrich/schema";
import { SYSTEM_PROMPT, userPrompt } from "../enrich/prompt";
import type { Chat, Enricher, EnrichInput } from "./types";

function makeClient(apiKey?: string): Anthropic {
  // With no apiKey the SDK reads ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) from the environment.
  return apiKey ? new Anthropic({ apiKey, timeout: 5 * 60_000 }) : new Anthropic({ timeout: 5 * 60_000 });
}

export class AnthropicEnricher implements Enricher {
  readonly provider = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(opts: { model: string; apiKey?: string }) {
    this.model = opts.model;
    this.client = makeClient(opts.apiKey);
  }

  async enrich(input: EnrichInput): Promise<Enrichment> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 8000,
      output_config: { format: zodOutputFormat(EnrichmentSchema), effort: "low" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt(input) }],
    });
    if (response.stop_reason === "refusal") throw new Error("Anthropic refused the request");
    if (!response.parsed_output) throw new Error("Anthropic returned no parsable output");
    return coerceEnrichment(response.parsed_output);
  }
}

export class AnthropicChat implements Chat {
  readonly provider = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(opts: { model: string; apiKey?: string }) {
    this.model = opts.model;
    this.client = makeClient(opts.apiKey);
  }

  async complete(system: string, user: string): Promise<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      system,
      messages: [{ role: "user", content: user }],
    });
    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") throw new Error("Anthropic refused the request");
    return response.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
  }
}
