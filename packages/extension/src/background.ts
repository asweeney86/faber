import { ApiRequestError, PbClient, cleanGoogleTitle, normaliseWatchlist, parseGoogleUrl, type CaptureRequest, type WatchRule } from "@faber/shared";
import { daemonClient } from "./lib/client";
import { issueLauncherTicket, launcherUrl, mountLauncherFrame } from "./lib/launcher";
import { LAUNCHER_CLOSE } from "./lib/messages";
import { startDevReload } from "./devreload";
import { captureKey, extractMatches, isCalendarUrl, isDaemonUrl, meetingEligible, referrerFor, ruleForNavigation } from "./lib/capture";
import {
  claimRecent,
  forgetRecent,
  leave,
  navigate,
  nextDueIn,
  noteCalendarNav,
  setForeground,
  takeDue,
  type DwellState,
  type PendingMeta,
} from "./lib/dwell";
import {
  EXPORT_TIMEOUT_MS,
  MAX_EXPORT_CHARS,
  RATE_LIMIT_COOLDOWN_MS,
  classifyExportHead,
  cleanExportText,
  enabledGoogleSources,
  exportNetworkError,
  readTextCapped,
  type ExportResult,
} from "./lib/export";
import { cleanPageText, extractCalendarEventInPage, extractPageInPage, type CalendarEventExtract, type PageExtract } from "./lib/extract";
import { escapeOmnibox } from "./lib/format";
import type { BgMessage, SaveTabResult } from "./lib/messages";
import { Mutex } from "./lib/mutex";
import { shouldReload } from "./lib/selfupdate";
import { applyFlush, enqueueCapture, flushQueue, isPairingRequired, isRetryable, shrinkToFit, type QueuedCapture } from "./lib/queue";
import { getItem, getSession, setItem, setSession, type ExtConfig } from "./lib/storage";
import { LookupCache, iconPaths, isLookupUrl, statusFor, type LookupResult, type TabStatus } from "./lib/tabstate";

/**
 * Background service worker: watches tab navigations, records visits to
 * watched pages after a dwell period, fetches Google doc text with the user's
 * session, and backfills text for imported history.
 *
 * Chrome suspends this worker after ~30s idle, so nothing important lives in
 * memory: dwell timers and de-duplication are in chrome.storage.session, the
 * offline queue in chrome.storage.local, and an alarm re-checks due captures.
 */

// ---------- config cache (rebuilt whenever the worker wakes) ----------

let config: ExtConfig | null = null;
let rules: WatchRule[] | null = null;

async function getConfig(): Promise<ExtConfig> {
  return (config ??= await getItem("config"));
}

async function getRules(): Promise<WatchRule[]> {
  return (rules ??= normaliseWatchlist(await getItem("watchlist")));
}

async function client(): Promise<PbClient> {
  return daemonClient((await getConfig()).daemonUrl);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.config) {
    config = null;
    lookups.clear();
    void refreshWatchlist();
    void refreshActiveTab();
  }
  if (changes.watchlist) rules = null;
});

