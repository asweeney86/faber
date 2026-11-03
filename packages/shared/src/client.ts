import type {
  AddDocRequest,
  AddDocResponse,
  AskRequest,
  AskResponse,
  CaptureRequest,
  CaptureResponse,
  Collection,
  CollectionDetail,
  CollectionExport,
  CollectionInput,
  CollectionItemState,
  ContentRequest,
  Digest,
  Doc,
  DocDetail,
  DocSource,
  ExtensionAccess,
  Facets,
  ImportResult,
  Meeting,
  MeetingDetail,
  PendingContentItem,
  Person,
  PersonDetail,
  RelatedDoc,
  SearchFilters,
  SearchRequest,
  SearchResponse,
  Settings,
  SettingsUpdate,
  ModelChange,
  ModelsState,
  ProjectSummary,
  ProjectDetail,
  Overview,
  ProjectUpdate,
  ProjectActivity,
  ReviewQueue,
  OrganizeRule,
  DocProjectOverride,
  DocProjectRef,
  StatusResponse,
} from "./api";
import type { SavedView, ViewSpec } from "./views";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7777";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable error code from the daemon, e.g. "pairing_required". */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }

  get pairingRequired(): boolean {
    return this.status === 403 && this.code === "pairing_required";
  }
}

export interface ClientOptions {
  /**
   * Send reads as POST + x-faber-method: GET. Browser extensions need this: Chrome
   * omits the Origin header on their GETs, and the daemon only serves extensions it
   * can identify (and the user approved).
   */
  identifyReads?: boolean;
}

