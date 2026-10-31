import { useState } from "react";
import { api, useAsync } from "../lib";
import { IconCheck, IconCopy } from "./icons";
import { Spinner } from "./ui";
import { useOpenAddDoc } from "./AddDoc";

const IMPORT_CMD = 'bun faber import-chrome --profile "Work"';
const BUILD_CMD = "cd packages/extension && bun run build";

export function CopyCommand({ cmd, testId }: { cmd: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-cmd" data-testid={testId}>
      <code>{cmd}</code>
      <button
        className="icon-btn"
        aria-label={copied ? "Copied" : "Copy command"}
        title={copied ? "Copied" : "Copy"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(cmd);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked: the command is still selectable */
          }
        }}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  );
}

interface Step {
  id: string;
  title: string;
  done: boolean;
  optional?: boolean;
  body: React.ReactNode;
  action?: { label: string; href: string };
}

/**
 * First-run checklist with live status: extension approved → a Google source enabled → (optional) history import.
 * Shown on Home and Search until the library has docs.
 */
export function SetupChecklist() {
  const openAdd = useOpenAddDoc();
  const exts = useAsync(() => api.extensions(), []);
  const settings = useAsync(() => api.settings(), []);
  if (!exts.data || !settings.data)
    return (
      <div className="card card-pad setup">
        <Spinner />
      </div>
    );
  const extDone = exts.data.some((x) => x.state === "approved" || x.state === "config");
  const extPending = exts.data.some((x) => x.state === "pending");
  const watchDone = settings.data.watchlist.some((r) => r.builtin && r.enabled && r.extractor !== "gcal");
  const steps: Step[] = [
    {
      id: "extension",
      title: extPending && !extDone ? "Approve the browser extension" : "Install and approve the browser extension",
      done: extDone,
      body: extPending ? (
        <>An extension is waiting for approval in Settings.</>
      ) : (
        <>
          Build it, then load <code>packages/extension/build</code> from <code>chrome://extensions</code> → <em>Load unpacked</em>. It asks for access here the first time it
          connects.
          <CopyCommand cmd={BUILD_CMD} />
        </>
      ),
      action: { label: extPending ? "Review request" : "Open Settings", href: "#/settings/capture" },
    },
    {
      id: "watchlist",
      title: "Turn on Google Docs, Slides or Sheets",
      done: watchDone,
      body: <>Nothing is captured until you enable a source in the watchlist.</>,
      action: { label: "Open watchlist", href: "#/settings/capture" },
    },
    {
      id: "import",
      title: "Import your Chrome history",
      optional: true,
      done: false,
      body: (
        <>
          Seed the library with docs you opened in the last 90 days. Run this in the repo:
          <CopyCommand cmd={IMPORT_CMD} testId="import-command" />
        </>
      ),
    },
  ];
  const current = steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done);
  return (
    <section className="card setup" data-testid="setup-checklist">
      <header className="setup-head">
        <h2>Set up Faber</h2>
        <p className="muted">Three steps and your docs start organising themselves.</p>
      </header>
      <ol className="setup-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={`setup-step${s.done ? " is-done" : ""}${current?.id === s.id ? " is-current" : ""}`} data-testid={`setup-${s.id}`} data-done={s.done}>
            <span className="setup-mark" aria-hidden="true">
              {s.done ? <IconCheck size={12} /> : i + 1}
            </span>
            <div className="setup-body">
              <div className="setup-title">
                {s.title}
                {s.optional && <span className="muted small"> · optional</span>}
                {s.done && <span className="sr-only"> (done)</span>}
              </div>
              {!s.done && <div className="setup-text">{s.body}</div>}
            </div>
            {!s.done && s.action && (
              <a className={`btn btn-sm${current?.id === s.id ? " btn-primary" : ""}`} href={s.action.href}>
                {s.action.label}
              </a>
            )}
          </li>
        ))}
      </ol>
      <footer className="setup-foot">
        <span className="muted small">No extension handy?</span>
        <button className="btn btn-sm" onClick={() => openAdd()} data-testid="setup-add">
          Or add a doc by hand
        </button>
      </footer>
    </section>
  );
}