/** Pull the watchlist from the daemon (source of truth); keep the cached copy if it is unreachable. */
async function refreshWatchlist(): Promise<boolean> {
  try {
    const s = await (await client()).settings();
    rules = normaliseWatchlist(s.watchlist);
    await setItem("watchlist", rules);
    await setItem("lastSync", { at: Date.now(), ok: true });
    return true;
  } catch (err) {
    await setItem("lastSync", {
      at: Date.now(),
      ok: false,
      pairing: isPairingRequired(err),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ---------- persisted dwell state ----------

const dwellLock = new Mutex();
let dwellTimer: ReturnType<typeof setTimeout> | undefined;

/** Read-modify-write the dwell state under a lock, then re-arm the in-memory timer. */
async function updateDwell<T>(fn: (s: DwellState) => { state: DwellState; result: T } | DwellState): Promise<T | undefined> {
  const out = await dwellLock.run(async () => {
    const s = await getSession("dwell");
    const r = fn(s);
    const { state, result } = "state" in r && "result" in r ? r : { state: r as DwellState, result: undefined as T | undefined };
    if (state !== s) await setSession("dwell", state);
    return { state, result };
  });
  scheduleDwellCheck(out.state);
  return out.result;
}

function scheduleDwellCheck(s: DwellState) {
  clearTimeout(dwellTimer);
  const ms = nextDueIn(s, Date.now(), (config?.dwellSeconds ?? 4) * 1000);
  // The timer is a fast path while the worker is awake; the faber-dwell alarm covers suspension.
  if (ms !== null) dwellTimer = setTimeout(() => void checkDue(), ms + 50);
}

async function checkDue() {
  const dwellMs = (await getConfig()).dwellSeconds * 1000;
  const due = await updateDwell((s) => {
    const r = takeDue(s, Date.now(), dwellMs);
    return { state: r.state, result: r.due };
  });
  for (const d of due ?? []) void captureDue(d.tabId, d.entry.url, d.entry);
}

// ---------- foreground tracking: dwell only accrues in the active tab of the focused window ----------

async function currentForeground(): Promise<number | null> {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win.focused === false || win.id === undefined) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

async function syncForeground() {
  const fg = await currentForeground();
  await updateDwell((s) => (s.foreground === fg ? s : setForeground(s, fg, Date.now())));
}

chrome.tabs.onActivated.addListener(() => void syncForeground());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) void updateDwell((s) => setForeground(s, null, Date.now()));
  else void syncForeground();
});

// ---------- Google export fetching ----------

async function fetchExport(exportUrl: string): Promise<ExportResult> {
  try {
    const res = await fetch(exportUrl, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) });
    const bad = classifyExportHead({ status: res.status, contentType: res.headers.get("content-type"), finalUrl: res.url || exportUrl });
    if (bad) {
      await res.body?.cancel().catch(() => {});
      return bad;
    }
    const { text } = await readTextCapped(res.body, MAX_EXPORT_CHARS);
    return { ok: true, text: cleanExportText(text) };
  } catch (err) {
    return exportNetworkError(err);
  }
}

/**
 * Fetch a doc's text and hand it to the daemon. Transient failures are not
 * reported (the daemon would count them against the doc); they are retried by
 * the backfill. Never throws.
 */
async function fetchAndPostContent(api: PbClient, docId: string, exportUrl: string): Promise<ExportResult> {
  const r = await fetchExport(exportUrl);
  if (!r.ok && r.transient) return r;
  try {
    await api.postContent(docId, r.ok ? { content: r.text } : { error: r.error });
  } catch (err) {
    console.warn("[faber] posting content failed; backfill will retry", err);
  }
  return r;
}

// ---------- page extraction ----------

async function extractTab(tabId: number): Promise<PageExtract | null> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageInPage });
  return (res?.result as PageExtract | undefined) ?? null;
}

async function tabUrl(tabId: number | undefined): Promise<string | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    return undefined;
  }
}

/** The calendar event a doc was opened from, if the Calendar rule is on and the opener is showing an event right now. */
async function meetingFromOpener(openerTabId: number | undefined, openerUrl: string | undefined): Promise<PendingMeta["meeting"]> {
  if (openerTabId === undefined || !isCalendarUrl(openerUrl)) return undefined;
  if (!(await getRules()).some((x) => x.extractor === "gcal" && x.enabled)) return undefined;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: openerTabId }, func: extractCalendarEventInPage });
    const ev = (res?.result as CalendarEventExtract | null) ?? null;
    const s = await getSession("dwell");
    const ok = meetingEligible({
      openerUrl,
      openerNavAt: s.calendarNav[openerTabId] ?? null,
      now: Date.now(),
      eventDialogOpen: ev?.eventDialogOpen ?? false,
    });
    return ok && ev ? { title: ev.title, url: ev.url } : undefined;
  } catch {
    return undefined;
  }
}

// ---------- toolbar icon: is the current tab saved? ----------

const lookups = new LookupCache();
/** Last status applied per tab (memory only; recomputed on the next event after a worker restart). */
const tabStatus = new Map<number, { url: string | undefined; status: TabStatus }>();

async function lookupTab(url: string): Promise<LookupResult> {
  const cfg = await getConfig();
  return lookups.get(captureKey(url), async () => {
    try {
      const doc = await daemonClient(cfg.daemonUrl).lookup(url);
      return doc ? { kind: "doc", doc } : { kind: "missing" };
    } catch (err) {
      if (isPairingRequired(err)) return { kind: "unpaired" };
      if (err instanceof ApiRequestError && err.status === 400) return { kind: "not-web" };
      return { kind: "offline" };
    }
  });
}

