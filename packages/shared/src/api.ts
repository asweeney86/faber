import type { Appearance } from "./theme";
import type { ModelChoice, ModelKind } from "./models";
import type { Shortcuts } from "./shortcuts";
/**
 * Wire types for the daemon HTTP API. The extension and web UI import these;
 * the daemon implements them. Keep this file free of runtime code.
 */

export type DocSource = "gdoc" | "gslides" | "gsheets" | "url";

export type DocType =
  | "prd"
  | "design_doc"
  | "meeting_notes"
  | "postmortem"
  | "okrs"
  | "roadmap"
  | "deck"
  | "spreadsheet"
  | "runbook"
  | "policy"
  | "research"
  | "status_update"
  | "other";

export interface Enrichment {
  summary: string;
  doc_type: DocType;
  /** Best guess at when the doc was written, "YYYY-MM" or "YYYY-MM-DD", or null. */
  written_at: string | null;
  projects: string[];
  people: string[];
  teams: string[];
  tags: string[];
  /** 0..1, the model's own confidence in the above. */
  confidence: number;
}

export interface EnrichmentRecord extends Enrichment {
  provider: string;
  model: string;
  prompt_version: number;
  created_at: number;
}

export interface DocTag {
  tag: string;
  source: "manual" | "auto";
}

export interface Doc {
  id: string;
  source: DocSource;
  canonical_url: string;
  external_id: string | null;
  title: string;
  has_content: boolean;
  content_fetched_at: number | null;
  content_error: string | null;
  first_seen_at: number;
  last_seen_at: number;
  visit_count: number;
  pinned: boolean;
  note: string | null;
  tags: DocTag[];
  enrichment: EnrichmentRecord | null;
  /** Enrichment queue state for this doc, if it has ever been queued. */
  queue_status: "pending" | "running" | "done" | "error" | null;
  /** The projects this doc is in now (inferred, then your corrections: renames, merges, hand-added). */
  project_refs: { id: string; name: string }[];
}

export interface PersonRef {
  id: string;
  name: string;
}

export interface Meeting {
  id: string;
  title: string;
  url: string | null;
  doc_count: number;
  last_seen_at: number;
}

export interface DocCollectionRef {
  id: string;
  name: string;
  state: CollectionItemState;
}

/** GET /api/docs/:id */
export interface DocDetail extends Doc {
  people: PersonRef[];
  meetings: Meeting[];
  collections: DocCollectionRef[];
  recent_visits: { ts: number; referrer: string | null }[];
}

/** Body for POST /api/capture, sent by the extension when a watched page is visited. */
export interface CaptureRequest {
  url: string;
  title?: string;
  referrer?: string;
  /** Visit timestamp (ms since epoch); defaults to now. */
  ts?: number;
  dwell_ms?: number;
  /** Plain-text body if the extension already extracted it. */
  content?: string;
  /** The calendar event this doc was opened from, if the extension could tell. */
  meeting?: { title: string; url?: string };
  /** Optional structured metadata an extractor pulled from the page. */
  meta?: Record<string, unknown>;
}

/** Body for POST /api/docs: add a bookmark by hand (web UI, CLI, scripts) — no browser extension needed. */
export interface AddDocRequest {
  url: string;
  title?: string;
  /** Document text, e.g. pasted or from File → Download → Plain text. Enables summary, tags and search. */
  content?: string;
  note?: string;
  tags?: string[];
  pinned?: boolean;
  /** Also pin it into this collection. */
  collection_id?: string;
}

export interface AddDocResponse {
  doc: Doc;
  /** False when the URL was already saved (the existing doc was updated). */
  created: boolean;
  /** True for Google docs without text: the extension will fetch it if Docs/Slides/Sheets are enabled. */
  needs_content: boolean;
}

export interface CaptureResponse {
  doc_id: string;
  /** True when the daemon wants (fresh) text for this doc and the extension should fetch it. */
  needs_content: boolean;
}

/** GET /api/docs/pending-content: docs the daemon wants text for, most valuable first. */
export interface PendingContentItem {
  doc_id: string;
  canonical_url: string;
  source: DocSource;
  /** Ready-to-fetch export URL, including the Google account index last seen for this doc. */
  export_url: string | null;
}

