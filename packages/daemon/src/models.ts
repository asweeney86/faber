/**
 * Choosing models from the app (Settings → AI & Processing) or `faber models`: which local
 * models are in use, downloading a new one, switching to it without a restart, and
 * re-indexing documents for search after the embedding model changes.
 */
import { countNeedingEmbedding, hasModel, ollamaModels, type Config } from "@faber/core";
import { MODEL_CHOICES, sameModel, validModelName, type ModelChange, type ModelKind, type ModelsState, type ModelSlotState } from "@faber/shared";
import type { AppContext } from "./context";
import { pullModel } from "./install/ollama";

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";
export const ollamaBaseOf = (cfg: Config, kind: ModelKind) => cfg[kind].base_url ?? OLLAMA_DEFAULT;

export class ModelChangeError extends Error {}

type Pull = NonNullable<ModelsState["pull"]>;

export class ModelManager {
  private pull: Pull | null = null;

  /** `onChanged` runs after a switch, e.g. to start re-indexing. */
  constructor(
    private ctx: AppContext,
    private onChanged: (kind: ModelKind) => void = () => {},
  ) {}

  async state(): Promise<ModelsState> {
    const { cfg, db } = this.ctx;
    const installed = await ollamaModels(ollamaBaseOf(cfg, "enrich"));
    const slot = (kind: ModelKind): ModelSlotState => {
      const pc = cfg[kind];
      const local = pc.provider === "ollama";
      const has = (m: string) => (local ? hasModel(installed ?? [], m) : false);
      return {
        provider: pc.provider,
        model: pc.model,
        editable: local,
        installed: local ? has(pc.model) : true,
        choices: MODEL_CHOICES[kind].map((c) => ({ ...c, installed: has(c.id) })),
      };
    };
    const other = db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) n FROM enrichments e JOIN documents d ON d.id = e.doc_id WHERE e.is_current = 1 AND NOT (e.provider = ? AND e.model = ?)`,
      )
      .get(cfg.enrich.provider, cfg.enrich.model)!.n;
    return {
      enrich: slot("enrich"),
      embed: slot("embed"),
      ollama_reachable: installed !== null,
      pull: this.pull ? { ...this.pull } : null,
      reindex_remaining: countNeedingEmbedding(db, cfg.embed.model),
      summaries_from_other_models: other,
    };
  }

  /**
   * Switch a slot to `model`. Already downloaded: switches now. Otherwise the download
   * starts in the background and the switch happens when it finishes (watch `state().pull`).
   * Resolves once the switch or the download has started; `done` settles when it's all over.
   */
  async change(req: ModelChange): Promise<{ done: Promise<void> }> {
    const { cfg } = this.ctx;
    if (req?.kind !== "enrich" && req?.kind !== "embed") throw new ModelChangeError('kind must be "enrich" or "embed"');
    const model = typeof req.model === "string" ? req.model.trim() : "";
    if (!validModelName(model)) throw new ModelChangeError(`"${String(req.model)}" isn't an Ollama model name (like qwen3:4b)`);
    if (cfg[req.kind].provider !== "ollama") {
      throw new ModelChangeError(`${req.kind} uses ${cfg[req.kind].provider}; change it in config.toml`);
    }
    if (this.pull && !this.pull.error) throw new ModelChangeError(`Still downloading ${this.pull.model}; try again when it finishes`);
    if (sameModel(cfg[req.kind].model, model)) return { done: Promise.resolve() };

    const base = ollamaBaseOf(cfg, req.kind);
    const installed = await ollamaModels(base);
    if (!installed) throw new ModelChangeError(`Ollama isn't reachable at ${base}. Start it, then try again.`);
    if (hasModel(installed, model)) {
      this.apply(req.kind, model);
      return { done: Promise.resolve() };
    }

    const pull: Pull = { kind: req.kind, model, status: "starting download", completed: 0, total: 0, error: null };
    this.pull = pull;
    const done = pullModel(base, model, (p) => {
      pull.status = p.status;
      if (p.total) {
        pull.total = p.total;
        pull.completed = p.completed ?? 0;
      }
    }).then(
      () => {
        this.pull = null;
        this.apply(req.kind, model);
      },
      (err: unknown) => {
        pull.error = err instanceof Error ? err.message : String(err);
        pull.status = "failed";
      },
    );
    return { done };
  }

  /** Forget a failed download, so the error stops showing. */
  dismissPullError() {
    if (this.pull?.error) this.pull = null;
  }

  private apply(kind: ModelKind, model: string) {
    this.ctx.setModel(kind, model);
    this.onChanged(kind);
  }
}