/** Work out and apply the toolbar icon + title for one tab. Never throws; never blocks captures. */
async function refreshTabStatus(tabId: number): Promise<TabStatus | null> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tabStatus.delete(tabId);
    return null;
  }
  let result: LookupResult;
  const cfg = await getConfig();
  if (tab.incognito) result = { kind: "not-web" };
  else if (tab.url === undefined && tab.pendingUrl === undefined) result = { kind: "no-access" };
  else if (!isLookupUrl(tab.url) || isDaemonUrl(tab.url!, cfg.daemonUrl)) result = { kind: "not-web" };
  else result = await lookupTab(tab.url!);

  const status = statusFor(result);
  tabStatus.set(tabId, { url: tab.url, status });
  try {
    await chrome.action.setIcon({ tabId, path: iconPaths(status.state) });
    await chrome.action.setTitle({ tabId, title: status.title });
  } catch {
    /* tab closed meanwhile */
  }
  return status;
}

async function refreshActiveTab() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win.id === undefined) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (tab?.id !== undefined) await refreshTabStatus(tab.id);
  } catch {
    /* no window */
  }
}

/** After something changed a doc (capture, save, pin, tag), drop its cached status and refresh the tab. */
async function invalidateTab(tabId: number, url?: string) {
  if (url) lookups.invalidate(captureKey(url));
  else {
    const known = tabStatus.get(tabId)?.url;
    if (known) lookups.invalidate(captureKey(known));
  }
  await refreshTabStatus(tabId);
}

chrome.tabs.onActivated.addListener(({ tabId }) => void refreshTabStatus(tabId));
chrome.tabs.onRemoved.addListener((tabId) => tabStatus.delete(tabId));
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void refreshActiveTab();
});
chrome.permissions.onAdded.addListener(() => {
  lookups.clear();
  void refreshActiveTab();
});
chrome.permissions.onRemoved.addListener(() => {
  lookups.clear();
  void refreshActiveTab();
});

// ---------- capture ----------

type CaptureOutcome = { doc_id: string; content: "included" | "fetched" | "failed" | "none"; error?: string };

/**
 * Record the visit, then for Google docs fetch text if the daemon wants it.
 * Only the visit itself can throw: if it was recorded but the text step fails,
 * the backfill picks the text up later (re-sending would double-count the visit).
 */
async function sendCapture(req: CaptureRequest): Promise<CaptureOutcome> {
  const api = await client();
  const res = await api.capture(req);
  if (req.content !== undefined) return { doc_id: res.doc_id, content: "included" };
  const g = parseGoogleUrl(req.url);
  if (res.needs_content && g) {
    const r = await fetchAndPostContent(api, res.doc_id, g.exportUrl);
    return r.ok ? { doc_id: res.doc_id, content: "fetched" } : { doc_id: res.doc_id, content: "failed", error: r.error };
  }
  return { doc_id: res.doc_id, content: "none" };
}

const queueLock = new Mutex();

async function mutateQueue(fn: (q: QueuedCapture[]) => QueuedCapture[]): Promise<number> {
  return queueLock.run(async () => {
    let next = fn(await getItem("queue"));
    try {
      await setItem("queue", next);
    } catch (err) {
      // Quota exceeded despite the caps (other data in storage): halve the budget and retry once.
      console.warn("[faber] queue write failed, shrinking", err);
      next = shrinkToFit(next, 2_000_000);
      await setItem("queue", next).catch(() => setItem("queue", []));
    }
    return next.length;
  });
}

/** Capture now, or queue it for later if the daemon is down or not yet paired. */
async function captureOrQueue(req: CaptureRequest, tabId?: number) {
  try {
    await sendCapture(req);
    if (tabId !== undefined) void invalidateTab(tabId, req.url);
  } catch (err) {
    if (isRetryable(err)) await mutateQueue((q) => enqueueCapture(q, req));
    else console.warn("[faber] capture rejected", err);
  }
}

/** Build the capture for a tab, reading page text for generic rules. Returns null if the tab moved on. */
async function buildCapture(tab: chrome.tabs.Tab, url: string, meta: PendingMeta, generic: boolean): Promise<CaptureRequest | null> {
  const req: CaptureRequest = { url, ts: Date.now(), title: cleanGoogleTitle(tab.title) || undefined };
  if (meta.referrer) req.referrer = meta.referrer;
  if (meta.meeting) req.meeting = meta.meeting;
  if (generic) {
    const page = await extractTab(tab.id!);
    // The tab may have navigated between deciding to capture and the script running.
    if (!page || !extractMatches(url, page.href)) return null;
    req.content = cleanPageText(page.text);
    if (!req.title && page.title) req.title = page.title;
  }
  return req;
}

