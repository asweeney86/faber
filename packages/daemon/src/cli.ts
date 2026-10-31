#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  providerProblems,
  approveExtension,
  listExtensions,
  recoverStaleJobs,
  removeExtension,
  ask,
  embedDoc,
  exportCollection,
  importCollection,
  listCollections,
  listProjects,
  enqueueEnrichment,
  getDocRow,
  importChromeHistory,
  listChromeProfiles,
  ollamaReachable,
  recordVisit,
  resolveProfile,
  runQueue,
  search,
  setContent,
  stats,
} from "@faber/core";
import type { SearchHit } from "@faber/shared";
import { AppContext } from "./context";
import { seedDemo } from "./demo";
import { startServer } from "./server";

const USAGE = `faber — local-first, AI-enriched bookmarks

  faber serve                          Start the daemon (HTTP API + background enrichment)
  faber status                         Counts, queue state, provider config
  faber import-chrome [--profile X]    Import docs.google.com visits from Chrome history
                     [--list] [--dry-run]
  faber add <url> [--file text.txt] [--title T]
                                    Add a document manually (optionally with its text)
  faber enrich [--limit N]             Run the enrichment queue now
  faber search <query> [--json]        Search (keyword + semantic)
            [--mode hybrid|keyword|semantic] [--limit N]
  faber ask <question>                 Answer a question from your documents, with citations
  faber collections                    List collections
  faber projects                       List projects as a tree (inferred, with your corrections)
  faber export <collection-id> [file]  Write a shareable collection file (URLs + notes, no doc text)
  faber import <file>                  Import a collection file
  faber extensions [approve|remove <id>]  List, approve or remove browser extensions allowed to use the API
  faber demo                           Load demo documents (try it with FABER_HOME=$(mktemp -d))
  faber reindex                        Re-embed every document with the configured embed model
  faber requeue                        Re-run enrichment for every document (after a model or prompt change)
  faber config                         Print the config file path

Config lives in ~/.faber/config.toml (override with FABER_HOME).
`;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** A positive integer flag, or undefined when absent; throws on junk like --limit abc. */
function intFlag(flags: Args["flags"], name: string): number | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function printHit(h: SearchHit, i: number) {
  const d = h.doc;
  const e = d.enrichment;
  const type = e ? e.doc_type : d.has_content ? "unenriched" : "no-content";
  console.log(`${String(i + 1).padStart(2)}. ${d.title || "(untitled)"}  [${type}]`);
  console.log(`    ${d.canonical_url}`);
  console.log(`    seen ${fmtDate(d.last_seen_at)} · ${d.visit_count}× · score ${h.score.toFixed(3)}`);
  if (e) {
    console.log(`    ${e.summary}`);
    const facets = [
      e.written_at ? `written ~${e.written_at}` : null,
      e.projects.length ? `projects: ${e.projects.join(", ")}` : null,
      e.people.length ? `people: ${e.people.join(", ")}` : null,
      e.tags.length ? `#${e.tags.join(" #")}` : null,
    ].filter(Boolean);
    if (facets.length) console.log(`    ${facets.join(" · ")}`);
  }
  if (h.snippet) console.log(`    …${h.snippet}…`);
  console.log();
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  if (cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) {
    console.log(USAGE);
    return;
  }

  const ctx = new AppContext();
  try {
    switch (cmd) {
      case "config":
        console.log(join(ctx.cfg.home, "config.toml"));
        break;

      case "status": {
        const s = stats(ctx.db);
        const ollamaUrl = ctx.cfg.embed.base_url ?? "http://127.0.0.1:11434";
        console.log(`db        ${ctx.cfg.db_path}`);
        console.log(`docs      ${s.docs} (${s.docs_with_content} with content, ${s.enriched} enriched)`);
        console.log(`queue     ${s.queue.pending} pending, ${s.queue.running} running, ${s.queue.error} failed`);
        console.log(`enrich    ${ctx.cfg.enrich.provider} / ${ctx.cfg.enrich.model}`);
        console.log(`embed     ${ctx.cfg.embed.provider} / ${ctx.cfg.embed.model}`);
        console.log(`ollama    ${(await ollamaReachable(ollamaUrl)) ? "reachable" : "NOT reachable"} at ${ollamaUrl}`);
        const { problems } = await providerProblems(ctx.cfg);
        for (const p of problems) console.log(`problem   ${p}`);
        console.log(`remote    ${ctx.cfg.privacy.allow_remote ? "allowed" : "blocked (privacy.allow_remote = false)"}`);
        break;
      }

      case "import-chrome": {
        const profiles = listChromeProfiles();
        if (flags.list) {
          for (const p of profiles) console.log(`${p.dir.padEnd(12)} ${p.name.padEnd(40)} ${p.account.padEnd(30)} last used ${fmtDate(p.lastUsed)}`);
          break;
        }
        const profile = resolveProfile(typeof flags.profile === "string" ? flags.profile : undefined, profiles);
        console.log(`Importing from Chrome profile "${profile.name}" (${profile.dir})`);
        const r = importChromeHistory(ctx.db, profile.historyPath, { dryRun: flags["dry-run"] === true });
        console.log(
          flags["dry-run"]
            ? `Would import ${r.visits} visits across ${r.docs_total} Google docs`
            : `Imported ${r.visits} visits; ${r.docs_created} new docs, ${r.docs_total} touched`,
        );
        if (!flags["dry-run"]) console.log(`Text for these docs is fetched by the browser extension as it runs.`);
        break;
      }

      case "add": {
        const url = positional[0];
        if (!url) throw new Error("usage: faber add <url> [--file text.txt] [--title T]");
        if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) throw new Error(`Not an http(s) URL: ${url}`);
        const { row, created } = recordVisit(ctx.db, { url, title: typeof flags.title === "string" ? flags.title : undefined, origin: "manual" });
        if (typeof flags.file === "string") {
          setContent(ctx.db, row.id, readFileSync(flags.file, "utf8"));
          console.log(`${created ? "Added" : "Updated"} ${row.id} with ${flags.file}; queued for enrichment`);
        } else {
          console.log(`${created ? "Added" : "Updated"} ${row.id}`);
        }
        break;
      }

      case "enrich": {
        recoverStaleJobs(ctx.db);
        const limit = intFlag(flags, "limit");
        const r = await runQueue(
          { db: ctx.db, cfg: ctx.cfg, enricher: ctx.enricher, embedder: ctx.embedder, index: ctx.index, log: console.log },
          { limit },
        );
        console.log(`Done: ${r.processed} enriched, ${r.failed} failed`);
        break;
      }

      case "search": {
        const q = positional.join(" ");
        const mode = typeof flags.mode === "string" ? flags.mode : "hybrid";
        if (mode !== "hybrid" && mode !== "keyword" && mode !== "semantic") throw new Error(`--mode must be hybrid, keyword or semantic`);
        const limit = intFlag(flags, "limit") ?? 10;
        const res = await search({ db: ctx.db, index: ctx.index, embedder: ctx.embedderOrNull }, { q, mode, limit });
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          res.hits.forEach(printHit);
          console.log(`${res.hits.length} hits in ${res.took_ms}ms`);
        }
        break;
      }

      case "ask": {
        const question = positional.join(" ");
        if (!question) throw new Error("usage: faber ask <question>");
        const res = await ask({ ...ctx.searchDeps, chat: ctx.chat }, { question });
        console.log(`${res.answer}\n`);
        // Show only the sources the answer cites, one line per document.
        const cited = new Set([...res.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
        const seen = new Set<string>();
        for (const c of res.citations) {
          if (!cited.has(c.n) || seen.has(c.doc_id)) continue;
          seen.add(c.doc_id);
          console.log(`[${c.n}] ${c.title}\n    ${c.url}`);
        }
        console.log(`\n${res.provider}/${res.model} · ${res.took_ms}ms`);
        break;
      }

      case "projects": {
        const all = listProjects(ctx.db);
        const ids = new Set(all.map((p) => p.id));
        const walk = (parent: string | null, depth: number) => {
          for (const p of all.filter((x) => (x.parent_id && ids.has(x.parent_id) ? x.parent_id : null) === parent)) {
            console.log(`${"  ".repeat(depth)}${p.name}  (${p.doc_count} docs${p.active ? ", active" : ""})  ${p.id}`);
            if (depth < 8) walk(p.id, depth + 1);
          }
        };
        if (all.length === 0) console.log("No projects yet.");
        walk(null, 0);
        break;
      }

      case "collections":
        for (const c of listCollections(ctx.db)) console.log(`${c.id}  ${c.name}  (${c.pin_count} pinned${c.query ? ", smart" : ""})`);
        break;

      case "export": {
        const id = positional[0];
        if (!id) throw new Error("usage: faber export <collection-id> [file]");
        const file = await exportCollection(ctx.searchDeps, id);
        if (!file) throw new Error(`No collection ${id}`);
        const json = JSON.stringify(file, null, 2);
        if (positional[1]) {
          writeFileSync(positional[1], json);
          console.log(`Wrote ${file.items.length} items to ${positional[1]}`);
        } else {
          console.log(json);
        }
        break;
      }

      case "import": {
        const path = positional[0];
        if (!path) throw new Error("usage: faber import <file>");
        let file;
        try {
          file = JSON.parse(readFileSync(path, "utf8"));
        } catch (e) {
          throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : e}`);
        }
        const r = await importCollection(ctx.searchDeps, file);
        console.log(`Imported ${r.items} items (${r.created_docs} new docs) into collection ${r.collection_id}`);
        break;
      }

      case "extensions": {
        const [action, id] = positional;
        if (action === "approve" && id) {
          if (!approveExtension(ctx.db, id)) throw new Error(`Not a valid extension id: ${id}`);
          console.log(`Approved ${id}`);
        } else if (action === "remove" && id) {
          console.log(removeExtension(ctx.db, id) ? `Removed ${id}` : `No extension ${id}`);
        } else if (action) {
          throw new Error("usage: faber extensions [approve|remove <id>]");
        } else {
          const list = listExtensions(ctx.db, ctx.cfg.daemon.allowed_extension_ids);
          if (list.length === 0) console.log("No extensions yet. Load the Faber extension and open its popup.");
          for (const e of list) {
            const seen = e.last_seen_at ? `last seen ${fmtDate(e.last_seen_at)}` : "never seen";
            console.log(`${e.id}  ${e.state.padEnd(8)}  ${seen}`);
          }
          if (list.some((e) => e.state === "pending")) console.log(`\nApprove with: faber extensions approve <id>`);
        }
        break;
      }

      case "demo": {
        if (stats(ctx.db).docs > 0) {
          throw new Error(`${ctx.cfg.db_path} already has documents. Run the demo in a fresh home: export FABER_HOME=$(mktemp -d)`);
        }
        const { problems } = await providerProblems(ctx.cfg);
        if (problems.length) {
          throw new Error(
            `${problems.join("\n")}\nOr try the demo offline: set provider = "fake" under [embed] and [enrich] in ${join(ctx.cfg.home, "config.toml")}.`,
          );
        }
        console.log(`Seeding demo documents into ${ctx.cfg.db_path}`);
        const r = await seedDemo(ctx, { log: console.log });
        console.log(`Loaded ${r.docs} docs and ${r.collections} collections. Run \`faber serve\` and open http://127.0.0.1:${ctx.cfg.daemon.port}`);
        break;
      }

      case "reindex": {
        const ids = ctx.db.query<{ id: string }, []>(`SELECT id FROM documents WHERE content IS NOT NULL`).all();
        console.log(`Re-embedding ${ids.length} docs with ${ctx.cfg.embed.model}`);
        let n = 0;
        for (const { id } of ids) {
          const row = getDocRow(ctx.db, id)!;
          const e = ctx.db.query<{ summary: string }, [string]>(`SELECT summary FROM enrichments WHERE doc_id = ? AND is_current = 1`).get(id);
          await embedDoc({ db: ctx.db, cfg: ctx.cfg, embedder: ctx.embedder, index: ctx.index }, id, e?.summary);
          if (++n % 25 === 0) console.log(`  ${n}/${ids.length} ${row.title}`);
        }
        console.log(`Done`);
        break;
      }

      case "requeue": {
        // Push every doc with content back through enrichment, bypassing the same-content shortcut.
        const ids = ctx.db.query<{ id: string }, []>(`SELECT id FROM documents WHERE content IS NOT NULL`).all();
        for (const { id } of ids) enqueueEnrichment(ctx.db, id, undefined, { force: true });
        console.log(`Requeued ${ids.length} docs`);
        break;
      }

      case "serve": {
        const server = startServer(ctx);
        console.log(`Faber daemon on http://${server.hostname}:${server.port}`);
        console.log(`enrich: ${ctx.cfg.enrich.provider}/${ctx.cfg.enrich.model}   embed: ${ctx.cfg.embed.provider}/${ctx.cfg.embed.model}`);
        await new Promise(() => {});
        break;
      }

      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== "serve") ctx.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
