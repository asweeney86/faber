import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACCENTS,
  DARK_FLAVORS,
  FLAVOR_LABELS,
  FLAVORS,
  flavorSwatches,
  normalisePattern,
  parsePattern,
  DEFAULT_LAUNCHER_HOTKEY,
  shortcutFromEvent,
  shortcutLabel,
  shortcutWarning,
  SUGGESTED_SOURCES,
  sameModel,
  type ModelKind,
  type ModelsState,
  type Appearance,
  type ExtensionAccess,
  type Flavor,
  type OrganizeRule,
  type Settings,
  type ThemeChoice,
  type WatchRule,
} from "@faber/shared";
import { FaberIcon, IS_MAC } from "@faber/ui";
import { api, emitChange, fullDate, navigate, plural, relativeTime, useAsync } from "../lib";
import { useAppearanceState } from "../appearance";
import {
  IconAlert,
  IconCheck,
  IconCpu,
  IconFolder,
  IconKeyboard,
  IconMonitor,
  IconPalette,
  IconPlug,
  IconPlus,
  IconShield,
  IconSitemap,
  IconTrash,
} from "../components/icons";
import { ErrorBanner, PageHeader, Spinner, usePendingExtensions, withCode } from "../components/ui";

type SectionId = "appearance" | "shortcuts" | "capture" | "ai" | "organization" | "privacy";

const SECTIONS: { id: SectionId; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "appearance", label: "Appearance", hint: "Theme, accent, density", icon: <IconPalette size={17} /> },
  { id: "shortcuts", label: "Shortcuts", hint: "Keyboard and launcher", icon: <IconKeyboard size={17} /> },
  { id: "capture", label: "Capture & Sources", hint: "Extension, watchlist, sites", icon: <IconPlug size={17} /> },
  { id: "ai", label: "AI & Processing", hint: "Models, enrichment, index", icon: <IconCpu size={17} /> },
  { id: "organization", label: "Organization", hint: "Projects and topics", icon: <IconSitemap size={17} /> },
  { id: "privacy", label: "Privacy & Data", hint: "Storage, export, deletion", icon: <IconShield size={17} /> },
];

export function SettingsPage({ section }: { section?: string }) {
  const pending = usePendingExtensions();
  const fallback: SectionId = pending.length > 0 ? "capture" : "appearance";
  const active = (SECTIONS.find((x) => x.id === section)?.id ?? fallback) as SectionId;
  // Pin the section in the URL, so it doesn't change under you (e.g. once a request is
  // approved); unknown sections redirect rather than silently showing another one.
  useEffect(() => {
    if (!section || !SECTIONS.some((x) => x.id === section)) navigate(`/settings/${fallback}`, { replace: true });
  }, [section, fallback]);
  const meta = SECTIONS.find((x) => x.id === active)!;
  return (
    <div className="page settings-page">
      <PageHeader title="Settings" subtitle="Control what Faber captures, how it processes documents and how it looks." />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <a
              key={x.id}
              href={`#/settings/${x.id}`}
              className={`settings-nav-item${x.id === active ? " is-active" : ""}`}
              aria-current={x.id === active ? "page" : undefined}
              data-testid={`settings-nav-${x.id}`}
            >
              <span className="settings-nav-icon">{x.icon}</span>
              <span className="settings-nav-text">
                <span>{x.label}</span>
                <span className="settings-nav-hint">{x.hint}</span>
              </span>
              {x.id === "capture" && pending.length > 0 && <span className="nav-attention">{pending.length}</span>}
            </a>
          ))}
        </nav>
        <div className="settings-content" data-testid={`settings-${active}`}>
          <h2 className="settings-title">{meta.label}</h2>
          {active === "appearance" && <AppearanceSection />}
          {active === "shortcuts" && <ShortcutsSection />}
          {active === "capture" && (
            <>
              <ExtensionsSection />
              <WatchlistSection />
              <Bookmarklet />
            </>
          )}
          {active === "ai" && <ModelsSection />}
          {active === "organization" && <OrganizationSection />}
          {active === "privacy" && <PrivacySection />}
        </div>
      </div>
    </div>
  );
}

// ---------- Appearance ----------

const THEME_CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: "mocha", label: FLAVOR_LABELS.mocha },
  { id: "macchiato", label: FLAVOR_LABELS.macchiato },
  { id: "frappe", label: FLAVOR_LABELS.frappe },
  { id: "latte", label: FLAVOR_LABELS.latte },
  { id: "system", label: "System" },
];

