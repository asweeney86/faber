import {
  DOC_TYPE_LABELS,
  formatWritten,
  isOpenableUrl,
  plural,
  relativeTime,
  type AskResponse,
  type Collection,
  type Doc,
  type Person,
  type PbClient,
  type ProjectSummary,
} from "@faber/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FaberIcon } from "./Brand";
import { projectTint } from "./tint";
import { IS_MAC, isModKey, MOD_KEY, useDebounced } from "./hooks";
import {
  IconArrowDown,
  IconArrowUp,
  IconBookmark,
  IconChevron,
  IconChevronLeft,
  IconClock,
  IconEnter,
  IconExternal,
  IconFolder,
  IconLayers,
  IconOpenApp,
  IconSearch,
  IconSparkle,
  IconUsers,
  IconX,
  SourceIcon,
} from "./icons";

/**
 * The Spotlight-style launcher: navigation on the left, results in the middle,
 * quick actions on the right. Keyboard-first. The same component runs in the
 * web app (⌘K) and in the extension (an overlay on any page), so everything
 * that differs between them goes through `LauncherHost`.
 */
export interface LauncherHost {
  client: PbClient;
  /** Open a document's original (Google Doc, page…). */
  openUrl(url: string, opts: { newTab: boolean }): void;
  /** Open a page of the main app, by hash route ("/projects/atlas"). */
  openApp(route: string, opts: { newTab: boolean }): void;
  close(): void;
  /** Shortcut that opens the launcher, shown in the header (e.g. "⌘K"). */
  shortcut?: string;
}

export type LauncherMode = "search" | "recent" | "pinned" | "projects" | "collections" | "people" | "ask";

const MODES: { id: LauncherMode; label: string; icon: ReactNode }[] = [
  { id: "search", label: "Search", icon: <IconSearch size={17} /> },
  { id: "recent", label: "Recent", icon: <IconClock size={17} /> },
  { id: "pinned", label: "Pinned", icon: <IconBookmark size={17} /> },
  { id: "projects", label: "Projects", icon: <IconFolder size={17} /> },
  { id: "collections", label: "Collections", icon: <IconLayers size={17} /> },
  { id: "people", label: "People", icon: <IconUsers size={17} /> },
  { id: "ask", label: "Ask", icon: <IconSparkle size={17} /> },
];

const PLACEHOLDER: Record<LauncherMode, string> = {
  search: "Search docs, projects, collections, people…",
  recent: "Filter recent docs…",
  pinned: "Filter pinned docs…",
  projects: "Find a project…",
  collections: "Find a collection…",
  people: "Find a person…",
  ask: "Ask a question about your docs…",
};

type Drill = { kind: "project" | "collection" | "person"; id: string; name: string; /** The filter typed before browsing in, restored on the way back. */ query?: string };

interface Item {
  key: string;
  kind: "doc" | "project" | "collection" | "person" | "ask";
  title: string;
  subtitle?: string;
  icon: ReactNode;
  url?: string;
  /** App route for "Open in Faber". */
  route?: string;
  /** Enter browses into it instead of opening. */
  drill?: Drill;
}

interface Group {
  title: string;
  count?: string;
  items: Item[];
}

const MOD = MOD_KEY;
const isMod = isModKey;
/** Copy link: ⌘⇧C on macOS; elsewhere Ctrl+Shift+C opens DevTools, so Ctrl+Alt+C. */
const COPY_KEYS = IS_MAC ? "⌘⇧C" : "Ctrl+Alt+C";
const isCopyKey = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string; code: string }) =>
  IS_MAC ? e.metaKey && e.shiftKey && e.key.toLowerCase() === "c" : e.ctrlKey && e.altKey && e.code === "KeyC";

const includes = (hay: string, q: string) => hay.toLowerCase().includes(q.trim().toLowerCase());

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

function docSubtitle(d: Doc, project?: string): string {
  const parts: string[] = [];
  if (d.enrichment) parts.push(DOC_TYPE_LABELS[d.enrichment.doc_type]);
  const p = project ?? d.project_refs?.[0]?.name;
  if (p) parts.push(p);
  parts.push(formatWritten(d.enrichment?.written_at) ?? relativeTime(d.last_seen_at));
  return parts.join(" · ");
}

