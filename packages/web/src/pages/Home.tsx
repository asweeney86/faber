import { useState, type ReactNode } from "react";
import type { Digest, Doc, ExtensionAccess, Overview, ProjectSummary } from "@faber/shared";
import { api, docTitle, navigate, plural, relativeTime, SOURCE_LABELS, useAsync } from "../lib";
import {
  IconActivity,
  IconAlert,
  IconArrowRight,
  IconBarChart,
  IconBookmark,
  IconCheckCircle,
  IconChevron,
  IconClock,
  IconFile,
  IconFolder,
  IconGrid,
  IconLayers,
  IconPlus,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconSparkle,
  IconTarget,
  IconUsers,
  IconX,
  SourceIcon,
} from "../components/icons";
import { DocList, EmptyState, ErrorBanner, PageHeader, Spinner, useDrawer, useIsEmptyLibrary, usePendingExtensions } from "../components/ui";
import { SetupChecklist } from "../components/Setup";
import { NewProjectModal, ProjectCard, projectTint } from "./Projects";
import { openLauncher } from "../launcher";

export function HomePage() {
  const digest = useAsync(() => api.digest(), []);
  const overview = useAsync(() => api.overview(), []);
  const projects = useAsync(() => api.projects(), []);
  const d = digest.data;
  const firstRun = useIsEmptyLibrary();
  if (firstRun)
    return (
      <div className="page">
        <PageHeader title="Welcome to Faber" subtitle="Your docs, remembered by what’s in them — not by their titles." />
        <SetupChecklist />
      </div>
    );
  return (
    <div className="page page-wide home">
      <div className="home-main">
        <PageHeader title="Home" subtitle={greeting()} />
        <PairingBanner />
        <HomeSearch />
        <QuickTiles />
        {digest.error && !d && <ErrorBanner error={digest.error} onRetry={digest.reload} />}
        {!d && !digest.error && (
          <div className="center-pad">
            <Spinner size={18} />
          </div>
        )}
        {!!projects.data?.length && <ProjectsPanel projects={projects.data} />}
        {d && <DigestView d={d} projects={projects.data ?? []} />}
      </div>
      <aside className="home-rail" aria-label="Your work at a glance">
        <GlanceCard overview={overview.data} projects={projects.data} />
      </aside>
    </div>
  );
}

const TILES = [
  { href: "#/projects", icon: <IconFolder size={22} />, title: "Projects", hint: "Auto-organized by work", id: "projects" },
  { href: "#/collections", icon: <IconLayers size={22} />, title: "Collections", hint: "Curated & smart", id: "collections" },
  { href: "#/people", icon: <IconUsers size={22} />, title: "People", hint: "Find work by person", id: "people" },
  { href: "#/dashboards", icon: <IconGrid size={22} />, title: "Dashboards", hint: "Your saved views", id: "dashboards" },
  { href: "#/ask", icon: <IconSparkle size={22} />, title: "Ask", hint: "Answers from your docs", id: "ask" },
];

function QuickTiles() {
  return (
    <nav className="tiles" aria-label="Explore">
      {TILES.map((t) => (
        <a key={t.id} className="tile" href={t.href} data-testid={`tile-${t.id}`}>
          <span className="tile-icon">{t.icon}</span>
          <span className="tile-title">{t.title}</span>
          <span className="tile-hint">{t.hint}</span>
        </a>
      ))}
    </nav>
  );
}

function ProjectsPanel({ projects }: { projects: ProjectSummary[] }) {
  const [creating, setCreating] = useState(false);
  const top = projects.filter((p) => !p.parent_id);
  return (
    <section className="card projects-panel" data-testid="projects-panel">
      <header className="panel-header">
        <span className="panel-icon">
          <IconSparkle size={20} />
        </span>
        <div>
          <h2>Your work, organized automatically</h2>
          <p className="muted">Projects, topics and people inferred from your documents.</p>
        </div>
        <a className="btn btn-soft btn-sm" href="#/projects" data-testid="view-all-projects">
          View all projects <IconArrowRight size={13} />
        </a>
      </header>
      <div className="project-row">
        {top.slice(0, 3).map((p) => (
          <ProjectCard key={p.id} project={p} tint={projectTint(p.id)} />
        ))}
        <button className="project-card project-card-new" onClick={() => setCreating(true)} data-testid="home-new-project">
          <IconPlus size={18} />
          <span>New project</span>
        </button>
      </div>
      {creating && <NewProjectModal projects={projects} onClose={() => setCreating(false)} />}
    </section>
  );
}

