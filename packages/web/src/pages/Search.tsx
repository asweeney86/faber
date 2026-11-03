import { useEffect, useMemo, useRef, useState } from "react";
import type { DocSource, DocType, FacetCount, SearchHit } from "@faber/shared";
import {
  api,
  docTitle,
  DOC_TYPE_LABELS,
  emitChange,
  filtersFromState,
  isTypingTarget,
  navigate,
  noteOpened,
  openLinkProps,
  plural,
  searchStateFromQuery,
  searchStateToHash,
  SOURCE_LABELS,
  TIME_RANGES,
  toggle,
  useAsync,
  useDebounced,
  type Route,
  type SearchState,
} from "../lib";
import { IconArrowRight, IconCheck, IconChevron, IconChevronDown, IconExternal, IconFilter, IconPin, IconSearch, IconX, SourceIcon } from "../components/icons";
import { DocIcon, DocMeta, EmptyState, ErrorBanner, Snippet, Spinner, useDrawer, useIsEmptyLibrary, useNow } from "../components/ui";
import { SetupChecklist } from "../components/Setup";
import { ViewNameModal } from "./Dashboards";

const SOURCES: DocSource[] = ["gdoc", "gslides", "gsheets", "url"];

export function SearchPage({ route }: { route: Route }) {
  const state = useMemo(() => searchStateFromQuery(route.query), [route.query]);
  const [input, setInput] = useState(state.q);
  const debounced = useDebounced(input, 200);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the box in sync when the URL changes from elsewhere (back button, facet links).
  const lastPushed = useRef(state.q);
  useEffect(() => {
    if (state.q !== lastPushed.current) {
      setInput(state.q);
      lastPushed.current = state.q;
    }
  }, [state.q]);

  useEffect(() => {
    if (debounced === state.q) return;
    lastPushed.current = debounced;
    navigate(searchStateToHash({ ...state, q: debounced }), { replace: true });
    // Intentionally not re-run when the omitted dependencies change.
  }, [debounced]);

  const update = (patch: Partial<SearchState>) => navigate(searchStateToHash({ ...state, q: input, ...patch }), { replace: true });

  const key = searchStateToHash(state);
  const results = useAsync(() => api.search({ q: state.q, filters: filtersFromState(state), limit: 50, sort: state.sort }), [key]);
  const [saving, setSaving] = useState(false);
  // Project filters hold ids; show their names.
  const projectList = useAsync(() => api.projects(), []);
  const projectNames = useMemo(() => new Map((projectList.data ?? []).map((p) => [p.id, p.name])), [projectList.data]);
  // Facet counts are scoped to the current query + filters, so every facet value shown has results.
  const facets = useAsync(() => api.facets({ q: state.q, filters: filtersFromState(state) }), [key]);
  const hits = results.data?.hits ?? [];

  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [key]);

  const drawer = useDrawer();
  const [facetsOpen, setFacetsOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const firstRun = useIsEmptyLibrary();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (drawer.docId || document.querySelector(".modal")) return;
      const inSearchBox = e.target === inputRef.current;
      if (isTypingTarget(e.target) && !inSearchBox) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (hits.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(hits.length - 1, s + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if (e.key === "Enter") {
        const h = hits[sel];
        if (h) {
          e.preventDefault();
          noteOpened(h.doc.id);
          window.open(h.doc.canonical_url, "_blank", "noopener");
        }
      } else if ((e.key === " " && !inSearchBox) || (e.key === "ArrowRight" && (!inSearchBox || caretAtEnd(inputRef.current)))) {
        const h = hits[sel];
        if (h) {
          e.preventDefault();
          drawer.openDoc(h.doc.id);
        }
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [hits, sel, drawer]);

  const activeFacetFilters = [
    ...state.tags.map((v) => ({ kind: "tags" as const, v, label: `#${v}` })),
    ...state.people.map((v) => ({ kind: "people" as const, v, label: v })),
    ...state.projects.map((v) => ({ kind: "projects" as const, v, label: projectNames.get(v) ?? v })),
  ];
  const barFilterCount = state.types.length + state.sources.length + (state.pinned ? 1 : 0) + (state.time !== "all" ? 1 : 0);
  const anyFilter = activeFacetFilters.length > 0 || barFilterCount > 0;

  const typeOptions: DocType[] = useMemo(() => {
    const fromFacets = (facets.data?.doc_type ?? []).map((f) => f.value as DocType).filter((t) => t in DOC_TYPE_LABELS);
    // Every type present in the library (there are at most 13), most common first.
    return Array.from(new Set([...state.types, ...fromFacets]));
  }, [facets.data, state.types]);

  return (
    <div className="page">
      <div className="search-bar" role="search">
        <IconSearch size={18} />
        <input
          ref={inputRef}
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search titles, summaries, people, projects, text…"
          aria-label="Search"
          data-testid="search-input"
          spellCheck={false}
        />
        {results.loading && <Spinner size={14} />}
        {input && (
          <button className="icon-btn" aria-label="Clear search" onClick={() => setInput("")}>
            <IconX size={14} />
          </button>
        )}
      </div>

      <button className="filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)} data-testid="filters-toggle">
        <IconFilter size={13} /> Filters{barFilterCount > 0 ? ` (${barFilterCount})` : ""}
        <IconChevronDown size={11} />
      </button>
      <div className={`filter-bar${filtersOpen ? " is-open" : ""}`} data-testid="filter-bar">
        <div className="segmented" role="group" aria-label="Time range">
          {TIME_RANGES.map((t) => (
            <button key={t.id} className={state.time === t.id ? "is-on" : ""} aria-pressed={state.time === t.id} onClick={() => update({ time: t.id })} data-testid={`time-${t.id}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="filter-group" role="group" aria-label="Source">
          {SOURCES.map((s) => (
            <button key={s} className={`fchip${state.sources.includes(s) ? " is-on" : ""}`} aria-pressed={state.sources.includes(s)} onClick={() => update({ sources: toggle(state.sources, s) })} data-testid={`source-${s}`}>
              <SourceIcon source={s} size={13} /> {SOURCE_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="filter-group">
          <TypeMenu options={typeOptions} selected={state.types} onChange={(types) => update({ types })} />
          <button className={`fchip${state.pinned ? " is-on" : ""}`} aria-pressed={state.pinned} onClick={() => update({ pinned: !state.pinned })} data-testid="filter-pinned">
            <IconPin size={12} filled={state.pinned} /> Pinned
          </button>
          {anyFilter && (
            <button className="btn btn-ghost btn-sm" onClick={() => update({ types: [], sources: [], tags: [], people: [], projects: [], pinned: false, time: "all" })} data-testid="clear-filters">
              Clear filters
            </button>
          )}
        </div>
      </div>

      {activeFacetFilters.length > 0 && (
        <div className="active-filters">
          {activeFacetFilters.map((f) => (
            <button key={`${f.kind}:${f.v}`} className="chip chip-active" onClick={() => update({ [f.kind]: toggle(state[f.kind], f.v) })} data-testid="active-filter">
              {f.label} <IconX size={10} />
            </button>
          ))}
        </div>
      )}

      <div className="search-layout">
        <div className="search-results" ref={listRef} data-testid="results">
          {results.error && <ErrorBanner error={results.error} onRetry={results.reload} />}
          {firstRun && !state.q && !anyFilter && <SetupChecklist />}
          {results.data && (hits.length > 0 || state.q || anyFilter) && !(firstRun && !state.q && !anyFilter) && (
            <div className="results-meta" data-testid="results-meta">
              <span>
                {state.q ? plural(hits.length, "result") : anyFilter ? plural(hits.length, "doc") : state.sort === "recent" ? "Recently opened" : "Most used"}
                {state.q && <span className="muted"> · {results.data.took_ms}ms</span>}
              </span>
              {!state.q && (
                <div className="segmented segmented-sm" role="group" aria-label="Sort">
                  {(
                    [
                      ["frequent", "Frequent", "How often and how recently you open them"],
                      ["recent", "Recent", "Last opened first"],
                    ] as const
                  ).map(([id, label, hint]) => (
                    <button key={id} className={state.sort === id ? "is-on" : ""} aria-pressed={state.sort === id} title={hint} onClick={() => update({ sort: id })} data-testid={`sort-${id}`}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {state.q && !results.data.semantic && (
                <span className="warn-text" data-testid="semantic-off" title="Is Ollama running? Semantic search needs the embedding model.">
                  Keyword only — semantic search unavailable
                </span>
              )}
              {(state.q || anyFilter) && (
                <button className="btn btn-sm btn-ghost save-view" onClick={() => setSaving(true)} data-testid="save-view">
                  Save as view
                </button>
              )}
              {hits.length > 0 && (
                <span className="kbd-hints muted">
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> select · <kbd>↵</kbd> open · <kbd>Space</kbd> details
                </span>
              )}
            </div>
          )}
          {!results.data && results.loading && <ResultSkeleton />}
          {results.data && hits.length === 0 && (state.q || anyFilter) && (
            <EmptyState title={state.q ? `No matches for “${state.q}”` : "No docs match these filters"} testId="no-results">
              {firstRun ? (
                "Your library is empty — finish setup on the Home page to start capturing docs."
              ) : (
                <>
                  {anyFilter ? "Try removing a filter, or search with different words." : "Try fewer or different words — search covers titles, summaries, people, projects and full text."}
                  {state.q && (
                    <div className="empty-actions">
                      <a className="btn btn-sm" href={`#/ask?q=${encodeURIComponent(state.q)}`} data-testid="ask-instead">
                        Ask instead <IconArrowRight size={12} />
                      </a>
                    </div>
                  )}
                </>
              )}
            </EmptyState>
          )}
          {hits.map((h, i) => (
            <ResultCard key={h.doc.id} hit={h} index={i} selected={i === sel} onSelect={() => setSel(i)} onFacet={(kind, v) => update({ [kind]: toggle(state[kind], v) })} />
          ))}
        </div>

        <aside className={`facets${facetsOpen ? " is-open" : ""}${results.data && hits.length === 0 ? " is-dim" : ""}`} aria-label="Refine" data-testid="facets" hidden={firstRun}>
          <button className="facets-toggle" aria-expanded={facetsOpen} onClick={() => setFacetsOpen(!facetsOpen)}>
            Refine by tags, people and projects
            {activeFacetFilters.length > 0 && <span className="badge badge-soft">{activeFacetFilters.length}</span>}
            <IconChevron size={12} className="facets-chevron" />
          </button>
          {facets.data ? (
            <>
              <FacetGroup title="Tags" items={facets.data.tags} active={state.tags} format={(v) => `#${v}`} onToggle={(v) => update({ tags: toggle(state.tags, v) })} testId="facet-tags" />
              <FacetGroup title="People" items={facets.data.people} active={state.people} onToggle={(v) => update({ people: toggle(state.people, v) })} testId="facet-people" />
              <FacetGroup title="Projects" items={facets.data.projects} active={state.projects} onToggle={(v) => update({ projects: toggle(state.projects, v) })} testId="facet-projects" />
            </>
          ) : facets.error ? null : (
            <Spinner />
          )}
        </aside>
      </div>
      {saving && (
        <ViewNameModal
          title="Save this search as a view"
          initial={state.q || state.projects.map((v) => projectNames.get(v) ?? v).join(", ") || state.tags.map((t) => `#${t}`).join(" ")}
          onClose={() => setSaving(false)}
          onSubmit={async (name) => {
            // Time ranges are saved as "days ago", so the view stays current.
            const filters = filtersFromState(state);
            const days = TIME_RANGES.find((t) => t.id === state.time)?.days;
            if (days) filters.seen_after = -days;
            const v = await api.createView(name, { widgets: [{ kind: "search", title: name, q: state.q, filters, limit: 15 }] });
            emitChange();
            navigate(`/dashboards/${v.id}`);
          }}
        />
      )}
    </div>
  );
}

