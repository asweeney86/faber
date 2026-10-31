import { useMemo, useState } from "react";
import { api, hostOf, plural, relativeTime, useAsync } from "../lib";
import { IconCalendar, IconExternal, IconSearch, IconUsers } from "../components/icons";
import { DocList, EmptyState, ErrorBanner, LoadError, PageHeader, Spinner } from "../components/ui";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/** Stable hue per name so avatars are recognisable across pages. */
function hue(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, ["--h" as string]: hue(name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function PeoplePage() {
  const people = useAsync(() => api.people(), []);
  const meetings = useAsync(() => api.meetings(), []);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (people.data ?? []).filter((p) => !f || p.name.toLowerCase().includes(f) || p.email?.toLowerCase().includes(f));
  }, [people.data, filter]);

  return (
    <div className="page">
      <PageHeader title="People & meetings" subtitle="Everyone who shows up in your docs, and the meetings you opened them from." />
      <div className="inline-search">
        <IconSearch size={15} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter people…" aria-label="Filter people" data-testid="people-filter" />
      </div>
      {people.error && <ErrorBanner error={people.error} onRetry={people.reload} />}
      {!people.data && !people.error && <Spinner />}
      {people.data && people.data.length === 0 && (
        <EmptyState title="No people yet" icon={<IconUsers size={22} />} testId="people-empty">
          People are extracted from docs as they’re enriched.
        </EmptyState>
      )}
      {people.data && people.data.length > 0 && shown.length === 0 && <EmptyState title={`Nobody matches “${filter}”`} />}
      {shown.length > 0 && (
        <div className="card table-card">
          <table className="table table-fixed" data-testid="people-table">
            <colgroup>
              <col />
              <col style={{ width: 80 }} />
              <col style={{ width: 130 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Docs</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} data-testid="person-row">
                  <td>
                    <a href={`#/people/${p.id}`} className="person-link">
                      <Avatar name={p.name} size={24} />
                      <span className="ellipsis">{p.name}</span>
                      {p.email && <span className="muted small ellipsis">{p.email}</span>}
                    </a>
                  </td>
                  <td className="num">{p.doc_count}</td>
                  <td className="muted">{p.last_seen_at ? relativeTime(p.last_seen_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="people-meetings" data-testid="meetings-list">
        <h2 className="subhead">Meetings</h2>
        {meetings.data && meetings.data.length === 0 && (
          <p className="muted small">No meetings yet. Turn on Google Calendar in the watchlist and docs you open from an event get linked to it.</p>
        )}
        {meetings.data && meetings.data.length > 0 && (
          <div className="card list-section">
            <div className="link-list">
              {meetings.data.map((m) => (
                <a key={m.id} href={`#/meetings/${m.id}`} className="link-row" data-testid="meeting-row">
                  <IconCalendar size={14} />
                  <span className="ellipsis">{m.title}</span>
                  <span className="muted">
                    {plural(m.doc_count, "doc")} · {relativeTime(m.last_seen_at)}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function PersonPage({ id }: { id: string }) {
  const person = useAsync(() => api.person(id), [id]);
  const p = person.data;
  return (
    <div className="page">
      <a className="back-link" href="#/people">
        ← People
      </a>
      {person.error && !p && <LoadError error={person.error} onRetry={person.reload} what="Person" backHref="#/people" backLabel="All people" />}
      {!p && !person.error && <Spinner />}
      {p && (
        <>
          <header className="person-header">
            <Avatar name={p.name} size={48} />
            <div>
              <h1 data-testid="person-name">{p.name}</h1>
              <p className="page-subtitle">
                {plural(p.doc_count, "doc")}
                {p.email ? ` · ${p.email}` : ""}
                {p.last_seen_at ? ` · last seen ${relativeTime(p.last_seen_at)}` : ""}
              </p>
            </div>
            <a className="btn btn-sm person-search" href={`#/search?person=${encodeURIComponent(p.name)}`}>
              <IconSearch size={13} /> Search their docs
            </a>
          </header>
          <div className="two-col">
            <section className="card list-section" data-testid="person-docs">
              <header className="section-header">
                <h2>Docs</h2>
              </header>
              <DocList docs={p.docs} empty={<p className="section-empty">No docs.</p>} />
            </section>
            <section className="card list-section" data-testid="related-people">
              <header className="section-header">
                <h2>Often appears with</h2>
              </header>
              {p.related_people.length === 0 ? (
                <p className="section-empty">Nobody yet.</p>
              ) : (
                <ul className="people-mini">
                  {p.related_people.map((r) => (
                    <li key={r.id}>
                      <a href={`#/people/${r.id}`} className="person-link">
                        <Avatar name={r.name} size={22} />
                        <span>{r.name}</span>
                        <span className="muted small">{r.count} shared</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export function MeetingPage({ id }: { id: string }) {
  const m = useAsync(() => api.meeting(id), [id]);
  const d = m.data;
  return (
    <div className="page">
      <a className="back-link" href="#/people">
        ← People & meetings
      </a>
      {m.error && !d && <LoadError error={m.error} onRetry={m.reload} what="Meeting" backHref="#/people" backLabel="All meetings" />}
      {!d && !m.error && <Spinner />}
      {d && (
        <>
          <PageHeader
            title={
              <span className="meeting-title" data-testid="meeting-title">
                <IconCalendar size={20} /> {d.title}
              </span>
            }
            subtitle={`${plural(d.doc_count, "doc")} opened from this meeting · last ${relativeTime(d.last_seen_at)}`}
            actions={
              d.url ? (
                <a className="btn" href={d.url} target="_blank" rel="noreferrer">
                  Open in {hostOf(d.url) ?? "calendar"} <IconExternal size={12} />
                </a>
              ) : undefined
            }
          />
          <section className="card list-section">
            <DocList docs={d.docs} empty={<p className="section-empty">No docs linked yet.</p>} />
          </section>
        </>
      )}
    </div>
  );
}
