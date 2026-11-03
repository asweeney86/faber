#!/usr/bin/env bun
/**
 * Compare benchmark runs side by side (every results-*.json and ui-*.json in the bench dir),
 * plus indexing throughput from progress.jsonl. Markdown on stdout.
 *
 *   bun scripts/bench/report.ts [--out ~/.faber/bench]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { out: { type: "string", default: join(homedir(), ".faber", "bench") } } });
const OUT = values.out!;
type Stat = { p50: number; p90: number; p99: number; max: number };
type Recall = { n: number; hit1: number; hit3: number; hit10: number; mrr: number };
interface Result {
  label: string;
  status: { docs: number; enriched: number };
  latency: Record<string, { wall?: Stat } & Partial<Stat>>;
  recall: { by_mode: Record<string, Record<string, Recall>> };
}

const runs: Result[] = readdirSync(OUT)
  .filter((f) => /^results-.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(OUT, f), "utf8")));

const pct = (x: number) => `${Math.round(x * 100)}%`;
const lines: string[] = [];
const table = (head: string[], rows: (string | number)[][]) => {
  lines.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), "");
};

lines.push("## Search latency (ms, wall clock from the client)", "");
table(
  ["run", "docs / enriched", "hybrid cold p50 / p90", "keyword p50", "semantic cold p50", "hybrid warm p50", "while typing p50 / p90", "browse", "facets (query)"],
  runs.map((r) => {
    const L = r.latency;
    const w = (k: string) => L[k]?.wall;
    return [
      r.label,
      `${r.status.docs} / ${r.status.enriched}`,
      `${w("search_hybrid_cold")?.p50} / ${w("search_hybrid_cold")?.p90}`,
      `${w("search_keyword_cold")?.p50}`,
      `${w("search_semantic_cold")?.p50}`,
      `${w("search_hybrid_warm")?.p50}`,
      `${w("search_while_typing")?.p50} / ${w("search_while_typing")?.p90}`,
      `${L.browse_frequent?.p50}`,
      `${L.facets_query?.p50}`,
    ];
  }),
);

lines.push("## Recall: is the page you mean the first result?", "");
for (const r of runs) {
  lines.push(`**${r.label}** (${r.status.docs} docs, ${r.status.enriched} enriched)`, "");
  table(
    ["mode", "title hit@1", "gist hit@1", "detail hit@1", "all hit@1", "all hit@3", "all hit@10", "all MRR"],
    Object.entries(r.recall.by_mode).map(([mode, k]) => [mode, pct(k.title!.hit1), pct(k.gist!.hit1), pct(k.detail!.hit1), pct(k.all!.hit1), pct(k.all!.hit3), pct(k.all!.hit10), k.all!.mrr.toFixed(2)]),
  );
}

const progress = join(OUT, "progress.jsonl");
if (existsSync(progress)) {
  const rows = readFileSync(progress, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { at: string; enriched: number; pending: number; search_ms: number });
  const busy = rows.filter((r) => r.pending > 0);
  if (busy.length > 1) {
    const a = busy[0]!;
    const b = busy[busy.length - 1]!;
    const mins = (Date.parse(b.at) - Date.parse(a.at)) / 60_000;
    const done = b.enriched - a.enriched;
    const s = busy.map((r) => r.search_ms).sort((x, y) => x - y);
    lines.push(
      "## Indexing",
      "",
      `${done} documents summarised and embedded in ${mins.toFixed(0)} min: ${(done / mins).toFixed(1)} docs/min, ${((mins * 60) / Math.max(1, done)).toFixed(1)} s/doc.`,
      `Search while indexing: p50 ${s[Math.floor(s.length / 2)]} ms, p90 ${s[Math.floor(s.length * 0.9)]} ms, max ${s[s.length - 1]} ms.`,
      "",
    );
  }
}
console.log(lines.join("\n"));