function caretAtEnd(el: HTMLInputElement | null) {
  return !!el && el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
}

function ResultSkeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="result skeleton">
          <div className="sk sk-title" />
          <div className="sk sk-line" />
          <div className="sk sk-line short" />
        </div>
      ))}
    </div>
  );
}

function ResultCard({ hit, index, selected, onSelect, onFacet }: { hit: SearchHit; index: number; selected: boolean; onSelect: () => void; onFacet: (kind: "people" | "projects" | "tags", v: string) => void }) {
  const { doc } = hit;
  const e = doc.enrichment;
  const drawer = useDrawer();
  const now = useNow();
  return (
    <article
      className={`result${selected ? " is-selected" : ""}${drawer.docId === doc.id ? " is-open" : ""}`}
      data-testid="result"
      data-index={index}
      data-doc-id={doc.id}
      aria-selected={selected}
      onMouseEnter={onSelect}
      onClick={(ev) => {
        if ((ev.target as HTMLElement).closest("a,button")) return;
        drawer.openDoc(doc.id);
      }}
    >
      <header className="result-head">
        <DocIcon doc={doc} size={16} />
        <a className="result-title" {...openLinkProps(doc)} data-testid="result-title" title="Open document">
          <span className="result-title-text">{docTitle(doc)}</span>
          <IconExternal size={12} className="result-ext" />
        </a>
        {doc.pinned && <IconPin size={13} filled className="pin-mark" />}
        <DocMeta doc={doc} now={now} inline />
      </header>
      {e?.summary && (
        <p className="result-summary" title={e.summary}>
          {e.summary}
        </p>
      )}
      {hit.snippet && <Snippet text={hit.snippet} />}
      {doc.note && <p className="result-note">“{doc.note}”</p>}
      {(e?.people.length || doc.project_refs?.length || doc.tags.length) ? (
        <div className="result-chips">
          {(doc.project_refs ?? []).slice(0, 2).map((p) => (
            <button key={`p:${p.id}`} className="chip chip-project" onClick={() => onFacet("projects", p.id)}>
              {p.name}
            </button>
          ))}
          {e?.people.slice(0, 3).map((p) => (
            <button key={`u:${p}`} className="chip chip-person" onClick={() => onFacet("people", p)}>
              {p}
            </button>
          ))}
          {doc.tags.slice(0, 5).map((t) => (
            <button key={`t:${t.tag}`} className={`tag tag-${t.source}`} onClick={() => onFacet("tags", t.tag)}>
              #{t.tag}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function FacetGroup({ title, items, active, onToggle, format, testId }: { title: string; items: FacetCount[]; active: string[]; onToggle: (v: string) => void; format?: (v: string) => string; testId: string }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  // Active values always stay visible even if they fall outside the top N.
  const shown = expanded ? items : items.slice(0, 10);
  const extraActive: FacetCount[] = active.filter((a) => !shown.some((s) => s.value === a)).map((value) => ({ value, count: 0, label: items.find((i) => i.value === value)?.label }));
  return (
    <section className="facet" data-testid={testId}>
      <h3>{title}</h3>
      <ul>
        {[...extraActive, ...shown].map((f) => (
          <li key={f.value}>
            <button className={`facet-item${active.includes(f.value) ? " is-on" : ""}`} aria-pressed={active.includes(f.value)} onClick={() => onToggle(f.value)}>
              <span className="facet-label">{format ? format(f.value) : (f.label ?? f.value)}</span>
              {f.count > 0 && <span className="facet-count">{f.count}</span>}
            </button>
          </li>
        ))}
      </ul>
      {items.length > 10 && (
        <button className="facet-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show ${items.length - 10} more`}
        </button>
      )}
    </section>
  );
}

/** "Type ▾" popover: multi-select doc types without a row of 13 chips. */
function TypeMenu({ options, selected, onChange }: { options: DocType[]; selected: DocType[]; onChange: (t: DocType[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const label = selected.length === 0 ? "Type" : selected.length === 1 ? DOC_TYPE_LABELS[selected[0]!] : `Type · ${selected.length}`;
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`fchip${selected.length ? " is-on" : ""}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="type-menu">
        {label} <IconChevronDown size={11} />
      </button>
      {open && (
        <div className="menu" role="menu" data-testid="type-menu-list">
          {options.length === 0 && <div className="menu-empty muted small">No types yet</div>}
          {options.map((t) => {
            const on = selected.includes(t);
            return (
              <button key={t} role="menuitemcheckbox" aria-checked={on} className={`menu-item${on ? " is-on" : ""}`} onClick={() => onChange(toggle(selected, t))} data-testid={`type-${t}`}>
                <span className="menu-check">{on && <IconCheck size={12} />}</span>
                {DOC_TYPE_LABELS[t]}
              </button>
            );
          })}
          {selected.length > 0 && (
            <button className="menu-item menu-clear" onClick={() => onChange([])}>
              Clear types
            </button>
          )}
        </div>
      )}
    </div>
  );
}