function AppearanceSection() {
  const { value, set } = useAppearanceState();
  const [err, setErr] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  // A sequence number so a slow earlier save can't land after a later one; a failed
  // save rolls the preview back to what was applied when it was clicked.
  const seq = useRef(0);
  const update = async (patch: Partial<Appearance>) => {
    const previous = value;
    const next = { ...value, ...patch };
    set(next); // preview instantly
    setErr(null);
    const id = ++seq.current;
    try {
      const s = await api.saveSettings({ appearance: next });
      if (id !== seq.current) return;
      set(s.appearance);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      if (id !== seq.current) return;
      set(previous);
      setErr(e instanceof Error ? e : new Error(String(e)));
    }
  };
  const flavorForSwatches = (id: ThemeChoice): Flavor => (id === "system" ? value.dark_flavor : id);
  return (
    <>
      {err && <ErrorBanner error={err} />}
      <section className="card settings-section" data-testid="appearance">
        <header className="settings-head">
          <h3>Theme</h3>
          <p className="muted">Catppuccin flavors. Applies to the app, the launcher and the browser extension.{saved && <span className="saved-note"> Saved</span>}</p>
        </header>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEME_CHOICES.map((t) => {
            const on = value.theme === t.id;
            return (
              <button
                key={t.id}
                role="radio"
                aria-checked={on}
                className={`theme-card${on ? " is-on" : ""}`}
                style={{ background: FLAVORS[flavorForSwatches(t.id)].base, color: FLAVORS[flavorForSwatches(t.id)].text }}
                onClick={() => void update({ theme: t.id })}
                data-testid={`theme-${t.id}`}
              >
                <span className="theme-check" aria-hidden="true">
                  {on ? <IconCheck size={13} /> : t.id === "system" ? <IconMonitor size={14} /> : null}
                </span>
                <span className="theme-name">{t.label}</span>
                <span className="theme-swatches" aria-hidden="true">
                  {flavorSwatches(flavorForSwatches(t.id)).map((c) => (
                    <span key={c} style={{ background: c }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        {value.theme === "system" && (
          <label className="inline-field">
            Dark flavor when your system is dark
            <select value={value.dark_flavor} onChange={(e) => void update({ dark_flavor: e.target.value as Flavor })} data-testid="dark-flavor">
              {DARK_FLAVORS.map((f) => (
                <option key={f} value={f}>
                  {FLAVOR_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className="card settings-section">
        <header className="settings-head">
          <h3>Accent color</h3>
          <p className="muted">Used for selection, buttons and links. Faber adjusts it where needed so text stays readable.</p>
        </header>
        <div className="accent-grid" role="radiogroup" aria-label="Accent color">
          {ACCENTS.map((a) => (
            <button
              key={a}
              role="radio"
              aria-checked={value.accent === a}
              aria-label={a}
              title={a[0]!.toUpperCase() + a.slice(1)}
              className={`accent-swatch${value.accent === a ? " is-on" : ""}`}
              style={{ background: `var(--c-${a})` }}
              onClick={() => void update({ accent: a })}
              data-testid={`accent-${a}`}
            >
              {value.accent === a && <IconCheck size={14} />}
            </button>
          ))}
        </div>
      </section>

      <section className="card settings-section">
        <header className="settings-head">
          <h3>Density</h3>
          <p className="muted">Compact fits more rows on screen; comfortable gives them room.</p>
        </header>
        <div className="segmented" role="radiogroup" aria-label="Density">
          {(["comfortable", "compact"] as const).map((d) => (
            <button key={d} role="radio" aria-checked={value.density === d} className={value.density === d ? "is-on" : ""} onClick={() => void update({ density: d })} data-testid={`density-${d}`}>
              {d === "comfortable" ? "Comfortable" : "Compact"}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

// ---------- Shortcuts ----------

function ShortcutsSection() {
  const settings = useAsync(() => api.settings(), []);
  const browser = settings.data?.shortcuts.browser;
  // Chrome reports "" when the user removed the shortcut.
  const browserKey = browser ? browser.label || null : IS_MAC ? "⌘⇧K" : "Ctrl+Shift+K";
  const rows: [string, string][] = [
    ["⌘K", "Open the launcher"],
    ["/", "Go to search"],
    ["A", "Add a bookmark"],
    ["Esc", "Close the launcher, a dialog or the details panel"],
  ];
  const launcher: [string, string][] = [
    ["↑ ↓", "Move through results"],
    ["↵", "Open (browse into a project, collection or person)"],
    ["⌘↵", "Open in a new tab"],
    ["⌘O", "Show the selection in the app"],
    ["⌘⇧C", "Copy the selected document’s link"],
    ["⇥ / ⇧⇥", "Next / previous section"],
    ["⌥R ⌥C ⌥P ⌥A ⌥O", "Recent, Collections, Pinned, Ask, open the app"],
  ];
  return (
    <>
      <section className="card settings-section" data-testid="global-shortcuts">
        <header className="settings-head">
          <h3>Open Faber from anywhere</h3>
          <p className="muted">Shortcuts that work in every app, not just here.</p>
        </header>
        {settings.error && !settings.data && <ErrorBanner error={settings.error} onRetry={settings.reload} />}
        {!settings.data && !settings.error && <Spinner />}
        {settings.data && (
          <div className="shortcut-rows">
            {IS_MAC && <LauncherHotkeyRow settings={settings.data} onSaved={settings.reload} />}
            <div className="shortcut-row" data-testid="browser-shortcut">
              <div className="shortcut-what">
                <strong>Browser launcher</strong>
                <span className="muted small">Search over the page you’re on (Faber browser extension). Chrome manages this shortcut.</span>
              </div>
              <div className="shortcut-keys">{browserKey ? <kbd>{browserKey}</kbd> : <span className="muted small">Not set</span>}</div>
              <div className="shortcut-actions">
                <CopyButton text="chrome://extensions/shortcuts" label="Copy Chrome’s shortcuts page" />
              </div>
              <p className="muted small shortcut-help">
                Paste <code>chrome://extensions/shortcuts</code> into the address bar and change “Open the Faber launcher”.
              </p>
            </div>
          </div>
        )}
      </section>
      <section className="card settings-section" data-testid="shortcuts">
        <header className="settings-head">
          <h3>In the app</h3>
        </header>
        <KeyTable rows={rows} />
      </section>
      <section className="card settings-section">
        <header className="settings-head">
          <h3>In the launcher</h3>
          <p className="muted">The same launcher opens with ⌘K here{browserKey ? <>, and with {browserKey} from any page in the browser</> : null}.</p>
        </header>
        <KeyTable rows={launcher} />
      </section>
    </>
  );
}

/** The Mac launcher's system-wide hotkey: shows what the app registered, and records a new one. */
function LauncherHotkeyRow({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const { launcher, launcher_active: active } = settings.shortcuts;
  const [recording, setRecording] = useState(false);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [held, setHeld] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  // Nothing saved yet: the app keeps what this Mac already had (maybe an old `defaults write`).
  const wanted = launcher ? shortcutLabel(launcher) : (active?.label ?? shortcutLabel(DEFAULT_LAUNCHER_HOTKEY));
  // The app picks the change up within a few seconds; until then it still has the old one.
  const pending = active && launcher !== null && active.ok && active.label !== wanted;

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keydown" && e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(false);
        setCandidate(null);
        return;
      }
      const mods = `${e.metaKey ? "⌘" : ""}${e.ctrlKey ? "⌃" : ""}${e.altKey ? "⌥" : ""}${e.shiftKey ? "⇧" : ""}`;
      setHeld(mods);
      if (e.type !== "keydown") return;
      const sc = shortcutFromEvent(e);
      if (sc) {
        setCandidate(sc);
        setRecording(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [recording]);

  const save = async (value: string) => {
    setSaving(true);
    setErr(null);
    try {
      await api.saveSettings({ shortcuts: { launcher: value } });
      setCandidate(null);
      onSaved();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setSaving(false);
    }
  };

  const warning = candidate ? shortcutWarning(candidate) : null;
  return (
    <div className="shortcut-row" data-testid="launcher-hotkey">
      <div className="shortcut-what">
        <strong>Mac launcher</strong>
        <span className="muted small">Search from any app (Faber Launcher in the menu bar).</span>
      </div>
      <div className="shortcut-keys">
        {recording ? (
          <span className="shortcut-recorder" data-testid="hotkey-recorder">
            {held ? <kbd>{held}</kbd> : null} Press the new shortcut… <span className="faint">(Esc to cancel)</span>
          </span>
        ) : candidate ? (
          <kbd data-testid="hotkey-candidate">{shortcutLabel(candidate)}</kbd>
        ) : (
          <kbd data-testid="hotkey-current">{wanted}</kbd>
        )}
      </div>
      <div className="shortcut-actions">
        {candidate ? (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setCandidate(null)} disabled={saving}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void save(candidate)} disabled={saving} data-testid="hotkey-save">
              {saving ? <Spinner size={12} /> : null} Save
            </button>
          </>
        ) : (
          <>
            {wanted !== shortcutLabel(DEFAULT_LAUNCHER_HOTKEY) && !recording && (
              <button className="btn btn-ghost btn-sm" onClick={() => void save(DEFAULT_LAUNCHER_HOTKEY)} disabled={saving} data-testid="hotkey-reset">
                Reset to {shortcutLabel(DEFAULT_LAUNCHER_HOTKEY)}
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={() => {
                setHeld("");
                setRecording((r) => !r);
              }}
              data-testid="hotkey-change"
            >
              {recording ? "Cancel" : "Change…"}
            </button>
          </>
        )}
      </div>
      <p className="muted small shortcut-help" data-testid="hotkey-status">
        {warning ? (
          <span className="warn">
            <IconAlert size={13} /> {warning}. Pick something else, or save it anyway.
          </span>
        ) : !active ? (
          <>
            The Faber Launcher app hasn’t connected yet. Install it with <code>faber setup</code>; it picks this shortcut up when it starts.
          </>
        ) : !active.ok ? (
          <span className="warn">
            <IconAlert size={13} /> Couldn’t use {wanted}: another app already has it. The launcher is still on {active.label}.
          </span>
        ) : pending ? (
          <>Switching the launcher to {wanted}…</>
        ) : (
          <>
            <IconCheck size={13} /> Active in Faber Launcher.
          </>
        )}
      </p>
      {err && <ErrorBanner error={err} />}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function KeyTable({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="key-table">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>
            {k.split(" ").map((part) => (
              <kbd key={part}>{part}</kbd>
            ))}
          </dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------- Capture ----------

function WatchlistSection() {
  const settings = useAsync(() => api.settings(), [], { live: false });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [local, setLocal] = useState<Settings | null>(null);
  const current = local ?? settings.data;

  const save = async (watchlist: WatchRule[]) => {
    if (!current) return;
    setLocal({ ...current, watchlist });
    setSaving(true);
    setErr(null);
    try {
      const saved = await api.saveSettings({ watchlist });
      setLocal(saved);
      emitChange();
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
      setLocal(null);
      settings.reload();
    } finally {
      setSaving(false);
    }
  };

  const setRule = (id: string, patch: Partial<WatchRule>) => current && void save(current.watchlist.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const builtins = current?.watchlist.filter((r) => r.builtin) ?? [];
  const custom = current?.watchlist.filter((r) => !r.builtin) ?? [];

  return (
    <section className="card settings-section" data-testid="watchlist">
      <header className="settings-head">
        <h3>Watchlist {saving && <span className="saved-note">Saving…</span>}</h3>
        <p className="muted">The browser extension only records pages that match an enabled rule. Everything starts off — nothing is captured until you turn it on.</p>
      </header>
      {err && <ErrorBanner error={err} />}
      {settings.error && !current && <ErrorBanner error={settings.error} onRetry={settings.reload} />}
      {!current && !settings.error && <Spinner />}
      {current && (
        <>
          <ul className="rules">
            {builtins.map((r) => (
              <RuleRow key={r.id} rule={r} onToggle={(enabled) => setRule(r.id, { enabled })} />
            ))}
          </ul>
          <h4 className="rules-subhead">Other sites</h4>
          {custom.length === 0 && <p className="muted small">No custom sites. Add wikis, issue trackers or any domain whose pages you want remembered.</p>}
          <ul className="rules">
            {custom.map((r) => (
              <RuleRow key={r.id} rule={r} onToggle={(enabled) => setRule(r.id, { enabled })} onDelete={() => void save(current.watchlist.filter((x) => x.id !== r.id))} />
            ))}
          </ul>
          <AddRule existing={current.watchlist} onAdd={(rule) => void save([...current.watchlist, rule])} />
          <SuggestedSources existing={current.watchlist} onAdd={(rule) => void save([...current.watchlist, rule])} />
          <p className="muted small note">Custom sites also need permission in the extension: open the extension’s options page and grant access when prompted.</p>
        </>
      )}
    </section>
  );
}

// ---------- AI & Processing ----------

function ModelsSection() {
  const status = useAsync(() => api.status(), []);
  const [models, setModels] = useState<ModelsState | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);

  const refresh = useCallback(() => api.models().then(setModels, (e: unknown) => setErr(e as Error)), []);
  useEffect(() => void refresh(), [refresh]);
  // Follow a download or re-index while it runs.
  const active = !!models && ((models.pull && !models.pull.error) || models.reindex_remaining > 0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [active, refresh]);

  const act = async (fn: () => Promise<ModelsState | void>) => {
    setBusy(true);
    setErr(null);
    try {
      const next = await fn();
      if (next) setModels(next);
      else await refresh();
      status.reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const choose = (kind: ModelKind, model: string) => act(() => api.setModel({ kind, model }));

  return (
    <>
      <section className="card settings-section" data-testid="providers">
        <header className="settings-head">
          <h3>Models</h3>
          <p className="muted">
            Faber runs these on this computer with Ollama. Faster models make new documents searchable sooner; larger ones are a little more thorough.
          </p>
        </header>
        {status.data && status.data.issues.length > 0 && (
          <ul className="settings-issues" data-testid="settings-issues">
            {status.data.issues.map((i) => (
              <li key={i}>
                <IconAlert size={14} /> <span>{withCode(i)}</span>
              </li>
            ))}
          </ul>
        )}
        {err && <ErrorBanner error={err} />}
        {!models && !err && <Spinner />}
        {models && (
          <div className="model-slots">
            <ModelPicker
              kind="enrich"
              title="Summaries"
              hint="Reads each document once and writes its summary, people, projects and tags. Ask uses it too."
              models={models}
              busy={busy}
              onChoose={choose}
              onDismiss={() => act(() => api.dismissModelPull())}
              ready={status.data?.enricher_ok}
            >
              {models.summaries_from_other_models > 0 && (
                <p className="model-note" data-testid="resummarise-note">
                  {plural(models.summaries_from_other_models, "document")} {models.summaries_from_other_models === 1 ? "has a summary" : "have summaries"} from another model or an
                  older version of Faber. New documents use {models.enrich.model}.{" "}
                  {queued !== null ? (
                    <span className="muted">Queued {plural(queued, "document")}.</span>
                  ) : (
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      data-testid="resummarise"
                      onClick={() =>
                        void act(async () => {
                          setQueued((await api.resummarise()).queued);
                        })
                      }
                    >
                      Re-summarise them
                    </button>
                  )}
                </p>
              )}
            </ModelPicker>
            <ModelPicker
              kind="embed"
              title="Search index"
              hint="Turns documents into vectors so search finds them by meaning, not just by words."
              models={models}
              busy={busy}
              onChoose={choose}
              onDismiss={() => act(() => api.dismissModelPull())}
              ready={status.data?.embedder_ok}
            >
              {models.reindex_remaining > 0 && (
                <p className="model-note" data-testid="reindex-progress">
                  <Spinner size={12} /> Re-indexing {plural(models.reindex_remaining, "document")} with {models.embed.model}. Keyword search works meanwhile.
                </p>
              )}
            </ModelPicker>
            {status.data && status.data.providers.ask !== status.data.providers.enrich && (
              <p className="muted small">
                Ask uses <code>{status.data.providers.ask}</code> (set under <code>[ask]</code> in config.toml).
              </p>
            )}
          </div>
        )}
        <p className="muted small">
          Remote providers (Anthropic, OpenAI-compatible) are set in <code className="wrap-anywhere">{status.data?.config_path ?? "config.toml"}</code> and only run when{" "}
          <code>privacy.allow_remote</code> is on.
        </p>
      </section>
      <section className="card settings-section" data-testid="processing">
        <header className="settings-head">
          <h3>Enrichment and index</h3>
          <p className="muted">Faber reads each document once, summarises it and extracts people, projects, tags and dates, then indexes it for search.</p>
        </header>
        {status.data && (
          <dl className="kv">
            <dt>Documents</dt>
            <dd>
              {status.data.docs.toLocaleString()} ({status.data.docs_with_content.toLocaleString()} with text, {status.data.enriched.toLocaleString()} enriched)
            </dd>
            <dt>Queue</dt>
            <dd data-testid="queue-state">
              {status.data.queue.pending} pending · {status.data.queue.running} running · {status.data.queue.error} failed
            </dd>
          </dl>
        )}
        <dl className="kv kv-commands">
          <dt>
            <code>faber requeue</code>
          </dt>
          <dd>Re-run enrichment for every document, e.g. after a prompt change.</dd>
          <dt>
            <code>faber reindex</code>
          </dt>
          <dd>Re-embed everything now (switching the search model here does this in the background).</dd>
          <dt>
            <code>faber enrich</code>
          </dt>
          <dd>Drain the queue in the foreground.</dd>
        </dl>
      </section>
    </>
  );
}


function ModelPicker(props: {
  kind: ModelKind;
  title: string;
  hint: string;
  models: ModelsState;
  busy: boolean;
  ready?: boolean;
  onChoose: (kind: ModelKind, model: string) => Promise<void>;
  onDismiss: () => Promise<void>;
  children?: React.ReactNode;
}) {
  const { kind, models, busy } = props;
  const slot = models[kind];
  const pull = models.pull?.kind === kind ? models.pull : null;
  const downloading = !!models.pull && !models.pull.error;
  const isChoice = slot.choices.some((c) => sameModel(c.id, slot.model));
  const [custom, setCustom] = useState(isChoice ? "" : slot.model);
  const name = `model-${kind}`;

  return (
    <div className="model-slot" data-testid={`models-${kind}`}>
      <div className="model-slot-head">
        <strong>{props.title}</strong>
        {props.ready === false ? <span className="pill pill-warn">not ready</span> : props.ready ? <span className="pill pill-ok">ready</span> : null}
      </div>
      <p className="muted small">{props.hint}</p>
      {!slot.editable ? (
        <p data-testid={`model-${kind}-fixed`}>
          <code>
            {slot.provider}/{slot.model}
          </code>{" "}
          <span className="muted small">set in config.toml</span>
        </p>
      ) : (
        <div className="model-choices" role="radiogroup" aria-label={props.title}>
          {slot.choices.map((c) => {
            const current = sameModel(c.id, slot.model);
            const loading = pull?.model === c.id && !pull.error;
            return (
              <label key={c.id} className={`model-choice${current ? " is-current" : ""}`} data-testid={`model-choice-${c.id}`}>
                <input
                  type="radio"
                  name={name}
                  checked={current}
                  disabled={busy || downloading}
                  onChange={() => void props.onChoose(kind, c.id)}
                />
                <span className="model-choice-text">
                  <span className="model-choice-title">
                    {c.label} <code>{c.id}</code>
                  </span>
                  <span className="muted small">{c.detail}</span>
                </span>
                <span className="model-choice-size muted small">{loading ? "Downloading…" : c.installed ? "Downloaded" : `${c.size_gb} GB download`}</span>
              </label>
            );
          })}
          <form
            className={`model-choice model-custom${!isChoice ? " is-current" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.trim()) void props.onChoose(kind, custom.trim());
            }}
          >
            <span className="model-choice-text">
              <span className="model-choice-title">Another Ollama model</span>
              <input
                placeholder={kind === "enrich" ? "e.g. llama3.2:3b" : "e.g. nomic-embed-text"}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                aria-label={`Another Ollama model for ${props.title.toLowerCase()}`}
                data-testid={`model-custom-${kind}`}
              />
            </span>
            <button className="btn btn-sm" type="submit" disabled={busy || downloading || !custom.trim() || sameModel(custom.trim(), slot.model)}>
              Use
            </button>
          </form>
        </div>
      )}
      {pull && (
        <div className="model-note" data-testid={`model-pull-${kind}`}>
          {pull.error ? (
            <>
              <span className="warn">
                <IconAlert size={13} /> {pull.error}
              </span>{" "}
              <button className="btn btn-ghost btn-sm" onClick={() => void props.onDismiss()}>
                Dismiss
              </button>
            </>
          ) : (
            <>
              <span>
                Downloading {pull.model}
                {pull.total ? ` · ${Math.floor((pull.completed / pull.total) * 100)}% of ${(pull.total / 1024 ** 3).toFixed(1)} GB` : ` · ${pull.status}`}. Faber switches to it when
                it’s done.
              </span>
              <progress max={pull.total || 1} value={pull.total ? pull.completed : 0} />
            </>
          )}
        </div>
      )}
      {props.children}
    </div>
  );
}

// ---------- Organization ----------

function OrganizationSection() {
  const projects = useAsync(() => api.projects(), []);
  const review = useAsync(() => api.review(), []);
  const corrections = useAsync(() => api.corrections(), []);
  const [err, setErr] = useState<Error | null>(null);
  const undo = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      emitChange();
      corrections.reload();
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    }
  };
  const describe = (r: OrganizeRule) =>
    [
      r.manual && "made by hand",
      r.name && !r.manual && `renamed to “${r.name}”`,
      r.merged_into && `merged into ${r.merged_into.name}`,
      r.parent === "top" && "kept at the top level",
      r.parent && r.parent !== "top" && `moved under ${r.parent.name}`,
      r.hidden && "not a project",
    ]
      .filter(Boolean)
      .join(", ");
  const rules = corrections.data?.rules ?? [];
  const docs = corrections.data?.docs ?? [];
  return (
    <>
      {err && <ErrorBanner error={err} />}
      <section className="card settings-section" data-testid="organization">
        <header className="settings-head">
          <h3>Project detection</h3>
          <p className="muted">
            Projects come from what enrichment finds in each document — codenames, initiatives, products — grouped regardless of capitalization or a “Project” prefix. A
            document can belong to several, and a project whose name extends another’s (“Atlas Fleet”) sits inside it. Your corrections always win over detection and
            survive re-enrichment.
          </p>
        </header>
        <div className="row-gap">
          <a className="btn" href="#/inbox" data-testid="org-review">
            Review suggestions{review.data ? ` (${review.data.items.length})` : ""}
          </a>
          <a className="btn btn-ghost" href="#/projects">
            All {projects.data ? plural(projects.data.length, "project") : "projects"}
          </a>
        </div>
      </section>
      <section className="card settings-section" data-testid="corrections">
        <header className="settings-head">
          <h3>Your corrections</h3>
          <p className="muted">Renames, merges, moves and hand-made projects. Undo one to go back to what Faber detected.</p>
        </header>
        {rules.length === 0 && docs.length === 0 && <p className="muted small">None yet. Use a project’s page or the Inbox to rename, merge or regroup.</p>}
        {rules.length > 0 && (
          <ul className="rules">
            {rules.map((r) => (
              <li key={r.id} className="rule" data-testid="correction">
                <IconFolder size={15} />
                <div className="rule-text">
                  {r.hidden || r.merged_into ? (
                    <span className="rule-label">{r.label}</span>
                  ) : (
                    <a className="rule-label" href={`#/projects/${encodeURIComponent(r.id)}`}>
                      {r.label}
                    </a>
                  )}
                  <span className="muted small">{describe(r) || "confirmed"}</span>
                </div>
                {r.manual && r.hidden && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void undo(() => api.updateProject(r.id, { hidden: false }))} data-testid="unhide-project">
                    Show again
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => void undo(() => api.resetProject(r.id))} data-testid="undo-correction">
                  {r.manual ? "Delete" : "Undo"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {docs.length > 0 && (
          <>
            <h4 className="rules-subhead">Documents</h4>
            <ul className="rules">
              {docs.map((d) => (
                <li key={`${d.doc_id}-${d.project_id}`} className="rule" data-testid="doc-correction">
                  <div className="rule-text">
                    <span className="rule-label">{d.doc_title || "Untitled"}</span>
                    <span className="muted small">
                      {d.state === "add" ? "added to" : "taken out of"} {d.project_name}
                    </span>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => void undo(() => api.setDocProject(d.doc_id, d.project_id, null))}>
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

// ---------- Privacy & Data ----------

function PrivacySection() {
  const status = useAsync(() => api.status(), []);
  return (
    <>
      <section className="card settings-section" data-testid="storage">
        <header className="settings-head">
          <h3>Storage</h3>
          <p className="muted">Everything Faber knows lives in one SQLite file on this machine. Rely on your disk encryption (e.g. FileVault).</p>
        </header>
        {status.data && (
          <dl className="kv">
            <dt>Database</dt>
            <dd>
              <code className="wrap-anywhere">{status.data.db_path}</code>
            </dd>
            <dt>Config</dt>
            <dd>
              <code className="wrap-anywhere">{status.data.config_path}</code>
            </dd>
            <dt>Documents</dt>
            <dd>{status.data.docs.toLocaleString()}</dd>
            <dt>Version</dt>
            <dd>{status.data.version}</dd>
          </dl>
        )}
      </section>
      <section className="card settings-section" data-testid="privacy">
        <header className="settings-head">
          <h3>What leaves this machine</h3>
        </header>
        <ul className="fact-list">
          <li>None of your data, by default: the daemon listens only on this computer and rejects requests from websites.</li>
          <li>
            Site icons: for web pages you've saved, the daemon asks that site (and only that site) for its icon, at most once a week; Docs, Slides and Sheets icons come from
            Google. Turn this off with{" "}
            <code>privacy.favicons = false</code>.
          </li>
          <li>Remote AI providers run only when you set <code>privacy.allow_remote = true</code> in the config file.</li>
          <li>Browser extensions need your approval before they can read or write anything.</li>
          <li>Shared collections contain links, titles, your notes and your tags — never document text or AI summaries.</li>
        </ul>
      </section>
      <section className="card settings-section">
        <header className="settings-head">
          <h3>Export and deletion</h3>
        </header>
        <ul className="fact-list">
          <li>
            Export any collection from <a href="#/collections">Collections</a> as a shareable file.
          </li>
          <li>Forget a single document from its details panel: it removes the text, summary, embeddings and visits.</li>
          <li>
            To delete everything, stop the daemon and remove the data folder (<code className="wrap-anywhere">{status.data?.db_path.replace(/\/[^/]+$/, "") ?? "~/.faber"}</code>).
          </li>
        </ul>
      </section>
    </>
  );
}

/** One-click presets for common work tools (added as ordinary custom sites). */
function SuggestedSources({ existing, onAdd }: { existing: WatchRule[]; onAdd: (r: WatchRule) => void }) {
  const have = new Set(existing.map((r) => normalisePattern(r.pattern)));
  const left = SUGGESTED_SOURCES.filter((s) => !have.has(normalisePattern(s.pattern)));
  if (left.length === 0) return null;
  return (
    <div className="suggested-sources" data-testid="suggested-sources">
      <span className="muted small">Common sources:</span>
      {left.map((s) => (
        <button
          key={s.pattern}
          className="chip"
          title={s.pattern}
          onClick={() => onAdd({ id: crypto.randomUUID(), label: s.label, pattern: s.pattern, extractor: "generic", enabled: true, builtin: false })}
          data-testid="suggested-source"
        >
          + {s.label}
        </button>
      ))}
    </div>
  );
}

function RuleRow({ rule, onToggle, onDelete }: { rule: WatchRule; onToggle: (enabled: boolean) => void; onDelete?: () => void }) {
  return (
    <li className="rule" data-testid={`rule-${rule.id}`}>
      <label className="switch">
        <input type="checkbox" checked={rule.enabled} onChange={(e) => onToggle(e.target.checked)} data-testid={`toggle-${rule.id}`} aria-label={`Watch ${rule.label}`} />
        <span className="switch-track" aria-hidden="true" />
      </label>
      <div className="rule-text">
        <div className="rule-label">{rule.label}</div>
        <code className="rule-pattern">{rule.pattern}</code>
      </div>
      {onDelete && (
        <button className="icon-btn" onClick={onDelete} aria-label={`Remove ${rule.label}`} data-testid={`remove-${rule.id}`}>
          <IconTrash size={14} />
        </button>
      )}
    </li>
  );
}

function AddRule({ existing, onAdd }: { existing: WatchRule[]; onAdd: (r: WatchRule) => void }) {
  const [label, setLabel] = useState("");
  const [pattern, setPattern] = useState("");
  const [touched, setTouched] = useState(false);
  const parsed = pattern.trim() ? parsePattern(pattern) : null;
  // Compare normalised patterns, so "https://WIKI.example.com/team/" matches "wiki.example.com/team".
  const norm = normalisePattern(pattern);
  const duplicate = !!norm && existing.some((r) => normalisePattern(r.pattern) === norm);
  const error = !pattern.trim() ? null : !parsed ? "Use a host like wiki.example.com, *.atlassian.net or github.com/my-org" : duplicate ? "That pattern is already in the list" : null;
  const valid = !!parsed && !duplicate;

  const submit = () => {
    setTouched(true);
    if (!valid) return;
    onAdd({
      id: crypto.randomUUID(),
      label: label.trim() || pattern.trim(),
      pattern: pattern.trim(),
      extractor: "generic",
      enabled: true,
      builtin: false,
    });
    setLabel("");
    setPattern("");
    setTouched(false);
  };

  return (
    <form
      className="add-rule"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Team wiki)" aria-label="Rule label" data-testid="rule-label" />
      <input
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
        onBlur={() => setTouched(true)}
        placeholder="wiki.example.com/team"
        aria-label="Site pattern"
        aria-invalid={touched && !!error}
        data-testid="rule-pattern"
      />
      <button className="btn" type="submit" disabled={!valid} data-testid="add-rule">
        <IconPlus /> Add site
      </button>
      {touched && error && (
        <span className="field-error" data-testid="rule-error">
          {error}
        </span>
      )}
    </form>
  );
}

const APPROVE_MEANS = "Approving lets that extension record your visits and read everything Faber has saved — docs, notes, tags and search.";

function ExtensionsSection() {
  const list = useAsync(() => api.extensions(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
      emitChange();
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(null);
    }
  };

  const all = list.data ?? [];
  const pending = all.filter((x) => x.state === "pending");
  const approved = all.filter((x) => x.state === "approved");
  const config = all.filter((x) => x.state === "config");
  const dismissed = all.filter((x) => x.state === "dismissed");

  return (
    <section className="card settings-section" data-testid="extensions">
      <header className="settings-head">
        <h3>Browser extensions</h3>
        <p className="muted">{APPROVE_MEANS}</p>
      </header>
      {err && <ErrorBanner error={err} />}
      {list.error && !list.data && <ErrorBanner error={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Spinner />}

      {pending.map((x) => (
        <div key={x.id} className="pairing-request" data-testid="pending-extension" data-extension-id={x.id}>
          <IconAlert size={16} />
          <div className="pairing-text">
            <strong>A browser extension is asking for access</strong>
            <code className="ext-id">{x.id}</code>
            <span className="muted small">{x.since ? <>First seen {relativeTime(x.since)}</> : "Just now"}</span>
          </div>
          <div className="pairing-actions">
            <button className="btn btn-ghost" disabled={busy === x.id} onClick={() => void act(x.id, () => api.dismissExtension(x.id))} data-testid="dismiss-extension">
              Dismiss
            </button>
            <button className="btn btn-primary" disabled={busy === x.id} onClick={() => void act(x.id, () => api.approveExtension(x.id))} data-testid="approve-extension">
              {busy === x.id ? <Spinner size={12} /> : null} Approve
            </button>
          </div>
        </div>
      ))}

      {list.data && (
        <ul className="rules ext-list">
          {approved.map((x) => (
            <ExtensionRow key={x.id} x={x}>
              <button
                className="btn btn-ghost btn-sm btn-danger"
                disabled={busy === x.id}
                data-testid="remove-extension"
                onClick={() => {
                  if (confirm(`Remove access for extension ${x.id}? It will need to be approved again.`)) void act(x.id, () => api.removeExtension(x.id));
                }}
              >
                Remove
              </button>
            </ExtensionRow>
          ))}
          {config.map((x) => (
            <ExtensionRow key={x.id} x={x}>
              <span className="pill pill-muted" title="Allowed in config.toml (daemon.allowed_extension_ids); edit the file to change">
                from config
              </span>
            </ExtensionRow>
          ))}
        </ul>
      )}
      {dismissed.length > 0 && (
        <details className="dismissed-exts" data-testid="dismissed-extensions">
          <summary className="muted small">Turned down ({dismissed.length}) — refused without asking again</summary>
          <ul className="rules ext-list">
            {dismissed.map((x) => (
              <ExtensionRow key={x.id} x={x}>
                <button className="btn btn-ghost btn-sm" disabled={busy === x.id} onClick={() => void act(x.id, () => api.approveExtension(x.id))} data-testid="allow-dismissed">
                  Approve
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy === x.id} onClick={() => void act(x.id, () => api.removeExtension(x.id))} data-testid="forget-dismissed">
                  Forget
                </button>
              </ExtensionRow>
            ))}
          </ul>
        </details>
      )}
      {list.data && all.length === 0 && (
        <p className="muted small">No extensions yet. Install the Faber extension; it will ask for access here the first time it connects.</p>
      )}
    </section>
  );
}

function ExtensionRow({ x, children }: { x: ExtensionAccess; children: React.ReactNode }) {
  return (
    <li className="rule" data-testid={`extension-${x.state}`} data-extension-id={x.id}>
      <span className={`status-dot${x.state === "approved" || x.state === "config" ? "" : " off"}`} aria-hidden="true" />
      <div className="rule-text">
        <div className="rule-label">Chrome extension</div>
        <code className="ext-id muted">{x.id}</code>
        <div className="muted small" title={x.last_seen_at ? fullDate(x.last_seen_at) : undefined}>
          {x.state === "dismissed" ? (
            x.since ? `Turned down ${relativeTime(x.since)}` : "Turned down"
          ) : (
            <>
              {x.last_seen_at ? `Last seen ${relativeTime(x.last_seen_at)}` : "Not seen yet"}
              {x.since ? ` · approved ${relativeTime(x.since)}` : ""}
            </>
          )}
        </div>
      </div>
      {children}
    </li>
  );
}

/**
 * Drag-to-bookmarks-bar link that opens #/add prefilled with the current page.
 * React refuses javascript: hrefs, so the href is set on the DOM node directly.
 */
export function bookmarkletCode(origin: string): string {
  return `javascript:location.href='${origin}/#/add?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)`;
}

function Bookmarklet() {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    ref.current?.setAttribute("href", bookmarkletCode(window.location.origin));
  }, []);
  return (
    <section className="card settings-section" data-testid="bookmarklet-section">
      <header className="settings-head">
        <h3>Save from any page</h3>
        <p className="muted">Drag to your bookmarks bar to save any page without the extension.</p>
      </header>
      <div className="bookmarklet-row">
        <a ref={ref} className="bookmarklet" draggable onClick={(e) => e.preventDefault()} title="Drag me to your bookmarks bar" data-testid="bookmarklet">
          <FaberIcon size={16} />
          Save to Faber
        </a>
        <span className="muted small">Clicking it on any page opens the add form with the link and title filled in.</span>
      </div>
    </section>
  );
}
