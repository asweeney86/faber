import {
  addTag,
  ask,
  AskError,
  buildDigest,
  CollectionError,
  collectionsForDoc,
  createCollection,
  deleteCollection,
  deleteDoc,
  enqueueEnrichment,
  libraryRevision,
  recordOpen,
  PROMPT_VERSION,
  exportCollection,
  getCollection,
  getCollectionRow,
  getDoc,
  getDocDetail,
  getDocRow,
  getFacets,
  getMeeting,
  getPerson,
  getSettings,
  importCollection,
  linkDocToMeeting,
  listCollections,
  listMeetings,
  listPeople,
  lookupByUrl,
  needsContent,
  pendingContent,
  prunePeople,
  recordVisit,
  refreshFts,
  relatedDocs,
  removeCollectionDoc,
  removeTag,
  runQueue,
  countNeedingEmbedding,
  embedMissing,
  saveSettings,
  search,
  setCollectionDoc,
  setContent,
  setContentError,
  setNote,
  setPinned,
  SettingsValidationError,
  stats,
  updateCollection,
  approveExtension,
  clampLimit,
  isExtensionApproved,
  listExtensions,
  nextDueAt,
  recordPendingExtension,
  recoverStaleJobs,
  removeExtension,
  dismissExtension,
  touchExtension,
  validateFilters,
  ValidationError,
  isProviderUnavailable,
  providerHealth,
  providerProblems,
  getOverview,
  getProject,
  listProjects,
  clearDocProject,
  createProject,
  createView,
  deleteView,
  dismissReviewItem,
  getView,
  listCorrections,
  listViews,
  mergeProject,
  OrganizeError,
  projectsForDoc,
  recentProjectActivity,
  resetProject,
  reviewQueue,
  setDocProject,
  updateProject,
  updateView,
  ViewError,
  writeProjectSummary,
} from "@faber/core";
import { join } from "node:path";
import type {
  AddDocRequest,
  AddDocResponse,
  AskRequest,
  CaptureRequest,
  CaptureResponse,
  CollectionExport,
  CollectionInput,
  ContentRequest,
  DocSource,
  SearchRequest,
  PairingRequiredError,
  SettingsUpdate,
  ProjectUpdate,
  StatusResponse,
} from "@faber/shared";
import { PAIRING_REQUIRED_MESSAGE } from "@faber/shared";
import type { AppContext } from "./context";
import { checkRequest, corsHeaders, effectiveMethod, extensionIdOf, hostAllowed } from "./security";
import { Favicons, type Fetcher } from "./favicons";
import { ModelChangeError, ModelManager } from "./models";
import indexPage from "../../web/index.html";
import launcherPage from "../../web/launcher.html";
// @ts-expect-error: a file import resolves to its path (embedded in compiled binaries).
import faviconPath from "../../../brand/favicon.ico" with { type: "file" };

export { VERSION } from "./version";
import { VERSION } from "./version";

const MAX_BODY = 8 * 1024 * 1024;
const MAX_CONTENT_CHARS = 1_000_000;
const DOC_SOURCES: DocSource[] = ["gdoc", "gslides", "gsheets", "url"];
const FAVICON_PATH = /^\/api\/docs\/[^/]+\/favicon$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string>;
type Handler = (req: Request, params: Params, url: URL) => Promise<unknown> | unknown;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp(
    `^${path.replace(/:([a-z_]+)/g, (_, k: string) => {
      keys.push(k);
      return "([^/]+)";
    })}$`,
  );
  return { method, re, keys, handler };
}

/** Read a JSON body, counting bytes as they stream so an oversized (or chunked) upload is cut off early. */
async function body<T>(req: Request): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, "request body too large");
  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel();
        throw new HttpError(413, "request body too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  if (!text) return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object") throw new HttpError(400, "body must be a JSON object");
  return parsed as T;
}

function isHttpUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 4096) return false;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

const optString = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

export interface ServerOptions {
  port?: number;
  /** How often to retry due jobs and resync the index. Default 30s. */
  tickMs?: number;
  /** Start draining the enrichment queue in the background. Default true. */
  autoEnrich?: boolean;
  log?: (msg: string) => void;
  /** How site icons are fetched (tests stub it). */
  fetchFavicon?: Fetcher;
}

