import { useCallback, useEffect, useState } from "react";
import { daemonClient } from "../lib/client";
import { appearance } from "../lib/appearance";
import {
  PbClient,
  normaliseWatchlist,
  originPatternsFor,
  type StatusResponse,
  type WatchRule,
} from "@faber/shared";
import { relativeTime } from "../lib/format";
import { sendToBackground } from "../lib/messages";
import { validateNewPattern } from "../lib/rules";
import { isPairingRequired } from "../lib/queue";
import { clampDwell, getItem, normaliseDaemonUrl, setItem, type BackfillState, type ExtConfig, type SyncState } from "../lib/storage";
import { BrandMark, Icon, Switch } from "../ui/components";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

type ConnState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; status: StatusResponse }
  | { kind: "pairing" }
  | { kind: "error"; error: string };
type Toast = { kind: "ok" | "error"; text: string } | null;

const BUILTIN_HINTS: Record<string, string> = {
  gdocs: "Records docs you open and reads their text with your Google session.",
  gslides: "Same for presentations (speaker notes and slide text).",
  gsheets: "Same for spreadsheets (exported as CSV).",
  gcal: "When you open a doc from a calendar event, links the doc to that meeting.",
};

async function requestOrigins(pattern: string): Promise<boolean> {
  const origins = originPatternsFor(pattern);
  if (origins.length === 0) return false;
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

export function App() {
  const [cfg, setCfg] = useState<ExtConfig | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [dwellInput, setDwellInput] = useState("4");
  const [conn, setConn] = useState<ConnState>({ kind: "idle" });
  const [rules, setRules] = useState<WatchRule[]>([]);
  const [rulesSource, setRulesSource] = useState<"daemon" | "cache">("cache");
  const [toast, setToast] = useState<Toast>(null);
  const [queueSize, setQueueSize] = useState(0);
  const [lastSync, setLastSync] = useState<SyncState | null>(null);
  const [lastBackfill, setLastBackfill] = useState<BackfillState | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newPattern, setNewPattern] = useState("");
  const [patternError, setPatternError] = useState<string | null>(null);
  /** Custom rule ids that are enabled but whose site permission is missing (e.g. revoked in chrome://extensions). */
  const [missingPerm, setMissingPerm] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      rules
        .filter((r) => !r.builtin && r.enabled)
        .map(async (r) => ((await chrome.permissions.contains({ origins: originPatternsFor(r.pattern) })) ? null : r.id)),
    ).then((ids) => !cancelled && setMissingPerm(new Set(ids.filter((x): x is string => x !== null))));
    return () => {
      cancelled = true;
    };
  }, [rules]);

  /** Optional "tabs" permission: lets the toolbar icon show saved status on every site. */
  const [everySite, setEverySite] = useState(false);
  useEffect(() => {
    void chrome.permissions.contains({ permissions: ["tabs"] }).then(setEverySite);
  }, []);
  const toggleEverySite = (on: boolean) => {
    // request/remove must run straight from the click to count as a user gesture.
    const op = on ? chrome.permissions.request({ permissions: ["tabs"] }) : chrome.permissions.remove({ permissions: ["tabs"] });
    op.then(
      async () => setEverySite(await chrome.permissions.contains({ permissions: ["tabs"] })),
      (e: unknown) => flash({ kind: "error", text: String(e) }),
    );
  };

  const grant = (rule: WatchRule) => {
    // Called directly from the click so Chrome treats it as a user gesture.
    chrome.permissions.request({ origins: originPatternsFor(rule.pattern) }).then((ok) => {
      if (ok) setMissingPerm((m) => new Set([...m].filter((id) => id !== rule.id)));
      else flash({ kind: "error", text: `Permission to read ${rule.pattern} was not granted` });
    });
  };

  const flash = (t: Toast) => {
    setToast(t);
    if (t) setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 3500);
  };

  const loadStatus = useCallback(async () => {
    setQueueSize((await getItem("queue")).length);
    setLastSync(await getItem("lastSync"));
    setLastBackfill(await getItem("lastBackfill"));
  }, []);

  const loadRules = useCallback(async (c: ExtConfig) => {
    try {
      const s = await daemonClient(c.daemonUrl).settings();
      appearance.set(s.appearance);
      const r = normaliseWatchlist(s.watchlist);
      setRules(r);
      setRulesSource("daemon");
      await setItem("watchlist", r);
    } catch {
      setRules(normaliseWatchlist(await getItem("watchlist")));
      setRulesSource("cache");
    }
  }, []);

  const test = useCallback(async (daemonUrl: string) => {
    setConn({ kind: "testing" });
    try {
      const c = daemonClient(daemonUrl);
      const status = await c.status();
      await c.settings(); // status answers unpaired extensions; this surfaces pairing_required
      setConn({ kind: "ok", status });
    } catch (e) {
      setConn(isPairingRequired(e) ? { kind: "pairing" } : { kind: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const c = await getItem("config");
      setCfg(c);
      setUrlInput(c.daemonUrl);
      setDwellInput(String(c.dwellSeconds));
      await Promise.all([loadRules(c), test(c.daemonUrl), loadStatus()]);
    })();
    const onChange = () => void loadStatus();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [loadRules, test, loadStatus]);

  const saveConfig = async (next: ExtConfig) => {
    setCfg(next);
    await setItem("config", next);
  };

  const saveUrl = async () => {
    const u = normaliseDaemonUrl(urlInput);
    if (!u || !cfg) {
      flash({ kind: "error", text: "Enter a local address, e.g. http://127.0.0.1:7777 (only this machine is allowed)" });
      return;
    }
    setUrlInput(u);
    const next = { ...cfg, daemonUrl: u };
    await saveConfig(next);
    await Promise.all([test(u), loadRules(next)]);
  };

  const saveDwell = async () => {
    if (!cfg) return;
    const d = clampDwell(Number(dwellInput));
    setDwellInput(String(d));
    if (d !== cfg.dwellSeconds) {
      await saveConfig({ ...cfg, dwellSeconds: d });
      flash({ kind: "ok", text: "Saved" });
    }
  };

  /** Persist the watchlist to the daemon; only commit locally if the daemon accepted it. Returns an error message or null. */
  const pushRules = async (next: WatchRule[], opts: { quiet?: boolean } = {}): Promise<string | null> => {
    if (!cfg) return "Not configured";
    try {
      const saved = await daemonClient(cfg.daemonUrl).saveSettings({ watchlist: next });
      const r = normaliseWatchlist(saved.watchlist);
      setRules(r);
      setRulesSource("daemon");
      await setItem("watchlist", r);
      void sendToBackground({ type: "refresh-watchlist" }).catch(() => {});
      flash({ kind: "ok", text: "Watchlist saved" });
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!opts.quiet) flash({ kind: "error", text: `Couldn’t save to the daemon: ${msg}` });
      return msg;
    }
  };

  const toggle = async (rule: WatchRule, enabled: boolean) => {
    if (enabled && !rule.builtin && !(await requestOrigins(rule.pattern))) {
      flash({ kind: "error", text: `Permission to read ${rule.pattern} was not granted` });
      return;
    }
    await pushRules(rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
  };

  const remove = async (rule: WatchRule) => {
    if ((await pushRules(rules.filter((r) => r.id !== rule.id))) === null) {
      const origins = originPatternsFor(rule.pattern);
      const stillUsed = rules.some((r) => r.id !== rule.id && !r.builtin && originPatternsFor(r.pattern).some((o) => origins.includes(o)));
      if (!stillUsed) void chrome.permissions.remove({ origins }).catch(() => {});
    }
  };

  const add = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const check = validateNewPattern(newPattern, rules);
    if (!check.ok) {
      setPatternError(check.error);
      return;
    }
    if (!(await requestOrigins(check.pattern))) {
      setPatternError("Permission to read that site was not granted");
      return;
    }
    const rule: WatchRule = {
      id: `custom-${crypto.randomUUID().slice(0, 8)}`,
      label: newLabel.trim() || check.host,
      pattern: check.pattern,
      extractor: "generic",
      enabled: true,
      builtin: false,
    };
    // Show the daemon's own reason (e.g. "… duplicates the rule …") next to the field.
    const err = await pushRules([...rules, rule], { quiet: true });
    if (err) {
      setPatternError(err);
      return;
    }
    setNewLabel("");
    setNewPattern("");
    setPatternError(null);
  };

  const builtins = rules.filter((r) => r.builtin);
  const custom = rules.filter((r) => !r.builtin);

  return (
    <div className="options">
      <header className="opt-header">
        <BrandMark size={34} />
        <div>
          <h1>Faber</h1>
          <p className="muted">Remembers and organizes the docs you open at work. Capture settings for this browser.</p>
        </div>
      </header>

      <section className="card">
        <h2>Connection</h2>
        <p className="muted desc">The extension sends visits and page text only to your local Faber daemon.</p>
        <label className="field">
          <span>Daemon address</span>
          <div className="row">
            <input
              className="input mono"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveUrl()}
              aria-label="Daemon address"
              spellCheck={false}
            />
            <button className="btn" onClick={saveUrl} disabled={conn.kind === "testing"}>
              {conn.kind === "testing" ? <span className="spinner" /> : null}
              {urlInput !== cfg?.daemonUrl ? "Save & test" : "Test connection"}
            </button>
          </div>
        </label>
        <div className="conn-line" aria-live="polite">
          {conn.kind === "ok" && (
            <span className="conn ok">
              <span className="dot dot-ok" /> Connected · v{conn.status.version} · {conn.status.docs} docs, {conn.status.enriched} enriched
            </span>
          )}
          {conn.kind === "ok" && conn.status.issues?.length > 0 && (
            <ul className="issues" aria-label="Problems">
              {conn.status.issues.map((msg) => (
                <li key={msg} className="notice notice-warn">
                  <Icon name="alert" size={14} />
                  <span>{msg}</span>
                </li>
              ))}
            </ul>
          )}
          {conn.kind === "pairing" && (
            <span className="conn pair" role="alert">
              <span className="dot" /> Approve Faber in the app (Settings → Capture & Sources).
              <span className="conn-actions">
                <button className="btn btn-sm btn-primary" onClick={() => chrome.tabs.create({ url: `${cfg?.daemonUrl}/#/settings/capture` })}>
                  Open settings
                </button>
                <button className="btn btn-sm" onClick={() => cfg && Promise.all([test(cfg.daemonUrl), loadRules(cfg)])}>
                  Retry
                </button>
              </span>
            </span>
          )}
          {conn.kind === "error" && (
            <span className="conn bad">
              <span className="dot dot-bad" /> Not reachable. Start it with <code>bun faber serve</code>
            </span>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Watchlist</h2>
            <p className="muted desc">
              Nothing is recorded until you turn something on. Pages you stay on for {cfg?.dwellSeconds ?? 4}s or more are saved.
            </p>
          </div>
          {rulesSource === "cache" && <span className="badge badge-warn">Offline · showing cached</span>}
        </div>

        <ul className="rules">
          {builtins.map((r) => (
            <li key={r.id} className="rule">
              <Switch checked={r.enabled} label={r.label} disabled={rulesSource === "cache"} onChange={(v) => toggle(r, v)} />
              <div className="rule-text">
                <div className="rule-label">{r.label}</div>
                <div className="rule-sub">{BUILTIN_HINTS[r.id] ?? r.pattern}</div>
              </div>
            </li>
          ))}
        </ul>

        <h3>Other sites</h3>
        {custom.length === 0 && <p className="faint small-text">Add wikis, trackers or anything else you want remembered. Their visible text is saved.</p>}
        {custom.length > 0 && (
          <ul className="rules">
            {custom.map((r) => (
              <li key={r.id} className="rule">
                <Switch checked={r.enabled} label={r.label} disabled={rulesSource === "cache"} onChange={(v) => toggle(r, v)} />
                <div className="rule-text">
                  <div className="rule-label">
                    {r.label}{" "}
                    {missingPerm.has(r.id) && <span className="badge badge-warn">Needs permission</span>}
                  </div>
                  <code className="rule-pattern">{r.pattern}</code>
                </div>
                {missingPerm.has(r.id) && (
                  <button className="btn btn-sm" onClick={() => grant(r)}>
                    Grant
                  </button>
                )}
                <button className="icon-btn" aria-label={`Remove ${r.label}`} title="Remove" onClick={() => remove(r)} disabled={rulesSource === "cache"}>
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form className="add-rule" onSubmit={add}>
          <input className="input" placeholder="Label (optional)" aria-label="Label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <input
            className="input mono"
            placeholder="wiki.example.com/team"
            aria-label="Site pattern"
            aria-invalid={patternError ? true : undefined}
            value={newPattern}
            onChange={(e) => {
              setNewPattern(e.target.value);
              setPatternError(null);
            }}
            spellCheck={false}
          />
          <button className="btn btn-primary" type="submit" disabled={!newPattern.trim() || rulesSource === "cache"}>
            <Icon name="plus" size={13} /> Add
          </button>
        </form>
        {patternError && <div className="field-error">{patternError}</div>}
        <p className="faint small-text">
          Use <code>*.example.com</code> for all subdomains. Chrome will ask for permission to read the site.
        </p>
      </section>

      <section className="card">
        <h2>Toolbar icon</h2>
        <p className="muted desc">The Faber icon shows whether the page you’re on is saved: filled when saved, with an amber dot when pinned, an outline when not.</p>
        <ul className="rules">
          <li className="rule">
            <Switch checked={everySite} label="Show saved status on every site" onChange={toggleEverySite} />
            <div className="rule-text">
              <div className="rule-label">Show saved status on every site</div>
              <div className="rule-sub">
                Lets the extension read the address of the tab you’re on so it can check it. The address is only sent to your local daemon and is never
                stored. When off, status shows on Google Docs and the sites in your watchlist.
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>Capture</h2>
        <label className="field inline">
          <span>
            Save a page after
            <span className="faint"> (seconds on the page)</span>
          </span>
          <input
            className="input num"
            type="number"
            min={0}
            max={120}
            value={dwellInput}
            onChange={(e) => setDwellInput(e.target.value)}
            onBlur={saveDwell}
            onKeyDown={(e) => e.key === "Enter" && saveDwell()}
            aria-label="Dwell seconds"
          />
        </label>
        <dl className="stats">
          <div>
            <dt>Offline queue</dt>
            <dd data-testid="queue-size">
              {queueSize === 0 ? "Empty" : `${queueSize} waiting`}
              {queueSize > 0 && (
                <button className="btn btn-sm" onClick={() => sendToBackground({ type: "flush-queue" }).then(loadStatus)}>
                  Send now
                </button>
              )}
            </dd>
          </div>
          <div>
            <dt>Watchlist sync</dt>
            <dd>{lastSync ? `${lastSync.ok ? "OK" : "Failed"} · ${relativeTime(lastSync.at)}` : "Never"}</dd>
          </div>
          <div>
            <dt>Text backfill</dt>
            <dd>{lastBackfill ? `${lastBackfill.fetched} fetched, ${lastBackfill.failed} failed · ${relativeTime(lastBackfill.at)}` : "Nothing yet"}</dd>
          </div>
        </dl>
      </section>

      <footer className="opt-footer faint">
        Shortcut:{" "}
        {(IS_MAC ? ["⌘", "⇧", "K"] : ["Ctrl", "Shift", "K"]).map((k) => (
          <kbd key={k}>{k}</kbd>
        ))}{" "}
        opens search · type <code>faber</code> + space in the address bar ·{" "}
        <a href="#" onClick={(e) => (e.preventDefault(), chrome.tabs.create({ url: "chrome://extensions/shortcuts" }))}>
          change shortcut
        </a>
      </footer>

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status">
          <Icon name={toast.kind === "ok" ? "check" : "x"} size={13} /> {toast.text}
        </div>
      )}
    </div>
  );
}
