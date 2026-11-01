import {
  askConfig,
  loadConfig,
  makeChat,
  makeEmbedder,
  makeEnricher,
  openDatabase,
  resetProviderHealth,
  setConfigValue,
  VectorIndex,
  type Chat,
  type Config,
  type Embedder,
  type Enricher,
  type SearchDeps,
} from "@faber/core";
import type { Database } from "bun:sqlite";
import type { ModelKind } from "@faber/shared";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Everything a command or request handler needs. Providers are built lazily so `faber status` works without Ollama. */
export class AppContext {
  readonly cfg: Config;
  readonly db: Database;
  private _enricher: Enricher | null = null;
  private _embedder: Embedder | null = null;
  private _chat: Chat | null = null;
  private _index: VectorIndex | null = null;

  constructor(cfg: Config = loadConfig()) {
    this.cfg = cfg;
    this.db = openDatabase(cfg.db_path);
  }

  get enricher(): Enricher {
    return (this._enricher ??= makeEnricher(this.cfg));
  }

  get embedder(): Embedder {
    return (this._embedder ??= makeEmbedder(this.cfg));
  }

  get chat(): Chat {
    return (this._chat ??= makeChat(this.cfg));
  }

  /** The embedder, or null when config forbids it. Search then degrades to keyword-only. */
  get embedderOrNull(): Embedder | null {
    try {
      return this.embedder;
    } catch {
      return null;
    }
  }

  get index(): VectorIndex {
    if (!this._index) {
      this._indexSig = this.chunkSignature();
      this._index = VectorIndex.load(this.db, this.cfg.embed.model);
    }
    return this._index;
  }

  private _indexSig = "";

  private chunkSignature(): string {
    const r = this.db
      .query<{ n: number; m: number | null }, [string]>(`SELECT COUNT(*) n, MAX(id) m FROM chunks WHERE embed_model = ?`)
      .get(this.cfg.embed.model)!;
    return `${r.n}:${r.m ?? 0}`;
  }

  /**
   * Reload the in-memory vector index if chunks changed underneath it — e.g. a
   * separate `faber enrich` or `faber reindex` process wrote to the database.
   */
  syncIndex(): boolean {
    if (!this._index) return false;
    const sig = this.chunkSignature();
    if (sig === this._indexSig) return false;
    this._index = null;
    void this.index;
    return true;
  }

  /** Call after this process changed chunks itself, so syncIndex doesn't reload needlessly. */
  noteIndexWrite() {
    this._indexSig = this.chunkSignature();
  }

  get searchDeps(): SearchDeps {
    return { db: this.db, index: this.index, embedder: this.embedderOrNull };
  }

  /**
   * Use another model from now on: saved to config.toml (so it survives restarts) and
   * swapped in without a restart. Jobs already running finish with the old model.
   */
  setModel(kind: ModelKind, model: string) {
    const path = join(this.cfg.home, "config.toml");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, setConfigValue(text, kind, "model", model));
    renameSync(tmp, path);
    this.cfg[kind].model = model;
    if (kind === "enrich") {
      this._enricher = null;
      if (!this.cfg.ask) this._chat = null; // Ask follows the enrich model unless configured
    } else {
      this._embedder = null;
      // The index holds one model's vectors; the new one starts empty and fills as docs re-embed.
      this._index = null;
    }
    resetProviderHealth();
  }

  describeProviders() {
    const ask = askConfig(this.cfg);
    return {
      enrich: `${this.cfg.enrich.provider}/${this.cfg.enrich.model}`,
      embed: `${this.cfg.embed.provider}/${this.cfg.embed.model}`,
      ask: `${ask.provider}/${ask.model}`,
    };
  }

  close() {
    this.db.close();
  }
}
