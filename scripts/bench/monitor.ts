#!/usr/bin/env bun
/**
 * Watch a daemon while it indexes: every --every seconds, record the library size, how many
 * documents are summarised and embedded, the queue, and how long a search takes right then
 * (so we see search latency under indexing load). Appends JSON lines to <out>/progress.jsonl.
 *
 *   bun scripts/bench/monitor.ts [--daemon URL] [--every 20] [--until-idle]
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    daemon: { type: "string", default: "http://127.0.0.1:7777" },
    every: { type: "string", default: "20" },
    out: { type: "string", default: join(homedir(), ".faber", "bench") },
    "until-idle": { type: "boolean", default: false },
  },
});
const DAEMON = values.daemon!.replace(/\/$/, "");
mkdirSync(values.out!, { recursive: true });
const file = join(values.out!, "progress.jsonl");
const PROBES = ["climate policy", "artificial intelligence regulation", "election results", "space telescope discovery", "interest rates inflation"];

let idleTicks = 0;
for (let tick = 0; ; tick++) {
  const t0 = performance.now();
  const status = (await (await fetch(`${DAEMON}/api/status`)).json()) as { docs: number; enriched: number; queue: { pending: number; running: number; error: number } };
  const models = (await (await fetch(`${DAEMON}/api/models`)).json()) as { reindex_remaining: number };
  const q = PROBES[tick % PROBES.length]!;
  const s0 = performance.now();
  const r = (await (
    await fetch(`${DAEMON}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: `${q} ${tick}`, limit: 20 }) })
  ).json()) as { took_ms: number; semantic: boolean };
  const row = {
    at: new Date().toISOString(),
    docs: status.docs,
    enriched: status.enriched,
    pending: status.queue.pending,
    running: status.queue.running,
    errors: status.queue.error,
    unembedded: models.reindex_remaining,
    search_ms: Math.round(performance.now() - s0),
    search_server_ms: r.took_ms,
    semantic: r.semantic,
    status_ms: Math.round(s0 - t0),
  };
  appendFileSync(file, `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
  idleTicks = status.queue.pending + status.queue.running === 0 ? idleTicks + 1 : 0;
  if (values["until-idle"] && idleTicks >= 3) break;
  await Bun.sleep(Number(values.every) * 1000);
}
