#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { ConfigError, configHome, DatabaseTooNewError } from "@faber/core";
import { sameModel, type ModelKind, type ModelsState, type SearchHit } from "@faber/shared";
import { ModelManager } from "./models";
import { AppContext } from "./context";
import { seedDemo } from "./demo";
import { startServer } from "./server";
import { VERSION } from "./version";
import { syncExtension, syncLauncher } from "./install/assets";
import { detectLayout, extensionInstallPath, launcherInstallPath } from "./install/layout";
import { installService, restartService, serviceKind, uninstallService, UPGRADE_EXIT_CODE } from "./install/service";
import { quitLauncher, realHost, runDoctor, runSetup, runUninstall, terminalIo } from "./install/setup";
import { watchForUpgrade } from "./install/upgrade-watch";

const USAGE = `faber ${VERSION} — a local-first memory for the documents you open at work

  faber setup [--yes]                  Set everything up (AI models, background service,
                                       extension, launcher). Safe to run again. Skip parts
                                       with --no-ai, --no-service, --no-extension,
                                       --no-launcher; --no-open opens nothing.
  faber doctor                         Check the install and say how to fix what's wrong
  faber service [install|restart|uninstall]
                                       Manage the background service
  faber uninstall [--purge]            Remove the service, launcher and extension copy
                                       (--purge also deletes your data)
  faber serve                          Start the daemon (HTTP API + background enrichment)
  faber status                         Counts, queue state, provider config
  faber import-chrome [--profile X]    Import docs.google.com visits from Chrome history
                     [--list] [--dry-run]
  faber add <url> [--file text.txt] [--title T]
                                       Add a document by hand (optionally with its text)
  faber enrich [--limit N]             Run the enrichment queue now
  faber search <query> [--json]        Search (keyword + semantic)
            [--mode hybrid|keyword|semantic] [--limit N]
  faber ask <question>                 Answer a question from your documents, with citations
  faber collections                    List collections
  faber projects                       List projects as a tree (inferred, with your corrections)
  faber export <collection-id> [file]  Write a shareable collection file (URLs + notes, no doc text)
  faber import <file>                  Import a collection file
  faber extensions [approve|remove <id>]
                                       List, approve or remove extensions allowed to use the API
  faber demo                           Load demo documents (try it with FABER_HOME=$(mktemp -d))
  faber models [enrich|embed <model>]  Show the AI models in use, or switch one (downloads it if needed)
  faber reindex                        Re-embed every document with the configured embed model
  faber requeue                        Re-run enrichment for every document (after a model or prompt change)
  faber config                         Print the config file path
  faber version                        Print the version

Config lives in ${process.env.FABER_HOME ? `${process.env.FABER_HOME}/config.toml (FABER_HOME)` : "~/.faber/config.toml (override with FABER_HOME)"}.
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
    if (a === "-y") {
      flags.yes = true;
    } else if (a.startsWith("--")) {
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
  if (h.snippet) console.log(`    …${h.snippet.replace(/\s+/g, " ").replace(/^…|…$/g, "").trim()}…`);
  console.log();
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  if (cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) {
    console.log(USAGE);
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }

  if (cmd === "config") {
    console.log(join(configHome(), "config.toml"));
    return;
  }
  let ctx: AppContext;
  try {
    ctx = new AppContext();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // A broken config.toml stops everything; say exactly that, and how to get going again.
    const where = join(configHome(), "config.toml");
    console.error(`${cmd === "doctor" ? "  ✗ " : ""}Faber can't read its config: ${err.message}`);
    console.error(`  Fix that line in ${where}, or move the file aside and Faber writes a fresh default.`);
    process.exitCode = 1;
    return;
  }
  try {
    switch (cmd) {
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
        // Read the file first, so a typo in its name doesn't leave an empty document behind.
        let text: string | null = null;
        if (typeof flags.file === "string") {
          if (!existsSync(flags.file)) throw new Error(`No such file: ${flags.file}`);
          text = readFileSync(flags.file, "utf8");
        }
        const { row, created } = recordVisit(ctx.db, { url, title: typeof flags.title === "string" ? flags.title : undefined, origin: "manual" });
        if (text !== null && typeof flags.file === "string") {
          setContent(ctx.db, row.id, text);
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
        const q = positional.join(" ").trim();
        if (!q) throw new Error('usage: faber search <query> [--mode hybrid|keyword|semantic] [--limit N] [--json]');
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
        if (!existsSync(path)) throw new Error(`No such file: ${path}`);
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

      case "models": {
        const [kind, model] = positional;
        if (kind === undefined) {
          printModels((await daemonModels(ctx)) ?? (await new ModelManager(ctx).state()));
          break;
        }
        if ((kind !== "enrich" && kind !== "embed") || !model) throw new Error("Usage: faber models [enrich|embed <model>]   e.g. faber models enrich qwen3:8b");
        const after = await switchModel(ctx, kind, model);
        const slot = after[kind];
        if (!sameModel(slot.model, model)) throw new Error(after.pull?.error ?? `Couldn't switch to ${model}`);
        console.log(`✓ ${kind === "enrich" ? "Summaries now use" : "Search now uses"} ${slot.model}`);
        if (kind === "embed" && after.reindex_remaining > 0) {
          console.log(`  ${after.reindex_remaining} documents will be re-indexed in the background while the daemon runs (keyword search works meanwhile).`);
        }
        if (kind === "enrich" && after.summaries_from_other_models > 0) {
          console.log(`  New documents use it. To redo the ${after.summaries_from_other_models} existing summaries: Settings → AI & Processing, or faber requeue.`);
        }
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
        const layout = detectLayout();
        syncInstalledCopies(layout, ctx.cfg.home);
        let server: ReturnType<typeof startServer> | null = null;
        // As a service, the previous daemon may still be letting go of the port: give it a moment.
        for (let attempt = 0; !server; attempt++) {
          try {
            server = startServer(ctx);
          } catch (err) {
            if (process.env.FABER_SERVICE === "1" && attempt < 20) {
              await Bun.sleep(500);
              continue;
            }
            throw new ServeError(await explainServeFailure(ctx.cfg, err));
          }
        }
        console.log(`Faber ${VERSION} is running. Open http://${server.hostname}:${server.port} (Ctrl-C to stop)`);
        console.log(`enrich: ${ctx.cfg.enrich.provider}/${ctx.cfg.enrich.model}   embed: ${ctx.cfg.embed.provider}/${ctx.cfg.embed.model}`);
        let stopping = false;
        const shutdown = (code: number) => {
          if (stopping) return;
          stopping = true;
          server.stop(true);
          ctx.close();
          process.exit(code);
        };
        process.on("SIGTERM", () => shutdown(0));
        process.on("SIGINT", () => shutdown(0));
        if (layout.compiled) {
          const asService = process.env.FABER_SERVICE === "1";
          watchForUpgrade(layout.command[0]!, (e) => {
            if (!asService) {
              console.error(`Faber was ${e.kind === "replaced" ? "updated" : "removed"} on disk; restart \`faber serve\` to use the new version.`);
            } else if (e.kind === "replaced") {
              console.error(`Faber was updated on disk; restarting into the new version.`);
              shutdown(UPGRADE_EXIT_CODE);
            } else {
              console.error(`Faber was uninstalled; stopping.`);
              shutdown(0);
            }
          }, Number(process.env.FABER_UPGRADE_POLL_MS) || 30_000);
        }
        await new Promise(() => {});
        break;
      }

      case "setup": {
        const io = terminalIo(flags.yes === true || flags.y === true);
        const ok = await runSetup(
          { io, host: realHost, layout: detectLayout(), db: ctx.db, cfg: ctx.cfg },
          {
            service: flags["no-service"] !== true,
            ai: flags["no-ai"] !== true,
            extension: flags["no-extension"] !== true,
            launcher: flags["no-launcher"] !== true,
            open: flags["no-open"] !== true,
          },
        );
        io.close();
        if (!ok) process.exitCode = 1;
        break;
      }

      case "doctor": {
        const ok = await runDoctor({ io: terminalIo(true), layout: detectLayout(), db: ctx.db, cfg: ctx.cfg });
        if (!ok) process.exitCode = 1;
        break;
      }

      case "service": {
        const layout = detectLayout();
        const sub = positional[0] ?? "install";
        if (sub === "install") {
          const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
          if (process.env.FABER_HOME) env.FABER_HOME = process.env.FABER_HOME;
          console.log(installService(layout, { home: ctx.cfg.home, env, logFile: join(ctx.cfg.home, "logs", "daemon.log") }));
        } else if (sub === "restart") {
          if (!restartService(layout)) throw new Error(`No ${serviceKind(layout)} service to restart. Install it with: faber service install`);
          console.log("Restarted");
        } else if (sub === "uninstall") {
          const done = uninstallService(layout);
          console.log(done.length ? done.join("\n") : "No background service was installed");
        } else {
          throw new Error("Usage: faber service [install|restart|uninstall]");
        }
        break;
      }

      case "uninstall": {
        const io = terminalIo(flags.yes === true);
        await runUninstall({ io, host: realHost, layout: detectLayout(), db: ctx.db, cfg: ctx.cfg }, { purge: flags.purge === true });
        io.close();
        break;
      }

      default:
        const near = COMMANDS.map((c) => ({ c, d: editDistance(c, cmd) }))
          .filter((x) => x.d <= 2)
          .sort((x, y) => x.d - y.d)[0]?.c;
        console.error(`Unknown command: ${cmd}${near ? ` (did you mean \`faber ${near}\`?)` : ""}\n`);
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== "serve") ctx.close();
  }
}

/**
 * Bring the extension Chrome loads and the launcher in ~/Applications up to this version.
 * Only copies that `faber setup` installed are touched, and only by release builds (a
 * source checkout never replaces them); failures never stop the daemon.
 */
/** The running daemon's view of the models, or null when it isn't running. */
async function daemonModels(ctx: AppContext): Promise<ModelsState | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.cfg.daemon.port}/api/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as ModelsState) : null;
  } catch {
    return null;
  }
}

/**
 * Switch through the running daemon when there is one (it swaps the model live and
 * re-indexes); otherwise directly, and the daemon picks it up when it starts.
 */
async function switchModel(ctx: AppContext, kind: ModelKind, model: string): Promise<ModelsState> {
  const progress = (s: ModelsState) => {
    const p = s.pull;
    if (!p || p.error) return;
    const pct = p.total ? ` ${Math.floor((p.completed / p.total) * 100)}% of ${(p.total / 1024 ** 3).toFixed(1)} GB` : "";
    process.stdout.write(`\r\x1b[2K  ↓ ${p.model}  ${p.status}${pct}`);
  };
  const live = await daemonModels(ctx);
  let state: ModelsState;
  if (live) {
    const base = `http://127.0.0.1:${ctx.cfg.daemon.port}`;
    const res = await fetch(`${base}/api/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, model }) });
    const body = (await res.json()) as ModelsState & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `daemon said ${res.status}`);
    state = body;
    while (state.pull && !state.pull.error) {
      progress(state);
      await Bun.sleep(500);
      state = (await daemonModels(ctx)) ?? state;
    }
  } else {
    const m = new ModelManager(ctx);
    const { done } = await m.change({ kind, model });
    let finished = false;
    void done.finally(() => (finished = true));
    while (!finished) {
      progress(await m.state());
      await Bun.sleep(500);
    }
    state = await m.state();
  }
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  return state;
}

function printModels(s: ModelsState) {
  const show = (title: string, kind: ModelKind) => {
    const slot = s[kind];
    console.log(`${title} (${kind}): ${slot.provider === "ollama" ? "" : `${slot.provider}/`}${slot.model}${slot.installed ? "" : "  (not downloaded)"}`);
    if (!slot.editable) {
      console.log("  set in config.toml");
      return;
    }
    for (const c of slot.choices) {
      const mark = sameModel(c.id, slot.model) ? "*" : " ";
      console.log(`  ${mark} ${c.id.padEnd(22)} ${c.label}: ${c.detail} ${c.installed ? "(downloaded)" : `(${c.size_gb} GB download)`}`);
    }
  };
  show("Summaries", "enrich");
  console.log();
  show("Search", "embed");
  if (s.pull) console.log(`\nDownloading ${s.pull.model}: ${s.pull.error ?? s.pull.status}`);
  if (s.reindex_remaining > 0) console.log(`\nRe-indexing ${s.reindex_remaining} documents for search in the background.`);
  if (!s.ollama_reachable) console.log("\nOllama isn't running, so downloads can't be checked.");
  console.log("\nSwitch with: faber models enrich <model>   or   faber models embed <model>   (any Ollama model name works)");
}

function syncInstalledCopies(layout: ReturnType<typeof detectLayout>, home: string) {
  if (!layout.compiled) return;
  try {
    const ext = syncExtension(layout.extensionSrc, extensionInstallPath(home));
    if (ext === "updated") console.error(`[install] updated the Chrome extension in ${extensionInstallPath(home)}`);
  } catch (err) {
    console.error(`[install] couldn't update the extension: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const app = launcherInstallPath();
    const r = syncLauncher(layout.launcherSrc, app);
    if (r === "updated") {
      console.error(`[install] updated ${app}`);
      // Restart a running launcher so the new version takes over (one the user quit stays quit).
      void quitLauncher().then((wasRunning) => wasRunning && realHost.open(app, ["-g"]));
    }
  } catch (err) {
    console.error(`[install] couldn't update the launcher: ${err instanceof Error ? err.message : err}`);
  }
}

const COMMANDS = [
  "setup", "doctor", "service", "uninstall", "serve", "status", "import-chrome", "add", "enrich", "search", "ask",
  "collections", "projects", "export", "import", "extensions", "demo", "models", "reindex", "requeue", "config", "version", "help",
];

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** Why `faber serve` couldn't listen, in terms a user can act on. */
async function explainServeFailure(cfg: AppContext["cfg"], err: unknown): Promise<string> {
  const url = `http://${cfg.daemon.host}:${cfg.daemon.port}`;
  try {
    const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1500) });
    const s = (await res.json()) as { version?: string; config_path?: string };
    if (s.version) {
      return `Faber ${s.version} is already running at ${url}${s.config_path ? ` (using ${s.config_path})` : ""}. Open it in your browser, or stop that one first.\nTo run a second Faber, give it another port: set [daemon] port in ${join(cfg.home, "config.toml")}.`;
    }
  } catch {}
  return `Couldn't listen on ${url}: ${err instanceof Error ? err.message : err}\nSomething else is probably using port ${cfg.daemon.port}. Set another one under [daemon] port in ${join(cfg.home, "config.toml")}.`;
}

/** Problems a service manager can't fix by restarting us. */
class ServeError extends Error {}

main().catch((err) => {
  // Restarting can't fix these; exit 0 so launchd/systemd leave the service stopped
  // instead of respawning it every few seconds (the log says why).
  if (process.env.FABER_SERVICE === "1" && (err instanceof ServeError || err instanceof DatabaseTooNewError)) {
    console.error(err.message);
    process.exit(0);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