const docItem = (d: Doc, project?: string): Item => ({
  key: `doc:${d.id}`,
  kind: "doc",
  title: d.title.trim() || hostOf(d.canonical_url) || "Untitled document",
  subtitle: docSubtitle(d, project),
  icon: <SourceIcon source={d.source} size={20} />,
  url: d.canonical_url,
  route: `/doc/${d.id}`,
});

const projectItem = (p: ProjectSummary): Item => ({
  key: `project:${p.id}`,
  kind: "project",
  title: p.name,
  subtitle: `${plural(p.doc_count, "doc")}${p.top_people.length ? ` · ${p.top_people.slice(0, 2).join(", ")}` : ""}`,
  icon: (
    <span className="fl-tint" data-tint={projectTint(p.id)}>
      <IconFolder size={19} />
    </span>
  ),
  route: `/projects/${encodeURIComponent(p.id)}`,
  drill: { kind: "project", id: p.id, name: p.name },
});

const collectionItem = (c: Collection): Item => ({
  key: `collection:${c.id}`,
  kind: "collection",
  title: c.name,
  subtitle: [c.query ? "Smart collection" : `${plural(c.pin_count, "doc")}`, c.description].filter(Boolean).join(" · "),
  icon: <IconLayers size={19} />,
  route: `/collections/${c.id}`,
  drill: { kind: "collection", id: c.id, name: c.name },
});

const personItem = (p: Person): Item => ({
  key: `person:${p.id}`,
  kind: "person",
  title: p.name,
  subtitle: plural(p.doc_count, "doc"),
  icon: <span className="fl-avatar">{p.name.slice(0, 1).toUpperCase()}</span>,
  route: `/people/${p.id}`,
  drill: { kind: "person", id: p.id, name: p.name },
});

/** Load once per key; drop stale responses. */
function useLoad<T>(key: string | null, fn: () => Promise<T>): { data?: T; error?: Error; loading: boolean } {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: Error }>({ key: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    fnRef
      .current()
      .then((data) => live && setState({ key, data }))
      .catch((e: unknown) => live && setState({ key, error: e instanceof Error ? e : new Error(String(e)) }));
    return () => {
      live = false;
    };
  }, [key]);
  return key !== null && state.key === key ? { data: state.data, error: state.error, loading: false } : { loading: key !== null };
}