export function startServer(ctx: AppContext, opts: ServerOptions = {}) {
  const { cfg, db } = ctx;
  const log = opts.log ?? ((m: string) => console.log(m));
  const autoEnrich = opts.autoEnrich ?? true;
  let queueRunning = false;
  let queueAgain = false;
  /** Set by stop(): background work that finishes afterwards mustn't start more (the database may be closed). */
  let stopped = false;
  let providerError: string | null = null;

  /** Drain the enrichment queue in the background; coalesces calls made while it runs. */
  const kickQueue = () => {
    if (!autoEnrich || stopped) return;
    if (queueRunning) {
      queueAgain = true;
      return;
    }
    let enricher;
    let embedder;
    try {
      enricher = ctx.enricher;
      embedder = ctx.embedder;
      providerError = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== providerError) log(`[enrich] disabled: ${msg}`);
      providerError = msg;
      return;
    }
    queueRunning = true;
    runQueue({ db, cfg, enricher, embedder, index: ctx.index, log: (m) => log(`[enrich] ${m}`) })
      .then((r) => {
        prunePeople(db);
        ctx.noteIndexWrite();
        if (r.unavailable) log(`[enrich] paused: provider unavailable (${r.unavailable}); retrying shortly`);
      })
      .catch((err) => log(`[enrich] queue failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => {
        queueRunning = false;
        if (queueAgain) {
          queueAgain = false;
          kickQueue();
        } else {
          kickReindex();
        }
      });
  };

  /**
   * After the embedding model changes, re-embed enriched documents with it (summaries are
   * reused, no LLM calls), a batch at a time, so search fills back in without `faber reindex`.
   * Waits while the enrichment queue runs: both use Ollama.
   */
  let reindexRunning = false;
  let reindexError: string | null = null;
  const kickReindex = () => {
    if (!autoEnrich || stopped || reindexRunning || queueRunning) return;
    let embedder;
    try {
      embedder = ctx.embedder;
    } catch {
      return;
    }
    if (countNeedingEmbedding(db, embedder.model) === 0) return;
    reindexRunning = true;
    void (async () => {
      try {
        let n = 0;
        let batch: number;
        // Stop if the model changes again, or enrichment wants Ollama.
        while (!stopped && !queueRunning && ctx.cfg.embed.model === embedder.model && (batch = await embedMissing({ db, cfg, embedder, index: ctx.index }, 10)) > 0) {
          n += batch;
        }
        ctx.noteIndexWrite();
        if (n) log(`[index] re-embedded ${n} docs with ${embedder.model}`);
        reindexError = null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== reindexError) log(`[index] re-embedding paused: ${msg}`);
        reindexError = msg;
      } finally {
        reindexRunning = false;
      }
    })();
  };

  const models = new ModelManager(ctx, (kind) => {
    log(`[models] ${kind} now uses ${ctx.cfg[kind].model}`);
    if (kind === "embed") kickReindex();
  });

  /** Pairing and approval are for the user (web UI or CLI), never for an extension approving itself. */
  const requireUser = (req: Request) => {
    if (extensionIdOf(req.headers.get("origin"))) throw new HttpError(403, "extensions cannot manage extension access");
  };

  const requireDoc = (id: string) => {
    if (!getDocRow(db, id)) throw new HttpError(404, "document not found");
    return id;
  };

  const favicons = new Favicons(cfg.home, opts.fetchFavicon);

  const routes: Route[] = [
    route("GET", "/api/models", () => models.state()),
    route("PUT", "/api/models", async (req) => {
      requireUser(req);
      await models.change(await body(req));
      return models.state();
    }),
    route("DELETE", "/api/models/pull", (req) => {
      requireUser(req);
      models.dismissPullError();
      return models.state();
    }),
    /** Re-summarise documents whose summary came from another model (or an older prompt), with the current one. */
    route("POST", "/api/models/resummarise", (req) => {
      requireUser(req);
      const ids = db
        .query<{ id: string }, [string, string, number]>(
          `SELECT d.id FROM documents d JOIN enrichments e ON e.doc_id = d.id AND e.is_current = 1
           WHERE d.content IS NOT NULL AND NOT (e.provider = ? AND e.model = ? AND e.prompt_version = ?)`,
        )
        .all(cfg.enrich.provider, cfg.enrich.model, PROMPT_VERSION);
      for (const { id } of ids) enqueueEnrichment(db, id, undefined, { force: true });
      kickQueue();
      return { queued: ids.length };
    }),
    route("GET", "/api/status", async () => {
      const { problems: issues, embedOk, enrichOk } = await providerProblems(cfg);
      return {
        version: VERSION,
        db_path: cfg.db_path,
        config_path: join(cfg.home, "config.toml"),
        ...stats(db),
        providers: ctx.describeProviders(),
        embedder_ok: embedOk,
        enricher_ok: enrichOk,
        issues,
        revision: libraryRevision(db),
      } satisfies StatusResponse;
    }),

    route("GET", "/api/settings", () => getSettings(db)),
    route("PUT", "/api/settings", async (req) => saveSettings(db, await body<SettingsUpdate>(req))),

    route("POST", "/api/capture", async (req) => {
      const b = await body<CaptureRequest>(req);
      if (!isHttpUrl(b.url)) throw new HttpError(400, "url must be an http(s) URL");
      // Ignore implausible timestamps (bad clocks, junk) rather than let them pin a doc to the top forever.
      const ts = typeof b.ts === "number" && b.ts >= Date.UTC(2000, 0, 1) && b.ts <= Date.now() + 5 * 60_000 ? b.ts : undefined;
      const { row } = recordVisit(db, {
        url: b.url,
        title: optString(b.title, 500),
        ts,
        referrer: isHttpUrl(b.referrer) ? b.referrer : undefined,
        dwell_ms: typeof b.dwell_ms === "number" ? Math.round(b.dwell_ms) : undefined,
      });
      if (b.meeting && typeof b.meeting.title === "string") {
        linkDocToMeeting(db, row.id, { title: b.meeting.title, url: isHttpUrl(b.meeting.url) ? b.meeting.url : undefined }, ts);
      }
      if (typeof b.content === "string" && b.content.trim()) {
        const { changed } = setContent(db, row.id, b.content.slice(0, MAX_CONTENT_CHARS), {
          title: optString(b.title, 500),
          meta: b.meta && typeof b.meta === "object" ? b.meta : undefined,
        });
        if (changed) kickQueue();
      }
      return { doc_id: row.id, needs_content: needsContent(getDocRow(db, row.id)!) } satisfies CaptureResponse;
    }),

    route("POST", "/api/docs", async (req) => {
      const b = await body<AddDocRequest>(req);
      if (!isHttpUrl(b.url)) throw new HttpError(400, "url must be an http(s) URL");
      if (b.content !== undefined && typeof b.content !== "string") throw new HttpError(400, "content must be a string");
      if (b.note !== undefined && b.note !== null && typeof b.note !== "string") throw new HttpError(400, "note must be a string");
      if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== "string" || !t.trim() || t.length > 60))) {
        throw new HttpError(400, "tags must be 1-60 character strings");
      }
      if (b.collection_id !== undefined && !getCollectionRow(db, b.collection_id)) throw new HttpError(404, "collection not found");
      const title = optString(b.title, 500);
      const { row, created } = recordVisit(db, { url: b.url, title, origin: "manual" });
      if (title?.trim()) db.run(`UPDATE documents SET title = ? WHERE id = ?`, [title.trim(), row.id]);
      if (typeof b.content === "string" && b.content.trim()) {
        const { changed } = setContent(db, row.id, b.content.slice(0, MAX_CONTENT_CHARS), { title });
        if (changed) kickQueue();
      }
      if (typeof b.note === "string" && b.note.trim()) setNote(db, row.id, b.note.trim().slice(0, 2000));
      for (const t of b.tags ?? []) addTag(db, row.id, t, "manual");
      if (b.pinned) setPinned(db, row.id, true);
      if (b.collection_id) setCollectionDoc(db, b.collection_id, row.id, "pin");
      refreshFts(db, row.id);
      const fresh = getDocRow(db, row.id)!;
      return { doc: getDoc(db, row.id)!, created, needs_content: needsContent(fresh) } satisfies AddDocResponse;
    }),

    route("GET", "/api/docs/pending-content", (_req, _p, url) => {
      const limit = clampLimit(url.searchParams.get("limit"), 10, 100);
      const raw = url.searchParams.get("sources");
      const sources = raw === null ? undefined : (raw.split(",").filter((s) => DOC_SOURCES.includes(s as DocSource)) as DocSource[]);
      return pendingContent(db, { limit, sources });
    }),

    route("GET", "/api/docs/lookup", (_req, _p, url) => {
      const u = url.searchParams.get("url");
      if (!isHttpUrl(u)) throw new HttpError(400, "url must be an http(s) URL");
      const row = lookupByUrl(db, u);
      if (!row) throw new HttpError(404, "document not found");
      return getDoc(db, row.id);
    }),

    // The site's own icon, for <img> tags. Only for documents in the library, so nothing can
    // make the daemon fetch arbitrary hosts.
    route("GET", "/api/docs/:id/favicon", async (_req, p) => {
      const doc = getDocRow(db, p.id!);
      if (!doc) throw new HttpError(404, "document not found");
      const icon = cfg.privacy.favicons === false ? null : doc.source === "url" ? await favicons.get(doc.canonical_url) : await favicons.google(doc.source);
      if (!icon) return new Response(null, { status: 204, headers: { "cache-control": "private, max-age=86400" } });
      return new Response(icon.bytes, {
        headers: {
          "content-type": icon.type,
          "cache-control": "private, max-age=604800",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    }),

    route("GET", "/api/docs/:id", async (_req, p) => {
      const d = getDocDetail(db, p.id!);
      if (!d) throw new HttpError(404, "document not found");
      return { ...d, collections: await collectionsForDoc(ctx.searchDeps, d.id) };
    }),

    route("DELETE", "/api/docs/:id", (_req, p) => {
      requireDoc(p.id!);
      deleteDoc(db, p.id!);
      ctx.index.removeDoc(p.id!);
      prunePeople(db);
      return { ok: true };
    }),

    route("POST", "/api/docs/:id/content", async (req, p) => {
      requireDoc(p.id!);
      const b = await body<ContentRequest>(req);
      if (typeof b.error === "string") {
        setContentError(db, p.id!, b.error);
        return { ok: true, changed: false };
      }
      if (typeof b.content !== "string") throw new HttpError(400, "content or error is required");
      const r = setContent(db, p.id!, b.content.slice(0, MAX_CONTENT_CHARS), {
        title: optString(b.title, 500),
        meta: b.meta && typeof b.meta === "object" ? b.meta : undefined,
      });
      if (r.changed) kickQueue();
      return { ok: true, ...r };
    }),

    route("PUT", "/api/docs/:id/note", async (req, p) => {
      requireDoc(p.id!);
      const { note } = await body<{ note: unknown }>(req);
      if (note !== null && typeof note !== "string") throw new HttpError(400, "note must be a string or null");
      const clean = typeof note === "string" && note.trim() ? note.trim().slice(0, 2000) : null;
      setNote(db, p.id!, clean);
      return getDoc(db, p.id!);
    }),

    route("PUT", "/api/docs/:id/pin", async (req, p) => {
      requireDoc(p.id!);
      const { pinned } = await body<{ pinned: unknown }>(req);
      if (typeof pinned !== "boolean") throw new HttpError(400, "pinned must be a boolean");
      setPinned(db, p.id!, pinned);
      return getDoc(db, p.id!);
    }),

    route("POST", "/api/docs/:id/tags", async (req, p) => {
      requireDoc(p.id!);
      const { tag } = await body<{ tag: unknown }>(req);
      if (typeof tag !== "string" || !tag.trim() || tag.length > 60) throw new HttpError(400, "tag must be 1-60 characters");
      addTag(db, p.id!, tag, "manual");
      refreshFts(db, p.id!);
      return getDoc(db, p.id!);
    }),

    route("DELETE", "/api/docs/:id/tags", async (req, p) => {
      requireDoc(p.id!);
      const { tag } = await body<{ tag: unknown }>(req);
      if (typeof tag !== "string") throw new HttpError(400, "tag is required");
      removeTag(db, p.id!, tag);
      refreshFts(db, p.id!);
      return getDoc(db, p.id!);
    }),

    route("POST", "/api/docs/:id/enrich", (_req, p) => {
      const row = getDocRow(db, requireDoc(p.id!))!;
      if (row.content == null) throw new HttpError(409, "document has no content yet");
      enqueueEnrichment(db, p.id!, 1e6, { force: true });
      kickQueue();
      return { ok: true };
    }),

    /** The user opened this doc from Faber: counts toward how often it's used. */
    route("POST", "/api/docs/:id/open", (_req, p) => {
      if (!recordOpen(db, p.id!)) throw new HttpError(404, "document not found");
      return { ok: true };
    }),

    route("GET", "/api/docs/:id/related", (_req, p) => relatedDocs(db, ctx.index, requireDoc(p.id!))),

    route("POST", "/api/search", async (req) => {
      const b = await body<SearchRequest>(req);
      if (typeof b.q !== "string") throw new HttpError(400, "q must be a string");
      if (b.mode !== undefined && !["hybrid", "keyword", "semantic"].includes(b.mode)) throw new HttpError(400, "invalid mode");
      if (b.sort !== undefined && b.sort !== "frequent" && b.sort !== "recent") throw new HttpError(400, 'sort must be "frequent" or "recent"');
      return search(ctx.searchDeps, {
        q: b.q.slice(0, 500),
        filters: validateFilters(b.filters),
        limit: clampLimit(b.limit, 20, 200),
        mode: b.mode,
        sort: b.sort,
      });
    }),
    route("GET", "/api/search", (_req, _p, url) =>
      search(ctx.searchDeps, {
        q: (url.searchParams.get("q") ?? "").slice(0, 500),
        limit: clampLimit(url.searchParams.get("limit"), 20, 200),
      }),
    ),

    route("GET", "/api/facets", () => getFacets(db)),
    route("POST", "/api/facets", async (req) => {
      const b = await body<{ q?: unknown; filters?: unknown }>(req);
      if (b.q !== undefined && typeof b.q !== "string") throw new HttpError(400, "q must be a string");
      const filters = validateFilters(b.filters);
      if (!b.q?.trim() && !filters) return getFacets(db);
      const res = await search(ctx.searchDeps, { q: (b.q ?? "").slice(0, 500), filters, limit: 500 }, { snippets: false });
      return getFacets(db, 30, res.hits.map((h) => h.doc.id));
    }),
    route("GET", "/api/digest", () => buildDigest(ctx.searchDeps)),

    route("POST", "/api/ask", async (req) => {
      const b = await body<AskRequest>(req);
      let chat;
      try {
        chat = ctx.chat;
      } catch (err) {
        throw new HttpError(503, err instanceof Error ? err.message : String(err));
      }
      try {
        return await ask({ ...ctx.searchDeps, chat }, b);
      } catch (err) {
        if (isProviderUnavailable(err)) {
          const health = await providerHealth(cfg, 0);
          throw new HttpError(503, health.ask.problem ?? `Can't reach the ${chat.provider} model right now. Try again shortly.`);
        }
        throw err;
      }
    }),

    route("GET", "/api/collections", () => listCollections(db)),
    route("POST", "/api/collections", async (req) => createCollection(db, await body<CollectionInput>(req))),
    route("POST", "/api/collections/import", async (req) => importCollection(ctx.searchDeps, await body<CollectionExport>(req))),
    route("GET", "/api/collections/:id", async (_req, p) => {
      const c = await getCollection(ctx.searchDeps, p.id!);
      if (!c) throw new HttpError(404, "collection not found");
      return c;
    }),
    route("PUT", "/api/collections/:id", async (req, p) => {
      if (!getCollectionRow(db, p.id!)) throw new HttpError(404, "collection not found");
      return updateCollection(db, p.id!, await body<Partial<CollectionInput>>(req));
    }),
    route("DELETE", "/api/collections/:id", (_req, p) => {
      if (!deleteCollection(db, p.id!)) throw new HttpError(404, "collection not found");
      return { ok: true };
    }),
    route("PUT", "/api/collections/:id/docs/:doc", async (req, p) => {
      const { state } = await body<{ state: unknown }>(req);
      if (state !== "pin" && state !== "exclude") throw new HttpError(400, 'state must be "pin" or "exclude"');
      setCollectionDoc(db, p.id!, p.doc!, state);
      return { ok: true };
    }),
    route("DELETE", "/api/collections/:id/docs/:doc", (_req, p) => {
      if (!getCollectionRow(db, p.id!)) throw new HttpError(404, "collection not found");
      removeCollectionDoc(db, p.id!, p.doc!);
      return { ok: true };
    }),
    route("GET", "/api/collections/:id/export", async (_req, p) => {
      const e = await exportCollection(ctx.searchDeps, p.id!);
      if (!e) throw new HttpError(404, "collection not found");
      return e;
    }),

    route("GET", "/api/projects", () => listProjects(db)),
    route("GET", "/api/projects/:id", (_req, p) => {
      const project = getProject(db, p.id!);
      if (!project) throw new HttpError(404, "project not found");
      return project;
    }),
    route("GET", "/api/overview", () => getOverview(db)),
    route("POST", "/api/projects", async (req) => {
      const b = await body<{ name: string; parent_id?: string | null }>(req);
      const id = createProject(db, b);
      return getProject(db, id);
    }),
    route("PATCH", "/api/projects/:id", async (req, p) => {
      updateProject(db, p.id!, await body<ProjectUpdate>(req));
      return getProject(db, p.id!) ?? { ok: true };
    }),
    route("POST", "/api/projects/:id/merge", async (req, p) => {
      const b = await body<{ into: string }>(req);
      mergeProject(db, p.id!, b?.into);
      return getProject(db, b.into);
    }),
    route("DELETE", "/api/projects/:id/corrections", (_req, p) => {
      resetProject(db, p.id!);
      return { ok: true };
    }),
    route("POST", "/api/projects/:id/summary", async (_req, p) => {
      let chat;
      try {
        chat = ctx.chat;
      } catch (err) {
        throw new HttpError(503, err instanceof Error ? err.message : String(err));
      }
      try {
        return await writeProjectSummary(db, chat, p.id!);
      } catch (err) {
        if (isProviderUnavailable(err)) throw new HttpError(503, `Can't reach the ${chat.provider} model right now. Try again shortly.`);
        throw err;
      }
    }),
    route("GET", "/api/activity/projects", () => recentProjectActivity(db)),
    route("GET", "/api/review", () => reviewQueue(db)),
    route("POST", "/api/review/:id/dismiss", (_req, p) => {
      dismissReviewItem(db, p.id!);
      return { ok: true };
    }),
    route("GET", "/api/organize/corrections", () => listCorrections(db)),
    route("GET", "/api/docs/:id/projects", (_req, p) => {
      requireDoc(p.id!);
      return projectsForDoc(db, p.id!);
    }),
    route("PUT", "/api/docs/:id/projects", async (req, p) => {
      requireDoc(p.id!);
      const b = await body<{ project: string; in: boolean | null }>(req);
      if (typeof b?.project !== "string" || !b.project.trim()) throw new HttpError(400, "project is required");
      if (b.in !== true && b.in !== false && b.in !== null) throw new HttpError(400, "in must be true (add), false (take out) or null (forget the correction)");
      if (b.in === null) clearDocProject(db, p.id!, b.project);
      else setDocProject(db, p.id!, b.project.trim(), !!b.in);
      return projectsForDoc(db, p.id!);
    }),
    route("GET", "/api/views", () => listViews(db)),
    route("POST", "/api/views", async (req) => createView(db, await body<{ name: string; spec: unknown }>(req))),
    route("GET", "/api/views/:id", (_req, p) => {
      const v = getView(db, p.id!);
      if (!v) throw new HttpError(404, "view not found");
      return v;
    }),
    route("PATCH", "/api/views/:id", async (req, p) => updateView(db, p.id!, await body<{ name?: string; spec?: unknown }>(req))),
    route("DELETE", "/api/views/:id", (_req, p) => {
      deleteView(db, p.id!);
      return { ok: true };
    }),
    route("GET", "/api/people", () => listPeople(db)),
    route("GET", "/api/people/:id", (_req, p) => {
      const person = getPerson(db, p.id!);
      if (!person) throw new HttpError(404, "person not found");
      return person;
    }),
    route("GET", "/api/extensions", (req) => {
      requireUser(req);
      return listExtensions(db, cfg.daemon.allowed_extension_ids);
    }),
    route("POST", "/api/extensions/:id/approve", (req, p) => {
      requireUser(req);
      if (!approveExtension(db, p.id!)) throw new HttpError(400, "invalid extension id");
      return { ok: true };
    }),
    route("POST", "/api/extensions/:id/dismiss", (req, p) => {
      requireUser(req);
      if (!dismissExtension(db, p.id!)) throw new HttpError(400, "invalid extension id");
      return { ok: true };
    }),
    route("DELETE", "/api/extensions/:id", (req, p) => {
      requireUser(req);
      if (!removeExtension(db, p.id!)) throw new HttpError(404, "extension not found");
      return { ok: true };
    }),

    route("GET", "/api/meetings", () => listMeetings(db)),
    route("GET", "/api/meetings/:id", (_req, p) => {
      const m = getMeeting(db, p.id!);
      if (!m) throw new HttpError(404, "meeting not found");
      return m;
    }),
  ];

  const security = { port: opts.port ?? cfg.daemon.port };
  const configExtensions = cfg.daemon.allowed_extension_ids ?? [];

  async function handleApi(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let verdict = checkRequest(req, security);
    // Site icons are plain <img> loads, from the app and from extension pages alike (which send
    // no Origin). They reveal nothing without a document's random id, and the daemon only ever
    // fetches icons for sites already in the library, so only the Host check applies.
    if (!verdict.ok && req.method === "GET" && FAVICON_PATH.test(url.pathname) && hostAllowed(req)) verdict = { ok: true, origin: null };
    if (!verdict.ok) return Response.json({ error: `forbidden: ${verdict.reason}` }, { status: 403 });
    const cors = corsHeaders(verdict.origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const extId = extensionIdOf(verdict.origin);
    if (extId) {
      if (configExtensions.includes(extId) || isExtensionApproved(db, extId)) {
        touchExtension(db, extId);
      } else {
        recordPendingExtension(db, extId);
        return Response.json(
          { error: PAIRING_REQUIRED_MESSAGE, code: "pairing_required", extension_id: extId } satisfies PairingRequiredError,
          { status: 403, headers: cors },
        );
      }
    }

    const method = effectiveMethod(req);
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      try {
        const params: Params = {};
        r.keys.forEach((k, i) => {
          try {
            params[k] = decodeURIComponent(m[i + 1]!);
          } catch {
            throw new HttpError(400, "malformed URL");
          }
        });
        const result = await r.handler(req, params, url);
        if (result instanceof Response) return result;
        return Response.json(result ?? { ok: true }, { headers: cors });
      } catch (err) {
        const status =
          err instanceof HttpError
            ? err.status
            : err instanceof CollectionError || err instanceof OrganizeError || err instanceof ViewError
              ? err.status
              : err instanceof SettingsValidationError || err instanceof AskError || err instanceof ValidationError || err instanceof ModelChangeError
                ? 400
                : 500;
        const message = err instanceof Error ? err.message : String(err);
        if (status >= 500) log(`[api] ${method} ${url.pathname} failed: ${err instanceof Error ? (err.stack ?? message) : message}`);
        return Response.json({ error: message }, { status, headers: cors });
      }
    }
    return Response.json({ error: pathMatched ? "method not allowed" : "not found" }, { status: pathMatched ? 405 : 404, headers: cors });
  }

  const server = Bun.serve({
    hostname: cfg.daemon.host,
    port: opts.port ?? cfg.daemon.port,
    // Fail with EADDRINUSE if something already listens there, instead of silently sharing the port.
    reusePort: false,
    development: process.env.NODE_ENV !== "production" && process.env.FABER_DEV === "1",
    routes: webRoutes,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/api/")) return handleApi(req);
      return new Response("Not found", { status: 404 });
    },
    error(err) {
      log(`[http] ${err.stack ?? err.message}`);
      return Response.json({ error: "internal error" }, { status: 500 });
    },
  });

  // Jobs left running by a crash go back to the queue; then keep ticking so failed jobs retry
  // after their backoff and changes made by other `faber` processes reach the in-memory index.
  // At startup nothing can be running yet, so every "running" job was orphaned by a crash.
  recoverStaleJobs(db, 0);
  kickQueue();
  const tick = setInterval(() => {
    if (!queueRunning) recoverStaleJobs(db);
    if (!queueRunning && !reindexRunning && ctx.syncIndex()) log("[index] reloaded vectors changed by another process");
    const due = nextDueAt(db);
    if (due !== null && due <= Date.now()) kickQueue();
    kickReindex();
  }, opts.tickMs ?? 30_000);
  const stop = server.stop.bind(server);
  return Object.assign(server, {
    kickQueue,
    stop: (closeActive?: boolean) => {
      stopped = true;
      clearInterval(tick);
      return stop(closeActive);
    },
  });
}

/**
 * The web UI and the launcher page, bundled by Bun from packages/web. Static imports, so
 * `bun build --compile` embeds them (and the favicon) in the release binary.
 */
const webRoutes: Record<string, Bun.HTMLBundle | Response> = {
  "/": indexPage,
  // The launcher on its own page, for the native macOS launcher (packages/macos).
  "/launcher": launcherPage,
  // Browsers ask for /favicon.ico on their own (e.g. for API responses opened directly).
  "/favicon.ico": new Response(await Bun.file(faviconPath).bytes(), {
    headers: { "content-type": "image/x-icon", "cache-control": "max-age=86400" },
  }),
};