/** Typed client for the daemon API, shared by the web UI and the extension. */
export class PbClient {
  constructor(
    readonly baseUrl: string = "",
    private readonly opts: ClientOptions = {},
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const override = this.opts.identifyReads && method === "GET";
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (override) headers["x-faber-method"] = "GET";
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: override ? "POST" : method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: string; code?: string };
        if (j.error) msg = j.error;
        code = j.code;
      } catch {
        /* not JSON */
      }
      throw new ApiRequestError(res.status, msg, code);
    }
    return (await res.json()) as T;
  }

  status = () => this.req<StatusResponse>("GET", "/api/status");
  settings = () => this.req<Settings>("GET", "/api/settings");
  projects = () => this.req<ProjectSummary[]>("GET", "/api/projects");
  project = (id: string) => this.req<ProjectDetail>("GET", `/api/projects/${encodeURIComponent(id)}`);
  overview = () => this.req<Overview>("GET", "/api/overview");
  createProject = (name: string, parent_id?: string | null) => this.req<ProjectDetail>("POST", "/api/projects", { name, parent_id });
  updateProject = (id: string, patch: ProjectUpdate) => this.req<ProjectDetail>("PATCH", `/api/projects/${encodeURIComponent(id)}`, patch);
  mergeProject = (id: string, into: string) => this.req<ProjectDetail>("POST", `/api/projects/${encodeURIComponent(id)}/merge`, { into });
  resetProject = (id: string) => this.req<{ ok: true }>("DELETE", `/api/projects/${encodeURIComponent(id)}/corrections`);
  writeProjectSummary = (id: string) => this.req<{ text: string; model: string; created_at: number }>("POST", `/api/projects/${encodeURIComponent(id)}/summary`);
  projectActivity = () => this.req<ProjectActivity[]>("GET", "/api/activity/projects");
  review = () => this.req<ReviewQueue>("GET", "/api/review");
  dismissReview = (id: string) => this.req<{ ok: true }>("POST", `/api/review/${encodeURIComponent(id)}/dismiss`);
  corrections = () => this.req<{ rules: OrganizeRule[]; docs: DocProjectOverride[] }>("GET", "/api/organize/corrections");
  docProjects = (docId: string) => this.req<DocProjectRef[]>("GET", `/api/docs/${docId}/projects`);
  /** in: true = put in the project, false = take out, null = forget the correction. */
  setDocProject = (docId: string, project: string, inProject: boolean | null) => this.req<DocProjectRef[]>("PUT", `/api/docs/${docId}/projects`, { project, in: inProject });
  views = () => this.req<SavedView[]>("GET", "/api/views");
  view = (id: string) => this.req<SavedView>("GET", `/api/views/${encodeURIComponent(id)}`);
  createView = (name: string, spec: ViewSpec) => this.req<SavedView>("POST", "/api/views", { name, spec });
  updateView = (id: string, patch: { name?: string; spec?: ViewSpec }) => this.req<SavedView>("PATCH", `/api/views/${encodeURIComponent(id)}`, patch);
  deleteView = (id: string) => this.req<{ ok: true }>("DELETE", `/api/views/${encodeURIComponent(id)}`);
  saveSettings = (s: SettingsUpdate) => this.req<Settings>("PUT", "/api/settings", s);
  models = () => this.req<ModelsState>("GET", "/api/models");
  /** Switches now if the model is downloaded; otherwise downloads it first (see ModelsState.pull). */
  setModel = (c: ModelChange) => this.req<ModelsState>("PUT", "/api/models", c);
  dismissModelPull = () => this.req<ModelsState>("DELETE", "/api/models/pull");
  resummarise = () => this.req<{ queued: number }>("POST", "/api/models/resummarise");

  capture = (c: CaptureRequest) => this.req<CaptureResponse>("POST", "/api/capture", c);
  addDoc = (r: AddDocRequest) => this.req<AddDocResponse>("POST", "/api/docs", r);
  pendingContent = (sources: DocSource[], limit = 10) =>
    this.req<PendingContentItem[]>("GET", `/api/docs/pending-content?limit=${limit}&sources=${sources.join(",")}`);
  postContent = (id: string, c: ContentRequest) => this.req<{ ok: true; changed: boolean }>("POST", `/api/docs/${id}/content`, c);

  lookup = async (url: string): Promise<Doc | null> => {
    try {
      return await this.req<Doc>("GET", `/api/docs/lookup?url=${encodeURIComponent(url)}`);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 404) return null;
      throw e;
    }
  };
  doc = (id: string) => this.req<DocDetail>("GET", `/api/docs/${id}`);
  deleteDoc = (id: string) => this.req<{ ok: true }>("DELETE", `/api/docs/${id}`);
  setNote = (id: string, note: string | null) => this.req<Doc>("PUT", `/api/docs/${id}/note`, { note });
  setPinned = (id: string, pinned: boolean) => this.req<Doc>("PUT", `/api/docs/${id}/pin`, { pinned });
  addTag = (id: string, tag: string) => this.req<Doc>("POST", `/api/docs/${id}/tags`, { tag });
  removeTag = (id: string, tag: string) => this.req<Doc>("DELETE", `/api/docs/${id}/tags`, { tag });
  reenrich = (id: string) => this.req<{ ok: true }>("POST", `/api/docs/${id}/enrich`);
  /** Tell the daemon the user opened this doc from Faber (it ranks frequently used docs higher). */
  opened = (id: string) => this.req<{ ok: true }>("POST", `/api/docs/${id}/open`);
  related = (id: string) => this.req<RelatedDoc[]>("GET", `/api/docs/${id}/related`);

  search = (r: SearchRequest) => this.req<SearchResponse>("POST", "/api/search", r);
  /** Facets over everything, or over the results of a query/filters so picking one never gives zero hits. */
  facets = (scope?: { q?: string; filters?: SearchFilters }) =>
    scope ? this.req<Facets>("POST", "/api/facets", scope) : this.req<Facets>("GET", "/api/facets");
  digest = () => this.req<Digest>("GET", "/api/digest");
  ask = (r: AskRequest) => this.req<AskResponse>("POST", "/api/ask", r);

  collections = () => this.req<Collection[]>("GET", "/api/collections");
  collection = (id: string) => this.req<CollectionDetail>("GET", `/api/collections/${id}`);
  createCollection = (c: CollectionInput) => this.req<Collection>("POST", "/api/collections", c);
  updateCollection = (id: string, c: Partial<CollectionInput>) => this.req<Collection>("PUT", `/api/collections/${id}`, c);
  deleteCollection = (id: string) => this.req<{ ok: true }>("DELETE", `/api/collections/${id}`);
  setCollectionDoc = (id: string, docId: string, state: Exclude<CollectionItemState, "query">) =>
    this.req<{ ok: true }>("PUT", `/api/collections/${id}/docs/${docId}`, { state });
  removeCollectionDoc = (id: string, docId: string) => this.req<{ ok: true }>("DELETE", `/api/collections/${id}/docs/${docId}`);
  exportCollection = (id: string) => this.req<CollectionExport>("GET", `/api/collections/${id}/export`);
  importCollection = (file: CollectionExport) => this.req<ImportResult>("POST", "/api/collections/import", file);

  people = () => this.req<Person[]>("GET", "/api/people");
  person = (id: string) => this.req<PersonDetail>("GET", `/api/people/${id}`);
  extensions = () => this.req<ExtensionAccess[]>("GET", "/api/extensions");
  approveExtension = (id: string) => this.req<{ ok: true }>("POST", `/api/extensions/${id}/approve`);
  dismissExtension = (id: string) => this.req<{ ok: true }>("POST", `/api/extensions/${id}/dismiss`);
  removeExtension = (id: string) => this.req<{ ok: true }>("DELETE", `/api/extensions/${id}`);

  meetings = () => this.req<Meeting[]>("GET", "/api/meetings");
  meeting = (id: string) => this.req<MeetingDetail>("GET", `/api/meetings/${id}`);
}