export interface ContentRequest {
  content?: string;
  title?: string;
  meta?: Record<string, unknown>;
  /** Set when the fetch failed (e.g. 403); the daemon records it and backs off. */
  error?: string;
}

export interface SearchFilters {
  doc_type?: DocType[];
  source?: DocSource[];
  tag?: string[];
  project?: string[];
  person?: string[];
  pinned?: boolean;
  /** Inclusive ms-since-epoch bounds on last visit. */
  seen_after?: number;
  seen_before?: number;
}

export interface SearchRequest {
  q: string;
  filters?: SearchFilters;
  limit?: number;
  /** Debug: which signals to use. Default both. */
  mode?: "hybrid" | "keyword" | "semantic";
}

export interface SearchHit {
  doc: Doc;
  score: number;
  /** Snippet from FTS with matches wrapped in [brackets], when available. */
  snippet: string | null;
  /** Which signals contributed, for the UI and debugging. */
  signals: { keyword?: number; semantic?: number; recency?: number; popularity?: number };
}

export interface SearchResponse {
  hits: SearchHit[];
  took_ms: number;
  /** False when semantic search was requested but the embedder was unavailable. */
  semantic: boolean;
}

export interface FacetCount {
  value: string;
  count: number;
  /** What to show when the value is an id (projects). */
  label?: string;
}

/** GET /api/facets: top values for the search sidebar. */
export interface Facets {
  doc_type: FacetCount[];
  source: FacetCount[];
  tags: FacetCount[];
  people: FacetCount[];
  projects: FacetCount[];
}

export interface RelatedDoc {
  doc: Doc;
  score: number;
  reasons: string[];
}

// ---------- Collections ----------

/** A pinned item was added by hand; a query item matched the collection's saved query; excluded items are hidden from the query. */
export type CollectionItemState = "pin" | "query" | "exclude";

export interface CollectionQuery {
  q?: string;
  filters?: SearchFilters;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  query: CollectionQuery | null;
  created_at: number;
  updated_at: number;
  pin_count: number;
}

export interface CollectionItem {
  doc: Doc;
  state: Exclude<CollectionItemState, "exclude">;
  /** Note carried in from an imported collection (someone else's words), kept apart from your own note. */
  shared_note: string | null;
}

export interface CollectionDetail extends Collection {
  items: CollectionItem[];
  excluded: Doc[];
}

export interface CollectionInput {
  name: string;
  description?: string | null;
  query?: CollectionQuery | null;
}

/**
 * Portable collection file. Carries URLs, titles, your own notes and your manual
 * tags — never document text or anything a model derived from it (summaries,
 * auto tags, doc types) — so sharing a collection doesn't reveal what a doc says
 * to someone without access. The recipient's own instance fetches content with
 * their own Google permissions. Notes are included: they are your words.
 */
export const COLLECTION_FORMAT = "faber/collection";
/** Format names accepted on import: the current one and files exported before the rename from Power Bookmark. */
export function isCollectionFormat(format: unknown): boolean {
  return format === COLLECTION_FORMAT || format === "power-bookmark/collection";
}

export interface CollectionExport {
  format: typeof COLLECTION_FORMAT;
  version: 1;
  id: string;
  name: string;
  description: string | null;
  query: CollectionQuery | null;
  exported_at: string;
  items: {
    url: string;
    title: string;
    note: string | null;
    tags: string[];
  }[];
}

export interface ImportResult {
  collection_id: string;
  created_docs: number;
  items: number;
}

// ---------- People & meetings ----------

export interface Person {
  id: string;
  name: string;
  email: string | null;
  doc_count: number;
  last_seen_at: number | null;
}

export interface PersonDetail extends Person {
  docs: Doc[];
  /** People who appear alongside this person most often. */
  related_people: (PersonRef & { count: number })[];
}

// ---------- Projects ----------

