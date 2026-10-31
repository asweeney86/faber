import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, type AskCitation, type AskResponse } from "@faber/shared";
import { projectTree } from "./Projects";
import { api, docTitle, navigate, toError, useAsync, useRoute } from "../lib";
import { IconAlert, IconExternal, IconSparkle } from "../components/icons";
import { ErrorBanner, PageHeader, Spinner, useDrawer, useLive, withCode } from "../components/ui";

/** Suggestions built from the user's own top projects and tags, so they always match their library. */
function useSuggestions(enabled: boolean): string[] {
  const facets = useAsync(() => (enabled ? api.facets() : Promise.resolve(null)), [enabled], { live: false });
  return useMemo(() => {
    const f = facets.data;
    if (!f) return [];
    const projects = f.projects.slice(0, 2).map((p) => p.label ?? p.value);
    const tags = f.tags.slice(0, 3).map((t) => t.value.replace(/-/g, " "));
    const out: string[] = [];
    if (projects[0]) out.push(`What’s the latest on ${projects[0]}?`);
    if (tags[0]) out.push(`What did we decide about ${tags[0]}?`);
    if (projects[1]) out.push(`Who is working on ${projects[1]}?`);
    else if (tags[1]) out.push(`What are the open questions on ${tags[1]}?`);
    return out.slice(0, 3);
  }, [facets.data]);
}