export function Launcher({ host, initialQuery = "", initialMode = "search" }: { host: LauncherHost; initialQuery?: string; initialMode?: LauncherMode }) {
  const { client } = host;
  const [mode, setModeRaw] = useState<LauncherMode>(initialMode);
  const [query, setQuery] = useState(initialQuery);
  const [drills, setDrills] = useState<Drill[]>([]);
  const [selected, setSelected] = useState(0);
  const [asked, setAsked] = useState<{ question: string; scope?: Drill } | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const drill = drills.at(-1);
  const q = useDebounced(query, 120);

  const setMode = useCallback((m: LauncherMode) => {
    setModeRaw(m);
    setDrills([]);
    setQuery("");
    setAsked(null);
    setSelected(0);
    inputRef.current?.focus();
  }, []);

  useEffect(() => inputRef.current?.focus(), []);

  // Lists are small and change rarely: fetch once per launcher session.
  const projects = useLoad("projects", () => client.projects());
  const collections = useLoad("collections", () => client.collections());
  const people = useLoad("people", () => client.people());
  const digest = useLoad("digest", () => client.digest());

  const searchKey = mode === "search" && !drill && q.trim() ? `search:${q.trim()}` : null;
  const search = useLoad(searchKey, () => client.search({ q: q.trim(), limit: 7 }));
  const drillKey = drill ? `${drill.kind}:${drill.id}` : null;
  const drilled = useLoad(drillKey, async (): Promise<Doc[]> => {
    if (!drill) return [];
    if (drill.kind === "project") return (await client.project(drill.id)).docs;
    if (drill.kind === "collection") return (await client.collection(drill.id)).items.map((i) => i.doc);
    return (await client.person(drill.id)).docs;
  });
  const askKey = asked ? `ask:${asked.scope?.id ?? ""}:${asked.question}` : null;
  const answer = useLoad<AskResponse>(askKey, () =>
    client.ask({
      question: asked!.question,
      filters: asked!.scope?.kind === "project" ? { project: [asked!.scope.name] } : asked!.scope?.kind === "person" ? { person: [asked!.scope.name] } : undefined,
    }),
  );

  const groups: Group[] = useMemo(() => {
    const filter = <T,>(xs: T[] | undefined, title: (x: T) => string) => (xs ?? []).filter((x) => !query.trim() || includes(title(x), query));
    if (drill) {
      const docs = filter(drilled.data, (d) => d.title);
      return [{ title: drill.name, count: drilled.data ? plural(docs.length, "doc") : undefined, items: docs.map((d) => docItem(d, drill.kind === "project" ? drill.name : undefined)) }];
    }
    switch (mode) {
      case "search": {
        if (!query.trim()) {
          const out: Group[] = [];
          if (digest.data?.recent.length) out.push({ title: "Recent", items: digest.data.recent.slice(0, 5).map((d) => docItem(d)) });
          if (digest.data?.pinned.length) out.push({ title: "Pinned", items: digest.data.pinned.slice(0, 4).map((d) => docItem(d)) });
          return out;
        }
        const out: Group[] = [];
        const hits = search.data?.hits ?? [];
        if (hits.length) out.push({ title: "Documents", count: plural(hits.length, "result"), items: hits.map((h) => docItem(h.doc)) });
        else if (search.data) out.push({ title: "Documents", items: [] }); // says "nothing matches"
        const ps = filter(projects.data, (p) => p.name).slice(0, 3);
        if (ps.length) out.push({ title: "Projects", count: plural(ps.length, "match", "matches"), items: ps.map(projectItem) });
        const cs = filter(collections.data, (c) => `${c.name} ${c.description ?? ""}`).slice(0, 3);
        if (cs.length) out.push({ title: "Collections", count: plural(cs.length, "match", "matches"), items: cs.map(collectionItem) });
        const pp = filter(people.data, (p) => p.name).slice(0, 3);
        if (pp.length) out.push({ title: "People", count: plural(pp.length, "match", "matches"), items: pp.map(personItem) });
        out.push({
          title: "Ask",
          items: [{ key: "ask", kind: "ask", title: `Ask Faber: “${query.trim()}”`, subtitle: "Answer from your documents, with citations", icon: <IconSparkle size={19} /> }],
        });
        return out;
      }
      case "recent":
        return [{ title: "Recent", count: "Last 7 days", items: filter(digest.data?.recent, (d) => d.title).map((d) => docItem(d)) }];
      case "pinned":
        return [{ title: "Pinned", items: filter(digest.data?.pinned, (d) => d.title).map((d) => docItem(d)) }];
      case "projects":
        return [{ title: "Projects", count: projects.data ? plural(projects.data.length, "project") : undefined, items: filter(projects.data, (p) => p.name).map(projectItem) }];
      case "collections":
        return [{ title: "Collections", items: filter(collections.data, (c) => c.name).map(collectionItem) }];
      case "people":
        return [{ title: "People", items: filter(people.data, (p) => p.name).map(personItem) }];
      case "ask":
        return answer.data
          ? [
              {
                title: "Sources",
                // Only the sources the answer actually cites ([n]); none when it says the docs don't cover it.
                items: citedOnly(answer.data).map((c) => ({
                  key: `cite:${c.n}`,
                  kind: "doc" as const,
                  title: `[${c.n}] ${c.title}`,
                  subtitle: c.passage.slice(0, 120),
                  icon: <SourceIcon source={c.source} size={20} />,
                  url: c.url,
                  route: `/doc/${c.doc_id}`,
                })),
              },
            ]
          : [];
    }
  }, [mode, drill, query, digest.data, search.data, projects.data, collections.data, people.data, drilled.data, answer.data]);

  // While a search is debouncing or in flight, keep showing the previous results, so the
  // list doesn't reshuffle under the selection when documents arrive after the other groups.
  const settling = mode === "search" && !drill && query.trim() !== "" && (query.trim() !== q.trim() || search.loading);
  const [settled, setSettled] = useState(groups);
  useEffect(() => {
    if (!settling) setSettled(groups);
  }, [settling, groups]);
  const visibleGroups = settling ? settled : groups;
  const items = useMemo(() => visibleGroups.flatMap((g) => g.items), [visibleGroups]);
  const current = items[Math.min(selected, items.length - 1)];
  useEffect(() => setSelected(0), [mode, drill, q, answer.data]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const loading =
    settling ||
    (searchKey !== null && search.loading) || (drillKey !== null && drilled.loading) || (askKey !== null && answer.loading) || (mode !== "search" && mode !== "ask" && !drill && digest.loading);

  const runAsk = (question: string) => {
    if (!question.trim()) return;
    // Projects and people scope the answer; collections can't be filtered on yet, so they don't.
    const scope = drill && drill.kind !== "collection" ? drill : undefined;
    setDrills([]);
    setModeRaw("ask");
    setAsked({ question: question.trim(), scope });
    setQuery(question.trim());
  };

  const activate = (item: Item | undefined, newTab: boolean) => {
    if (!item) {
      if (mode === "ask") runAsk(query);
      return;
    }
    if (item.kind === "ask") return runAsk(query);
    if (item.drill && !newTab) {
      setDrills((d) => [...d, { ...item.drill!, query }]);
      setQuery("");
      return;
    }
    if (item.url && isOpenableUrl(item.url)) host.openUrl(item.url, { newTab });
    else if (item.route) host.openApp(item.route, { newTab });
  };

  // Enter pressed before the results for the typed query arrived: act once they do.
  const [queuedEnter, setQueuedEnter] = useState<{ newTab: boolean } | null>(null);
  useEffect(() => {
    if (!queuedEnter || settling) return;
    setQueuedEnter(null);
    activate(items[0], queuedEnter.newTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedEnter, settling, items]);

  const openInApp = (item: Item | undefined) => host.openApp(item?.route ?? (drill ? routeFor(drill) : "/"), { newTab: false });

  const copyLink = async (item: Item | undefined) => {
    if (!item?.url || !isOpenableUrl(item.url)) return;
    try {
      await navigator.clipboard.writeText(item.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard not permitted here */
    }
  };

  const back = () => {
    setQuery(drill?.query ?? "");
    setDrills((d) => d.slice(0, -1));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = isMod(e);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (items.length ? (s + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (items.length ? (s - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "ask" && !asked) return runAsk(query);
      if (mode === "ask" && asked && query.trim() !== asked.question && !mod) return runAsk(query);
      if (settling) return setQueuedEnter({ newTab: mod });
      activate(current, mod);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const i = MODES.findIndex((m) => m.id === mode);
      setMode(MODES[(i + (e.shiftKey ? MODES.length - 1 : 1)) % MODES.length]!.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (drill) back();
      else if (query) {
        setQuery("");
        setAsked(null);
      } else host.close();
    } else if (e.key === "Backspace" && !query && drill) {
      e.preventDefault();
      back();
    } else if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      openInApp(current);
    } else if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setMode("search");
    } else if (e.altKey && !mod && !e.shiftKey && !query && QUICK_KEYS[e.code]) {
      // Option+letter (by e.code, since Option changes e.key on macOS). Only with an empty
      // query, so it never swallows Option-typed letters (ą, ó…) on other layouts.
      e.preventDefault();
      const k = QUICK_KEYS[e.code]!;
      if (k === "open") host.openApp("/", { newTab: false });
      else setMode(k);
    } else if (isCopyKey(e)) {
      e.preventDefault();
      void copyLink(current);
    }
  };

  return (
    <div
      className="fl-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Faber launcher"
      onKeyDown={onKeyDown}
      // Clicking items and buttons keeps the keyboard in the search box.
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("button, [role=option]")) e.preventDefault();
      }}
      data-testid="launcher"
    >
      <header className="fl-header">
        <div className="fl-brand">
          <FaberIcon size={30} />
          <span>Faber</span>
        </div>
        <div className="fl-search">
          {drill ? (
            <button className="fl-crumb" onClick={back} title="Back (Esc)" data-testid="launcher-back">
              <IconChevronLeft size={14} /> {drill.name}
            </button>
          ) : mode === "ask" ? (
            <IconSparkle size={19} />
          ) : (
            <IconSearch size={19} />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={drill ? `Filter ${drill.name}…` : PLACEHOLDER[mode]}
            aria-label={PLACEHOLDER[mode]}
            aria-controls="fl-results"
            aria-activedescendant={current ? `fl-item-${current.key}` : undefined}
            spellCheck={false}
            autoComplete="off"
            data-testid="launcher-input"
          />
          {loading && <span className="fl-spinner" role="status" aria-label="Loading" />}
          {query && (
            <button className="fl-clear" onClick={() => (setQuery(""), setAsked(null), inputRef.current?.focus())} aria-label="Clear">
              <IconX size={15} />
            </button>
          )}
        </div>
        {host.shortcut && <kbd className="fl-kbd fl-shortcut">{host.shortcut}</kbd>}
      </header>

      <div className="fl-body">
        <nav className="fl-nav" aria-label="Sections">
          {MODES.map((m) => (
            <button key={m.id} className={`fl-nav-item${mode === m.id && !drill ? " is-active" : ""}`} onClick={() => setMode(m.id)} data-testid={`launcher-mode-${m.id}`}>
              <span className={`fl-nav-icon fl-icon-${m.id}`}>{m.icon}</span>
              <span>{m.label}</span>
              {m.id === "search" && <kbd className="fl-kbd">{MOD.replace("+", "")}K</kbd>}
            </button>
          ))}
          <div className="fl-sep" />
          <button className="fl-nav-item" onClick={() => host.openApp("/", { newTab: false })} data-testid="launcher-open-app">
            <span className="fl-nav-icon">
              <IconOpenApp size={17} />
            </span>
            <span>Open Faber</span>
            <kbd className="fl-kbd">{MOD}O</kbd>
          </button>
        </nav>

        <div className="fl-results" id="fl-results" role="listbox" aria-label="Results" ref={listRef}>
          {mode === "ask" && <AskView asked={asked} answer={answer} query={query} onAsk={runAsk} />}
          {mode === "search" && search.error && !settling && (
            <div className="fl-empty fl-error" role="alert">
              Search failed: {describeError(search.error)}
            </div>
          )}
          {visibleGroups.map((g) =>
            g.items.length === 0 && mode !== "ask" ? (
              <div key={g.title} className="fl-empty" data-testid="launcher-empty">
                {loading ? "Loading…" : query ? `Nothing in ${g.title} matches “${query}”.` : `No ${g.title.toLowerCase()} yet.`}
              </div>
            ) : (
              g.items.length > 0 && (
                <section key={g.title} className="fl-group">
                  <h3 className="fl-group-title">
                    {g.title} {g.count && <span>{g.count}</span>}
                  </h3>
                  {g.items.map((it) => {
                    const index = items.indexOf(it);
                    const isSel = index === selected;
                    return (
                      <div
                        key={it.key}
                        id={`fl-item-${it.key}`}
                        role="option"
                        aria-selected={isSel}
                        className={`fl-item fl-kind-${it.kind}`}
                        onMouseMove={() => index !== selected && setSelected(index)}
                        onClick={(e) => activate(it, isMod(e))}
                        data-testid="launcher-item"
                      >
                        <span className="fl-item-icon">{it.icon}</span>
                        <span className="fl-item-text">
                          <span className="fl-item-title">{it.title}</span>
                          {it.subtitle && <span className="fl-item-sub">{it.subtitle}</span>}
                        </span>
                        {isSel ? <IconEnter size={17} className="fl-item-enter" /> : it.drill ? <IconChevron size={15} className="fl-item-chevron" /> : null}
                      </div>
                    );
                  })}
                </section>
              )
            ),
          )}
          {mode === "search" && !query.trim() && visibleGroups.length === 0 && !digest.loading && (
            <div className="fl-empty">Type to search everything you’ve read: docs, projects, collections and people.</div>
          )}
        </div>

        <aside className="fl-actions" aria-label="Quick actions">
          <h3 className="fl-group-title">Quick actions</h3>
          {current && (
            <div className="fl-action-list" data-testid="launcher-actions">
              <Action label={current.drill ? "Browse" : current.kind === "ask" ? "Ask" : "Open"} keys="↵" onClick={() => activate(current, false)} />
              {current.url && <Action label="Open in new tab" keys={`${MOD}↵`} onClick={() => activate(current, true)} />}
              {current.route && <Action label="Show in Faber" keys={`${MOD}O`} onClick={() => openInApp(current)} />}
              {current.url && <Action label={copied ? "Copied" : "Copy link"} keys={COPY_KEYS} onClick={() => void copyLink(current)} />}
            </div>
          )}
          <div className="fl-action-list fl-action-global">
            <Action label="Go to Recent" letter="R" onClick={() => setMode("recent")} />
            <Action label="Open Collections" letter="C" onClick={() => setMode("collections")} />
            <Action label="Open Pinned" letter="P" onClick={() => setMode("pinned")} />
            <Action label="Ask a question" letter="A" onClick={() => (query.trim() ? runAsk(query) : setMode("ask"))} />
            <Action label="Open Faber" letter="O" onClick={() => host.openApp("/", { newTab: false })} />
          </div>
        </aside>
      </div>

      <footer className="fl-footer">
        <span>
          <kbd className="fl-kbd">
            <IconArrowUp />
          </kbd>
          <kbd className="fl-kbd">
            <IconArrowDown />
          </kbd>
          Navigate
        </span>
        <span>
          <kbd className="fl-kbd">↵</kbd> Open
        </span>
        <span>
          <kbd className="fl-kbd">{MOD}↵</kbd> New tab
        </span>
        <span>
          <kbd className="fl-kbd">⇥</kbd> Sections
        </span>
        <span>
          <kbd className="fl-kbd">{ALT.replace("+", "")}</kbd> Quick actions
        </span>
        <span className="fl-footer-end">
          <kbd className="fl-kbd">Esc</kbd> {drill ? "Back" : "Close"}
        </span>
      </footer>
    </div>
  );
}

const QUICK_KEYS: Record<string, LauncherMode | "open"> = { KeyR: "recent", KeyC: "collections", KeyP: "pinned", KeyA: "ask", KeyO: "open" };
const ALT = IS_MAC ? "⌥" : "Alt+";

/** Citations the answer refers to by number. */
export function citedOnly(r: AskResponse) {
  const used = new Set([...r.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return r.citations.filter((c) => used.has(c.n));
}

/** Network failures (the daemon is down) read as such, not as "Failed to fetch". */
function describeError(e: Error): string {
  return e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e.message) ? "Can’t reach Faber. Is the daemon running?" : e.message;
}

function routeFor(d: Drill) {
  return d.kind === "project" ? `/projects/${encodeURIComponent(d.id)}` : d.kind === "collection" ? `/collections/${d.id}` : `/people/${d.id}`;
}

function Action({ label, keys, letter, onClick, icon }: { label: string; keys?: string; letter?: string; onClick: () => void; icon?: ReactNode }) {
  return (
    <button className="fl-action" onClick={onClick} tabIndex={-1}>
      {letter && (
        <kbd className="fl-letter" title={`${ALT}${letter}`}>
          {letter}
        </kbd>
      )}
      <span className="fl-action-label">
        {icon} {label}
      </span>
      {keys && <kbd className="fl-kbd">{keys}</kbd>}
    </button>
  );
}

function AskView({
  asked,
  answer,
  query,
  onAsk,
}: {
  asked: { question: string; scope?: Drill } | null;
  answer: { data?: AskResponse; error?: Error; loading: boolean };
  query: string;
  onAsk: (q: string) => void;
}) {
  if (!asked)
    return (
      <div className="fl-ask-intro">
        <p>Ask anything your documents can answer. Faber cites the docs it used and says so when they don’t cover it.</p>
        {["What did we decide about rate limits?", "Who owns the Frankfurt launch?", "What blocked the EU launch?"].map((s) => (
          <button key={s} className="fl-suggestion" onClick={() => onAsk(s)}>
            <IconSparkle size={14} /> {s}
          </button>
        ))}
        {query.trim() && <p className="fl-muted">Press ↵ to ask.</p>}
      </div>
    );
  if (answer.loading)
    return (
      <div className="fl-ask-answer" aria-busy="true">
        <p className="fl-muted">Reading your documents{asked.scope ? ` in ${asked.scope.name}` : ""}…</p>
      </div>
    );
  if (answer.error)
    return (
      <div className="fl-ask-answer fl-error" role="alert">
        {describeError(answer.error)}
      </div>
    );
  if (!answer.data) return null;
  return (
    <div className="fl-ask-answer" data-testid="launcher-answer">
      {asked.scope && <p className="fl-muted">In {asked.scope.name}</p>}
      <p>{answer.data.answer.replace(/\s*\[(\d+)\]/g, " [$1]")}</p>
      {citedOnly(answer.data).length === 0 && <p className="fl-muted">No documents cited.</p>}
      <p className="fl-muted fl-small">
        <IconExternal size={12} /> {answer.data.model} · {(answer.data.took_ms / 1000).toFixed(1)}s
      </p>
    </div>
  );
}