/** "Your work at a glance": counts, recent activity and the biggest projects. */
function GlanceCard({ overview: o, projects }: { overview?: Overview; projects?: ProjectSummary[] }) {
  const top = [...(projects ?? [])].filter((p) => p.doc_count > 0 && !p.parent_id).sort((a, b) => b.doc_count - a.doc_count).slice(0, 5);
  const max = Math.max(1, ...top.map((p) => p.doc_count));
  const icon = { enriched: <IconCheckCircle size={16} />, captured: <IconFile size={16} />, project: <IconSparkle size={16} /> } as const;
  return (
    <div className="card rail-card" data-testid="glance">
      <section className="rail-block">
      <h2 className="rail-title">
        <IconBarChart size={17} /> Your work at a glance
      </h2>
      {!o ? (
        <Spinner />
      ) : (
        <ul className="glance-list">
          <GlanceRow icon={<IconFolder size={16} />} label="Projects" value={o.projects} extra={o.new_projects > 0 ? `+${o.new_projects}` : undefined} href="#/projects" />
          <GlanceRow icon={<IconLayers size={16} />} label="Collections" value={o.collections} href="#/collections" />
          <GlanceRow icon={<IconUsers size={16} />} label="People" value={o.people} href="#/people" />
          <GlanceRow icon={<IconFile size={16} />} label="Documents" value={o.docs} href="#/search" />
        </ul>
      )}
      </section>
      {o && o.activity.length > 0 && (
        <section className="rail-block">
          <h2 className="rail-title">
            <IconActivity size={17} /> Recent activity
          </h2>
          <ul className="activity-list" data-testid="activity">
            {o.activity.map((a) => (
              <li key={`${a.kind}-${a.label}`} className={`activity-${a.kind}`}>
                <span className="activity-icon">{icon[a.kind]}</span>
                {a.project_id ? <a href={`#/projects/${encodeURIComponent(a.project_id)}`}>{a.label}</a> : <span>{a.label}</span>}
                <time className="faint">{relativeTime(a.at)}</time>
              </li>
            ))}
          </ul>
        </section>
      )}
      {top.length > 0 && (
        <section className="rail-block">
          <h2 className="rail-title">
            <IconTarget size={17} /> Top projects
          </h2>
          <ul className="top-projects" data-testid="top-projects">
            {top.map((p) => (
              <li key={p.id} data-tint={projectTint(p.id)}>
                <a href={`#/projects/${encodeURIComponent(p.id)}`}>
                  <span className="top-project-name">{p.name}</span>
                  <span className="bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(6, (p.doc_count / max) * 100)}%` }} />
                  </span>
                </a>
                <span className="faint">{plural(p.doc_count, "doc")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GlanceRow({ icon, label, value, extra, href }: { icon: ReactNode; label: string; value: number; extra?: string; href: string }) {
  return (
    <li>
      <a href={href} className="glance-row">
        <span className="glance-icon">{icon}</span>
        <span>{label}</span>
        <span className="glance-value">{value.toLocaleString()}</span>
        {extra && <span className="glance-extra">{extra}</span>}
      </a>
    </li>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning. Here’s what you’ve been reading." : h < 18 ? "Good afternoon. Here’s what you’ve been reading." : "Good evening. Here’s what you’ve been reading.";
}

const DISMISS_KEY = "faber:dismissed-pairing";

/** Nudge toward Settings when an extension is waiting for approval. Dismissal sticks until a new request arrives. */
function PairingBanner() {
  const pending = usePendingExtensions();
  const key = pending.map((x: ExtensionAccess) => x.id).sort().join(",");
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });
  if (pending.length === 0 || dismissed === key) return null;
  return (
    <div className="banner banner-attention" role="status" data-testid="pairing-banner">
      <IconAlert size={15} />
      <span>
        <strong>{pending.length === 1 ? "A browser extension is asking for access." : `${pending.length} browser extensions are asking for access.`}</strong> Approve it in Settings to start
        capturing docs.
      </span>
      <a className="btn btn-sm btn-primary" href="#/settings/capture">
        Review
      </a>
      <button
        className="icon-btn"
        aria-label="Dismiss"
        data-testid="pairing-banner-dismiss"
        onClick={() => {
          try {
            sessionStorage.setItem(DISMISS_KEY, key);
          } catch {
            /* storage unavailable: dismiss for this render only */
          }
          setDismissed(key);
        }}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

function HomeSearch() {
  const [q, setQ] = useState("");
  return (
    <form
      className="home-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        navigate(`/search${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
      }}
    >
      <IconSearch size={18} />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your docs, projects, people — by what you remember"
        aria-label="Search"
        data-testid="home-search"
      />
      <button type="button" className="kbd-btn" onClick={() => openLauncher(q)} title="Open the launcher" data-testid="home-launcher">
        <kbd>⌘K</kbd>
      </button>
    </form>
  );
}

function DigestView({ d, projects }: { d: Digest; projects: ProjectSummary[] }) {
  const empty = d.pinned.length + d.recent.length + d.frequent.length + d.resurfacing.length === 0;
  return (
    <>
      {d.waiting_for_content.total > 0 && <WaitingBanner w={d.waiting_for_content} />}
      {empty ? (
        <EmptyState title="Nothing here yet" testId="digest-empty">
          Enable a source in <a href="#/settings/capture">Settings → Capture & Sources</a> and open a few docs, or run <code>faber import-chrome</code> to seed from your browser
          history.
        </EmptyState>
      ) : (
        <div className="digest-grid" data-testid="digest">
          <Section title="Recent" icon={<IconClock size={17} />} hint="Last 7 days" id="recent" docs={d.recent} empty="Nothing opened this week." />
          <ContinueWorking d={d} projects={projects} />
          <Section title="Pinned" icon={<IconBookmark size={17} />} id="pinned" docs={d.pinned} empty="Pin docs you keep coming back to." />
          <Section
            title="Resurfacing"
            icon={<IconRefresh size={17} />}
            hint="You used to open these"
            id="resurfacing"
            docs={d.resurfacing}
            extra={(x) => relativeTime(x.last_seen_at)}
            empty="Docs you used regularly but haven’t opened lately show up here."
          />
          {d.new_in_collections.map((c) => (
            <Section
              key={c.collection.id}
              id={`collection-${c.collection.id}`}
              icon={<IconLayers size={17} />}
              title={
                <a href={`#/collections/${c.collection.id}`} className="section-link">
                  New in {c.collection.name} <IconArrowRight size={12} />
                </a>
              }
              hint="First seen in the last 14 days"
              docs={c.docs}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Active projects with fresh docs, then the docs you open most: the places to pick up from. */
function ContinueWorking({ d, projects }: { d: Digest; projects: ProjectSummary[] }) {
  const drawer = useDrawer();
  const active = projects.filter((p) => p.active && p.recent_doc_count > 0).slice(0, 3);
  const docs = d.frequent.slice(0, Math.max(1, 5 - active.length));
  return (
    <section className="card digest-section" data-testid="digest-frequent">
      <header className="section-header">
        <span className="section-icon">
          <IconPlay size={15} />
        </span>
        <h2>Continue working</h2>
      </header>
      {active.length + docs.length === 0 ? (
        <p className="section-empty">Projects and docs you return to show up here.</p>
      ) : (
        <ul className="continue-list">
          {active.map((p, i) => (
            <li key={p.id}>
              <a className="continue-row" href={`#/projects/${encodeURIComponent(p.id)}`} data-tint={projectTint(p.id)}>
                <span className="project-folder project-folder-sm">
                  <IconFolder size={16} />
                </span>
                <span className="continue-text">
                  <span className="continue-title">{p.name}</span>
                  <span className="continue-sub">{plural(p.recent_doc_count, "doc")} opened this week</span>
                </span>
                <IconChevron size={14} />
              </a>
              {i === active.length - 1 && docs.length > 0 && <div className="continue-sep" />}
            </li>
          ))}
          {docs.map((doc: Doc) => (
            <li key={doc.id}>
              <button className="continue-row" onClick={() => drawer.openDoc(doc.id)}>
                <SourceIcon source={doc.source} size={18} />
                <span className="continue-text">
                  <span className="continue-title">{docTitle(doc)}</span>
                  <span className="continue-sub">
                    Opened {doc.visit_count}× · {relativeTime(doc.last_seen_at)}
                  </span>
                </span>
                <IconChevron size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WaitingBanner({ w }: { w: Digest["waiting_for_content"] }) {
  const parts = Object.entries(w.by_source)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([s, n]) => `${n} ${SOURCE_LABELS[s as keyof typeof SOURCE_LABELS] ?? s}`);
  return (
    <div className="banner banner-info" data-testid="waiting-banner">
      <IconAlert size={15} />
      <span>
        <strong>{plural(w.total, "doc")} waiting for text</strong>
        {parts.length > 0 && <span className="muted"> ({parts.join(", ")})</span>}. The extension only fetches sources you’ve enabled.
      </span>
      <a className="btn btn-sm" href="#/settings/capture">
        Open watchlist
      </a>
    </div>
  );
}

function Section({
  title,
  hint,
  icon,
  docs,
  id,
  extra,
  empty,
}: {
  title: ReactNode;
  hint?: string;
  icon?: ReactNode;
  docs: Doc[];
  id: string;
  extra?: (d: Doc) => ReactNode;
  empty?: string;
}) {
  if (docs.length === 0 && !empty) return null;
  return (
    <section className="card digest-section" data-testid={`digest-${id}`}>
      <header className="section-header">
        {icon && <span className="section-icon">{icon}</span>}
        <h2>{title}</h2>
        {hint && <span className="section-hint">{hint}</span>}
      </header>
      <DocList docs={docs.slice(0, 6)} extra={extra} empty={<p className="section-empty">{empty}</p>} />
    </section>
  );
}