export function AskPage() {
  const route = useRoute();
  const live = useLive();
  const empty = live.status?.docs === 0;
  const suggestions = useSuggestions(!!live.status && !empty);
  const [question, setQuestion] = useState(() => route.query.get("q") ?? "");
  // Optional scope: answer only from one project's documents (#/ask?project=Atlas).
  const project = route.query.get("project");
  const scope = useAsync(() => (project ? api.project(project) : Promise.resolve(null)), [project]);
  const projectName = scope.data?.name ?? project;
  const projectList = useAsync(() => api.projects(), []);
  // The conversation so far: each follow-up is asked with the earlier turns as context.
  const [thread, setThread] = useState<{ question: string; result: AskResponse }[]>([]);
  const [asked, setAsked] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!loading) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(t);
  }, [loading]);

  const ask = async (q = question) => {
    const text = q.trim();
    if (!text || loading) return;
    const id = ++seq.current;
    setAsked(text);
    // The opening question lives in the URL, so a conversation can be reloaded or shared.
    // (Follow-ups don't: on their own they'd be asked without their context.)
    if (thread.length === 0) {
      const qs = new URLSearchParams({ q: text, ...(project ? { project } : {}) });
      navigate(`/ask?${qs.toString()}`, { replace: true });
    }
    setLoading(true);
    setElapsed(0);
    setErr(null);
    try {
      const history = thread.map((t) => ({ question: t.question, answer: t.result.answer }));
      const r = await api.ask({ question: text, history, filters: project ? { project: [project] } : undefined });
      if (id === seq.current) {
        setThread((t) => [...t, { question: text, result: r }]);
        setQuestion("");
      }
    } catch (e) {
      if (id === seq.current) setErr(toError(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  };

  // Opening #/ask?q=… (a reload, a shared link, "Ask instead" from search) asks it.
  const initial = useRef(route.query.get("q"));
  useEffect(() => {
    if (initial.current?.trim() && !empty && live.status) {
      const q = initial.current;
      initial.current = null;
      void ask(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty, live.status]);

  const form = (
  <form
    className="ask-box"
    onSubmit={(e) => {
      e.preventDefault();
      void ask();
    }}
  >
    <textarea
      value={question}
      disabled={empty}
      autoFocus
      rows={2}
      onChange={(e) => setQuestion(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void ask();
        }
      }}
      placeholder={thread.length ? "Ask a follow-up…" : "What did we decide about…"}
      aria-label="Question"
      data-testid="ask-input"
    />
    <div className="ask-actions">
      <span className="muted small">{empty ? "Add some docs first — answers come only from your library." : "↵ to ask · ⇧↵ for a new line"}</span>
      {thread.length > 0 && (
        <button type="button" className="btn btn-ghost" onClick={() => {
                seq.current++; // drop an answer still on its way
                setLoading(false);
                setThread([]);
                setQuestion("");
                navigate(project ? `/ask?project=${encodeURIComponent(project)}` : "/ask", { replace: true });
              }} data-testid="ask-new">
          New conversation
        </button>
      )}
      <button className="btn btn-primary" type="submit" disabled={empty || !question.trim() || loading} data-testid="ask-submit">
        {loading ? <Spinner size={12} /> : <IconSparkle size={14} />} Ask
      </button>
    </div>
  </form>
  );

  return (
    <div className="page page-narrow">
      <PageHeader title="Ask" subtitle="Ask a question; the answer is written from your docs, with citations." />
      <label className="ask-scope" data-testid="ask-scope">
        Answer from
        <select
          className="input input-sm"
          value={scope.data?.id ?? project ?? ""}
          onChange={(e) => {
            seq.current++;
            setLoading(false);
            setThread([]);
            navigate(e.target.value ? `/ask?project=${encodeURIComponent(e.target.value)}` : "/ask");
          }}
          aria-label="Answer from"
          data-testid="ask-scope-select"
        >
          <option value="">All documents</option>
          {projectTree(projectList.data ?? []).map(({ project: p, depth }) => (
            <option key={p.id} value={p.id}>
              {"  ".repeat(depth)}
              {p.name}
            </option>
          ))}
          {project && !scope.data && <option value={project}>{projectName}</option>}
        </select>
      </label>
      {thread.length === 0 && form}

      {empty && (
        <p className="muted small ask-empty" data-testid="ask-empty">
          Your library is empty. <a href="#/">Finish setup</a> to start capturing docs.
        </p>
      )}
      {thread.length === 0 && !loading && !err && suggestions.length > 0 && (
        <div className="examples" data-testid="ask-suggestions">
          <span className="muted small">Try:</span>
          {suggestions.map((ex) => (
            <button key={ex} className="chip" onClick={() => void ask(ex)}>
              {ex}
            </button>
          ))}
        </div>
      )}

      <div className="ask-thread" data-testid="ask-thread">
        {thread.map((t, i) => (
          <Answer key={i} turn={i} result={t.result} question={t.question} />
        ))}
      </div>
      {loading && (
        <div className="card card-pad ask-loading" data-testid="ask-loading" aria-live="polite">
          <Spinner size={16} />
          <div>
            <strong>Reading your docs…</strong>
            <div className="muted small">{elapsed < 8 ? "Finding relevant passages and drafting an answer." : `${elapsed}s — local models can take half a minute or more.`}</div>
          </div>
        </div>
      )}
      {err &&
        (err instanceof ApiRequestError && err.status === 503 ? (
          <div className="banner banner-offline" role="alert" data-testid="ask-unavailable">
            <IconAlert size={15} />
            <span>
              <strong>The answer model isn’t available.</strong> {withCode(err.message)}
            </span>
            <button className="btn btn-sm" onClick={() => void ask(asked)}>
              Try again
            </button>
          </div>
        ) : (
          <ErrorBanner error={err} onRetry={() => void ask(asked)} />
        ))}
      {thread.length > 0 && <div className="ask-followup">{form}</div>}
    </div>
  );
}

function Answer({ result, question, turn = 0 }: { result: AskResponse; question: string; turn?: number }) {
  const drawer = useDrawer();
  const [flash, setFlash] = useState<number | null>(null);
  const jump = (n: number) => {
    document.getElementById(`cite-${turn}-${n}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setFlash(n);
    setTimeout(() => setFlash(null), 1200);
  };
  const known = new Set(result.citations.map((c) => c.n));
  const paragraphs = result.answer.split(/\n{2,}/).filter((p) => p.trim());
  const referenced = citedNumbers(result.answer);
  const cited = result.citations.filter((c) => referenced.has(c.n));
  const uncited = result.citations.filter((c) => !referenced.has(c.n));
  return (
    <section className="card answer" data-testid="ask-answer">
      <div className="answer-q">{question}</div>
      <div className="answer-body">
        {paragraphs.map((p, i) => (
          <p key={i}>{renderWithCitations(p, known, jump)}</p>
        ))}
      </div>
      <div className="answer-meta muted small">
        {result.provider}/{result.model} · {(result.took_ms / 1000).toFixed(1)}s
      </div>
      {cited.length > 0 && (
        <ol className="citations" data-testid="citations">
          {cited.map((c) => (
            <Citation turn={turn} key={c.n} c={c} flash={flash === c.n} onOpen={() => drawer.openDoc(c.doc_id)} />
          ))}
        </ol>
      )}
      {uncited.length > 0 && (
        <details className="also-read" data-testid="also-read" open={cited.length === 0}>
          <summary>Also read ({uncited.length})</summary>
          <ol className="citations">
            {uncited.map((c) => (
              <Citation turn={turn} key={c.n} c={c} flash={false} onOpen={() => drawer.openDoc(c.doc_id)} uncited />
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function renderWithCitations(text: string, known: Set<number>, jump: (n: number) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const nums = m[1]!.split(",").map((s) => Number(s.trim()));
    nums.forEach((n) => {
      out.push(
        known.has(n) ? (
          <button key={`${m!.index}-${n}`} className="cite-ref" onClick={() => jump(n)} data-testid="cite-ref" aria-label={`Source ${n}`}>
            {n}
          </button>
        ) : (
          <sup key={`${m!.index}-${n}`}>[{n}]</sup>
        ),
      );
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Source numbers the answer actually references, e.g. "[1]" or "[2, 4]". */
function citedNumbers(answer: string): Set<number> {
  const out = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) for (const n of m[1]!.split(",")) out.add(Number(n.trim()));
  return out;
}

function Citation({ c, flash, onOpen, uncited, turn = 0 }: { c: AskCitation; flash: boolean; onOpen: () => void; uncited?: boolean; turn?: number }) {
  return (
    <li id={`cite-${turn}-${c.n}`} className={flash ? "is-flash" : ""} data-testid={uncited ? "uncited-source" : "citation"}>
      <span className="cite-n">{c.n}</span>
      <div className="cite-body">
        <div className="cite-head">
          <button className="cite-title" onClick={onOpen}>
            {docTitle(c)}
          </button>
          <a href={c.url} target="_blank" rel="noreferrer" className="icon-btn" aria-label={`Open ${c.title}`}>
            <IconExternal size={12} />
          </a>
        </div>
        <p className="cite-passage">{c.passage}</p>
      </div>
    </li>
  );
}