/** A project inferred from documents (enrichment's "projects"), grouped case-insensitively. */
export interface ProjectSummary {
  /** Slug of the name; stable while the name is. */
  id: string;
  name: string;
  doc_count: number;
  last_seen_at: number;
  /** Docs opened in the last 7 days. */
  recent_doc_count: number;
  /** Docs first seen in the last 7 days. */
  new_doc_count: number;
  /** Any doc opened in the last 14 days. */
  active: boolean;
  doc_types: { doc_type: DocType; count: number }[];
  top_people: string[];
  /** Parent project in the hierarchy (set by hand, or inferred: "Bedrock gateway fleet" under "Bedrock"). */
  parent_id: string | null;
  child_count: number;
  /** Created by hand rather than inferred. */
  manual: boolean;
  /** Reviewed by the user (kept, renamed, moved…): no longer offered for review. */
  confirmed: boolean;
}

/** A decision found in a project's documents ("Decision: …", "we agreed to …"). */
export interface ProjectDecision {
  text: string;
  doc_id: string;
  doc_title: string;
  at: number;
}

export interface ProjectSummaryText {
  text: string;
  model: string;
  created_at: number;
  /** The project's documents changed since it was written. */
  stale: boolean;
}

export interface ProjectDetail extends ProjectSummary {
  /** Most recently opened first. */
  docs: Doc[];
  /** Pinned, then most opened. */
  key_docs: Doc[];
  meetings: Doc[];
  people: (PersonRef & { count: number })[];
  /** Tags shared by two or more of the project's docs. */
  topics: { tag: string; count: number }[];
  /** Projects that share documents with this one. */
  related_projects: { id: string; name: string; shared: number }[];
  /** Root first, this project excluded. */
  ancestors: { id: string; name: string }[];
  children: ProjectSummary[];
  decisions: ProjectDecision[];
  /** The AI overview, if one has been written. */
  summary: ProjectSummaryText | null;
  /** Other spellings enrichment used for this project. */
  aliases: string[];
  /** Documents directly in this project (the rest come from its subprojects). */
  own_doc_ids: string[];
}

/** PATCH /api/projects/:id. parent_id: null = infer, "" = top level. */
export interface ProjectUpdate {
  name?: string | null;
  parent_id?: string | null;
  hidden?: boolean;
  confirmed?: boolean;
}

/** A correction the user made, listed so it can be undone. */
export interface OrganizeRule {
  id: string;
  label: string;
  name: string | null;
  merged_into: { id: string; name: string } | null;
  parent: { id: string; name: string } | "top" | null;
  hidden: boolean;
  manual: boolean;
  confirmed: boolean;
}

export interface DocProjectOverride {
  doc_id: string;
  doc_title: string;
  project_id: string;
  project_name: string;
  state: "add" | "remove";
}

export type ReviewItem =
  | { id: string; kind: "new_project"; project: ProjectSummary }
  | { id: string; kind: "duplicate"; a: ProjectSummary; b: ProjectSummary }
  | { id: string; kind: "low_confidence"; doc: Doc; confidence: number };

export interface ReviewQueue {
  items: ReviewItem[];
}

/** A project a document is in; corrected = put there by hand. */
export interface DocProjectRef {
  id: string;
  name: string;
  corrected: boolean;
}

export interface ProjectActivity {
  project: ProjectSummary;
  docs: Doc[];
}

export interface ActivityItem {
  kind: "enriched" | "captured" | "project";
  label: string;
  count: number;
  at: number;
  project_id?: string;
}

/** GET /api/overview: "Your work at a glance". */
export interface Overview {
  docs: number;
  projects: number;
  /** Projects whose every doc was first seen in the last 7 days. */
  new_projects: number;
  collections: number;
  people: number;
  activity: ActivityItem[];
}

export interface MeetingDetail extends Meeting {
  docs: Doc[];
}

// ---------- Digest ----------

export interface Digest {
  pinned: Doc[];
  /** Opened in the last 7 days, newest first. */
  recent: Doc[];
  /** Most opened over the last 30 days. */
  frequent: Doc[];
  /** Opened regularly 2–12 weeks ago but not in the last 2 weeks. */
  resurfacing: Doc[];
  /** Collection members you first saw in the last 14 days. */
  new_in_collections: { collection: Collection; docs: Doc[] }[];
  /** Docs that still need text, grouped by source, so the UI can nudge the watchlist. */
  waiting_for_content: { total: number; by_source: Partial<Record<DocSource, number>> };
}

