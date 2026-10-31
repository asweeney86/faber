import { defaultConfig, type Config } from "../src/config";
import { openDatabase } from "../src/db";
import { FakeChat, FakeEmbedder, FakeEnricher } from "../src/providers/fake";
import { runQueue } from "../src/enrich/run";
import { VectorIndex } from "../src/search/vectors";
import { recordVisit, setContent } from "../src/docs";

export function testConfig(overrides: Partial<Config> = {}): Config {
  const cfg = defaultConfig("/tmp/faber-test-home");
  cfg.db_path = ":memory:";
  cfg.embed = { provider: "fake", model: "fake-embed" };
  cfg.enrich = { provider: "fake", model: "fake-enrich" };
  return { ...cfg, ...overrides };
}

export function testEnv() {
  const cfg = testConfig();
  const db = openDatabase(":memory:");
  const embedder = new FakeEmbedder();
  const enricher = new FakeEnricher();
  const chat = new FakeChat();
  const index = new VectorIndex(embedder.model);
  const deps = { db, cfg, enricher, embedder, index };
  return {
    ...deps,
    chat,
    searchDeps: { db, index, embedder },
    /** Add a doc with text and (optionally) enrich it. */
    async addDoc(url: string, title: string, text: string, opts: { ts?: number; enrich?: boolean } = {}) {
      const { row } = recordVisit(db, { url, title, ts: opts.ts });
      setContent(db, row.id, text, { title });
      if (opts.enrich !== false) await runQueue(deps);
      return row.id;
    },
  };
}

export const gdocUrl = (n: number | string) => `https://docs.google.com/document/d/1TestDoc${String(n).padStart(4, "0")}abcdefghijklmnopq/edit`;