async function captureDue(tabId: number, url: string, meta: PendingMeta) {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // tab closed
  }
  if (tab.incognito || !tab.url || captureKey(tab.url) !== captureKey(url)) return;
  const cfg = await getConfig();
  const rule = ruleForNavigation(tab.url, await getRules(), cfg.daemonUrl);
  if (!rule) return;
  const key = captureKey(tab.url);
  const claimed = await updateDwell((s) => {
    const r = claimRecent(s, key, Date.now());
    return { state: r.state, result: r.ok };
  });
  if (!claimed) return;
  try {
    const req = await buildCapture(tab, tab.url, meta, rule.extractor === "generic");
    if (!req) {
      await updateDwell((s) => forgetRecent(s, key));
      return;
    }
    await captureOrQueue(req, tabId);
  } catch (err) {
    await updateDwell((s) => forgetRecent(s, key));
    console.warn("[faber] capture failed", err);
  }
}

async function onNavigation(tab: chrome.tabs.Tab, url: string | undefined) {
  const tabId = tab.id;
  if (tabId === undefined || tab.incognito) return;
  const now = Date.now();
  const cfg = await getConfig();
  const r = await getRules();
  if (!url || !ruleForNavigation(url, r, cfg.daemonUrl)) {
    // Not a watched page: stop any pending dwell. Calendar navigations are remembered for meeting linking.
    await updateDwell((s) => (isCalendarUrl(url) ? noteCalendarNav(leave(s, tabId), tabId, now) : leave(s, tabId)));
    return;
  }
  const key = captureKey(url);
  const existing = (await getSession("dwell")).tabs[tabId];
  if (existing?.key === key) return;

  // Context is gathered at first arrival: the opener may navigate away during the dwell.
  const openerUrl = await tabUrl(tab.openerTabId);
  const meta: PendingMeta = {};
  const ref = referrerFor(openerUrl, r, cfg.daemonUrl);
  if (ref) meta.referrer = ref;
  if (parseGoogleUrl(url)) {
    const meeting = await meetingFromOpener(tab.openerTabId, openerUrl);
    if (meeting) meta.meeting = meeting;
  }
  const fg = await currentForeground();
  await updateDwell((s) => navigate(s.foreground === fg ? s : setForeground(s, fg, now), tabId, url, key, now, meta));
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url !== undefined || change.status === "complete") {
    void onNavigation(tab, change.url ?? tab.url);
    // Chrome resets per-tab icons on navigation; re-apply once the page settles.
    if (tab.active || change.status === "complete") void refreshTabStatus(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => void updateDwell((s) => leave(s, tabId)));

/** Manual "Save this page" from the popup. */
async function saveTab(tabId: number, url: string): Promise<SaveTabResult> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "That tab is no longer open" };
  }
  if (tab.incognito) return { ok: false, error: "Incognito pages are never saved" };
  const cfg = await getConfig();
  const meta: PendingMeta = {};
  const ref = referrerFor(await tabUrl(tab.openerTabId), await getRules(), cfg.daemonUrl);
  if (ref) meta.referrer = ref;

  let req: CaptureRequest | null;
  try {
    req = await buildCapture(tab, url, meta, parseGoogleUrl(url) === null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const needsPermission = /permission|cannot access/i.test(msg);
    return { ok: false, error: needsPermission ? "Faber needs permission to read this page" : msg, needsPermission };
  }
  if (!req) return { ok: false, error: "The page changed before it could be read. Try again." };

  try {
    const r = await sendCapture(req);
    await updateDwell((s) => claimRecent(s, captureKey(url), Date.now()).state);
    void invalidateTab(tabId, url);
    return { ok: true, ...r };
  } catch (err) {
    if (isRetryable(err)) {
      await mutateQueue((q) => enqueueCapture(q, req));
      return {
        ok: false,
        queued: true,
        pairing: isPairingRequired(err),
        error: isPairingRequired(err) ? "Saved for later: approve Faber in the app first" : "Daemon unreachable: saved to the offline queue",
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- offline queue ----------

let flushing = false;
async function flush() {
  if (flushing) return;
  const snapshot = await getItem("queue");
  if (snapshot.length === 0) return;
  flushing = true;
  try {
    const r = await flushQueue(snapshot, async (c) => {
      await sendCapture(c);
    });
    await mutateQueue((q) => applyFlush(q, r));
  } finally {
    flushing = false;
  }
}

// ---------- backfill ----------

let backfilling = false;
async function backfill() {
  if (backfilling) return;
  if ((await getItem("backfillCooldownUntil")) > Date.now()) return;
  const sources = enabledGoogleSources(await getRules());
  if (sources.length === 0) return;
  backfilling = true;
  let fetched = 0;
  let failed = 0;
  try {
    const api = await client();
    const items = await api.pendingContent(sources, 5);
    for (const it of items) {
      // The daemon remembers which Google account each doc was opened with.
      if (!it.export_url) continue;
      const r = await fetchAndPostContent(api, it.doc_id, it.export_url);
      if (r.ok) fetched++;
      else {
        failed++;
        if (r.rateLimited) {
          await setItem("backfillCooldownUntil", Date.now() + RATE_LIMIT_COOLDOWN_MS);
          break;
        }
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    if (items.length) await setItem("lastBackfill", { at: Date.now(), fetched, failed });
  } catch (err) {
    console.warn("[faber] backfill failed", err);
  } finally {
    backfilling = false;
  }
}

// ---------- alarms & lifecycle ----------

function ensureAlarms() {
  chrome.alarms.create("faber-backfill", { periodInMinutes: 1 });
  chrome.alarms.create("faber-sync", { periodInMinutes: 5 });
  // Catches dwell timers lost when the worker was suspended (30s is Chrome's minimum period).
  chrome.alarms.create("faber-dwell", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  void refreshWatchlist().then((ok) => (ok ? flush() : undefined));
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  void refreshWatchlist().then(checkForUpdate);
});

/** Pick up a newer copy of ourselves that the daemon put on disk after an upgrade. */
async function checkForUpdate() {
  try {
    const status = await (await client()).status();
    const self = await chrome.management.getSelf();
    const check = {
      installType: self.installType,
      manifestVersion: chrome.runtime.getManifest().version,
      daemonVersion: status.version ?? null,
      reloadedFor: await getItem("reloadedFor"),
    };
    if (!shouldReload(check)) return;
    await setItem("reloadedFor", check.daemonVersion);
    chrome.runtime.reload();
  } catch {
    // Daemon unreachable: try again on the next sync.
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "faber-backfill") void flush().then(backfill).then(checkForUpdate);
  if (alarm.name === "faber-sync") void refreshWatchlist().then((ok) => (ok ? flush() : undefined)).then(checkForUpdate);
  if (alarm.name === "faber-dwell") void syncForeground().then(checkDue);
});

// Worker woke up: resume any dwell timers from persisted state.
void getConfig().then(async () => scheduleDwellCheck(await getSession("dwell")));

// ---------- messages from popup / options ----------

chrome.runtime.onMessage.addListener((msg: BgMessage, sender, sendResponse) => {
  // Only our own pages may drive the worker.
  if (sender.id !== chrome.runtime.id) return false;
  const run = async (): Promise<unknown> => {
    switch (msg.type) {
      case "save-tab":
        return saveTab(msg.tabId, msg.url);
      case "refresh-watchlist":
        return refreshWatchlist();
      case "flush-queue":
        await flush();
        return (await getItem("queue")).length;
      case "run-backfill":
        await backfill();
        return true;
      case "refresh-tab":
        return invalidateTab(msg.tabId, msg.url);
      case "open-launcher":
        return openLauncher(msg.query);
    }
  };
  run().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the channel open for the async response
});

// ---------- launcher: the shortcut opens it over the current page ----------

/**
 * Show the launcher over the active tab. The shortcut grants activeTab, so we can
 * inject on ordinary pages; Chrome's own pages (new tab, chrome://, the Web Store,
 * PDFs) refuse scripts, so there it opens in a small window instead.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
}

async function openLauncher(query?: string) {
  // The tab the user is looking at: the active tab of the last focused *browser* window
  // (not our own launcher window or a devtools/popup window).
  const browserWindow = await withTimeout(chrome.windows.getLastFocused({ windowTypes: ["normal"] }), 2000).catch(() => undefined);
  const [tab] = browserWindow?.id !== undefined ? await chrome.tabs.query({ active: true, windowId: browserWindow.id }) : [];
  const page = chrome.runtime.getURL("launcher.html");
  if (tab?.id !== undefined && !tab.incognito && /^https?:/.test(tab.url ?? "https:")) {
    try {
      const ticket = await issueLauncherTicket(chrome.storage.session, { mode: "overlay", tabId: tab.id });
      // A tab that never answers (frozen, mid-navigation) must not swallow the shortcut.
      const [res] = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          // Don't wait for the page to finish loading (a busy page may never go idle).
          injectImmediately: true,
          func: mountLauncherFrame,
          args: [launcherUrl(page, { mode: "overlay", ticket, query }), LAUNCHER_CLOSE],
        }),
        3000,
      );
      return res?.result === "closed" ? "closed" : "overlay";
    } catch {
      /* not injectable: fall through to the window */
    }
  }
  // One launcher window at a time: pressing the shortcut again brings it back.
  const { launcherWindowId } = (await chrome.storage.session.get("launcherWindowId")) as { launcherWindowId?: number };
  if (launcherWindowId !== undefined) {
    const existing = await chrome.windows.get(launcherWindowId).catch(() => undefined);
    if (existing) {
      await chrome.windows.update(launcherWindowId, { focused: true });
      return "window";
    }
  }
  const win = await chrome.windows.getLastFocused().catch(() => undefined);
  const width = 1000;
  const height = 640;
  const ticket = await issueLauncherTicket(chrome.storage.session, { mode: "window" });
  const created = await chrome.windows.create({
    url: launcherUrl(page, { mode: "window", ticket, query }),
    type: "popup",
    width,
    height,
    focused: true,
    left: win?.left !== undefined && win.width ? Math.round(win.left + (win.width - width) / 2) : undefined,
    top: win?.top !== undefined && win.height ? Math.round(win.top + Math.max(40, (win.height - height) / 3)) : undefined,
  });
  await chrome.storage.session.set({ launcherWindowId: created?.id });
  return "window";
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-launcher") void openLauncher();
});

// ---------- omnibox: type "faber <query>" in the address bar ----------

let omniTimer: ReturnType<typeof setTimeout> | undefined;
chrome.omnibox.setDefaultSuggestion({ description: "Search Faber" });
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  clearTimeout(omniTimer);
  omniTimer = setTimeout(async () => {
    try {
      const res = await (await client()).search({ q: text, limit: 6 });
      suggest(
        res.hits.map((h) => ({
          content: h.doc.canonical_url,
          description: `<match>${escapeOmnibox(h.doc.title || "(untitled)")}</match>${
            h.doc.enrichment ? ` <dim>· ${escapeOmnibox(h.doc.enrichment.summary.slice(0, 90))}</dim>` : ""
          }`,
        })),
      );
    } catch {
      suggest([]);
    }
  }, 150);
});
chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const target = /^https?:\/\//.test(text) ? text : `${(await getConfig()).daemonUrl}/#/search?q=${encodeURIComponent(text)}`;
  if (disposition === "currentTab") void chrome.tabs.update({ url: target });
  else void chrome.tabs.create({ url: target, active: disposition === "newForegroundTab" });
});

// Exposed for e2e tests and debugging from the service worker console.
// Hooks for the e2e suite; only present in test builds (FABER_TEST=1).
if (process.env.NODE_ENV === "development") {
  (globalThis as Record<string, unknown>).__faber = {
  refreshWatchlist,
  openLauncher,
  flush,
  backfill,
  saveTab,
  checkDue,
  refreshTabStatus,
  invalidateTab,
  /** Toolbar icons can't be read back from Chrome, so tests read the state we applied. */
  tabStatusFor: (url: string) => {
    for (const [tabId, v] of tabStatus) if (v.url && captureKey(v.url) === captureKey(url)) return { tabId, ...v.status };
    return null;
  },
};
}

// `bun run dev:extension` builds with a reload port; normal builds compile this away.
declare const __FABER_DEV_RELOAD_PORT__: number;
declare const __FABER_BUILD_ID__: string;
if (__FABER_DEV_RELOAD_PORT__ > 0) startDevReload(__FABER_DEV_RELOAD_PORT__, __FABER_BUILD_ID__);