// ---------- Ask ----------

export interface AskTurn {
  question: string;
  answer: string;
}

export interface AskRequest {
  question: string;
  /** Earlier questions and answers in this conversation, oldest first (follow-ups). */
  history?: AskTurn[];
  filters?: SearchFilters;
  /** Number of passages to give the model. Default 8. */
  k?: number;
}

export interface AskCitation {
  n: number;
  doc_id: string;
  title: string;
  url: string;
  source: DocSource;
  passage: string;
}

export interface AskResponse {
  answer: string;
  citations: AskCitation[];
  provider: string;
  model: string;
  took_ms: number;
}

// ---------- Settings ----------

export type ExtractorKind = "gdocs" | "gslides" | "gsheets" | "gcal" | "generic";

export interface WatchRule {
  id: string;
  label: string;
  /** Host with optional path prefix: "docs.google.com/document", "*.atlassian.net", "github.com/my-org". */
  pattern: string;
  extractor: ExtractorKind;
  enabled: boolean;
  /** Built-in rules can be toggled but not deleted or edited. */
  builtin: boolean;
}

export interface Settings {
  watchlist: WatchRule[];
  /** Theme, accent and density, shared by the app, the launcher and the extension. */
  appearance: Appearance;
  /** Global shortcuts: the Mac launcher's hotkey, and what each app reports it has. */
  shortcuts: Shortcuts;
}

/** PUT /api/settings: any subset; omitted sections (and omitted shortcut fields) are left as they are. */
export type SettingsUpdate = Partial<Omit<Settings, "shortcuts">> & { shortcuts?: Partial<Shortcuts> };

/** A Chrome extension's access to the daemon. "config" = allowed in config.toml. */
export interface ExtensionAccess {
  id: string;
  state: "approved" | "pending" | "dismissed" | "config";
  since: number | null;
  last_seen_at: number | null;
}

/** Body of the 403 an unapproved extension receives. */
export interface PairingRequiredError {
  error: string;
  code: "pairing_required";
  extension_id: string;
}

export const PAIRING_REQUIRED_MESSAGE = "pairing required: approve this extension in Faber settings";

export interface StatusResponse {
  version: string;
  db_path: string;
  docs: number;
  docs_with_content: number;
  enriched: number;
  queue: { pending: number; running: number; error: number };
  providers: { enrich: string; embed: string; ask: string };
  /** The embedding model is reachable and pulled (semantic search works). */
  embedder_ok: boolean;
  /** The enrichment model is reachable and pulled. */
  enricher_ok: boolean;
  /** Human-readable problems to show the user, e.g. "Ollama isn't reachable…". */
  issues: string[];
  /** Where settings live (respects FABER_HOME). */
  config_path: string;
}


/** One model slot (summaries or search) in GET /api/models. */
export interface ModelSlotState {
  provider: string;
  model: string;
  /** Only local (Ollama) models can be switched from the app; others are set in config.toml. */
  editable: boolean;
  /** Pulled in Ollama (always true for non-Ollama providers). */
  installed: boolean;
  choices: (ModelChoice & { installed: boolean })[];
}

/** GET /api/models: which models are in use, the choices, and any download or re-index in progress. */
export interface ModelsState {
  enrich: ModelSlotState;
  embed: ModelSlotState;
  /** Ollama answered (installed lists are empty when it didn't). */
  ollama_reachable: boolean;
  /** A model being downloaded; it's switched to when the download finishes. */
  pull: { kind: ModelKind; model: string; status: string; completed: number; total: number; error: string | null } | null;
  /** Documents still to re-index for search with the current embedding model. */
  reindex_remaining: number;
  /** Documents whose summary was written by a different model than the current one. */
  summaries_from_other_models: number;
}

/** PUT /api/models: switch one slot to a model (downloading it first if needed). */
export interface ModelChange {
  kind: ModelKind;
  model: string;
}
