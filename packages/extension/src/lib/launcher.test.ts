import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { issueLauncherTicket, launcherUrl, mountLauncherFrame, redeemLauncherTicket, TICKET_TTL_MS } from "./launcher";
import { LAUNCHER_CLOSE } from "./messages";

const BASE = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/launcher.html";
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

describe("launcherUrl", () => {
  test("carries the mode, the ticket and the query, never a tab id", () => {
    const u = new URL(launcherUrl(BASE, { mode: "overlay", ticket: "tkt-1", query: "rate limit & co?" }));
    expect(u.origin + u.pathname).toBe(BASE);
    expect(u.searchParams.get("mode")).toBe("overlay");
    expect(u.searchParams.get("t")).toBe("tkt-1");
    expect(u.searchParams.get("q")).toBe("rate limit & co?");
    expect(u.searchParams.has("tab")).toBe(false);
  });

  test("an empty query is left out", () => {
    const u = new URL(launcherUrl(BASE, { mode: "window", ticket: "x", query: "" }));
    expect([...u.searchParams.keys()].sort()).toEqual(["mode", "t"]);
  });

  test("unicode and reserved characters survive the round trip", () => {
    const q = "Zürich #launch /plan +1 %20";
    const t = "a&b=c";
    const u = new URL(launcherUrl(BASE, { mode: "overlay", ticket: t, query: q }));
    expect(u.searchParams.get("q")).toBe(q);
    expect(u.searchParams.get("t")).toBe(t);
  });
});

/** chrome.storage.session stand-in. */
function sessionArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key: string) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, structuredClone(items));
    },
  };
}

describe("launcher tickets", () => {
  const T0 = 1_700_000_000_000;

  test("a ticket redeems once, for its mode, and yields its tab", async () => {
    const area = sessionArea();
    const id = await issueLauncherTicket(area, { mode: "overlay", tabId: 42 }, T0);
    expect(await redeemLauncherTicket(area, id, "overlay", T0 + 10)).toEqual({ mode: "overlay", tabId: 42, at: T0 });
    expect(await redeemLauncherTicket(area, id, "overlay", T0 + 20)).toBeNull(); // single use
  });

  test("tab id 0 is a real tab and survives", async () => {
    const area = sessionArea();
    const id = await issueLauncherTicket(area, { mode: "overlay", tabId: 0 }, T0);
    expect((await redeemLauncherTicket(area, id, "overlay", T0))?.tabId).toBe(0);
  });

  test("a mode mismatch is refused and still burns the ticket", async () => {
    const area = sessionArea();
    const id = await issueLauncherTicket(area, { mode: "window" }, T0);
    expect(await redeemLauncherTicket(area, id, "overlay", T0)).toBeNull();
    expect(await redeemLauncherTicket(area, id, "window", T0)).toBeNull();
  });

  test("tickets expire after the TTL (exclusive)", async () => {
    const area = sessionArea();
    const fresh = await issueLauncherTicket(area, { mode: "overlay", tabId: 1 }, T0, "0-0-0-0-fresh");
    const stale = await issueLauncherTicket(area, { mode: "overlay", tabId: 2 }, T0, "0-0-0-0-stale");
    expect(await redeemLauncherTicket(area, fresh, "overlay", T0 + TICKET_TTL_MS - 1)).not.toBeNull();
    expect(await redeemLauncherTicket(area, stale, "overlay", T0 + TICKET_TTL_MS)).toBeNull();
  });

  test("missing, empty, unknown and prototype-key ids redeem nothing", async () => {
    const area = sessionArea();
    await issueLauncherTicket(area, { mode: "overlay", tabId: 1 }, T0);
    for (const id of [null, "", "nope", "__proto__", "constructor", "toString"]) {
      expect(await redeemLauncherTicket(area, id, "overlay", T0)).toBeNull();
    }
  });

  test("issuing prunes expired tickets so storage doesn't grow", async () => {
    const area = sessionArea();
    for (let i = 0; i < 5; i++) await issueLauncherTicket(area, { mode: "overlay" }, T0, `0-0-0-0-old${i}`);
    await issueLauncherTicket(area, { mode: "overlay" }, T0 + TICKET_TTL_MS + 1, "0-0-0-0-new");
    expect(Object.keys((area.data.launcherTickets ?? {}) as object)).toEqual(["0-0-0-0-new"]);
  });

  test("ids are random by default", async () => {
    const area = sessionArea();
    const a = await issueLauncherTicket(area, { mode: "overlay" }, T0);
    const b = await issueLauncherTicket(area, { mode: "overlay" }, T0);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});

// ---------- mountLauncherFrame against a tiny fake DOM ----------

class FakeEl {
  id = "";
  src = "";
  title = "";
  allow = "";
  attrs: Record<string, string> = {};
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  focused = 0;
  /** What postMessage events from inside this iframe carry as `source`. */
  contentWindow: object | null;
  listeners: Record<string, (() => void)[]> = {};
  constructor(readonly tag: string) {
    this.contentWindow = tag === "iframe" ? { frameOf: this } : null;
  }
  /** Inline styles set with style.setProperty (display: none hides a closing frame). */
  styles: Record<string, string> = {};
  style = { setProperty: (k: string, v: string) => void (this.styles[k] = v) };
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  removeAttribute(k: string) {
    if (k === "id") this.id = "";
    delete this.attrs[k];
  }
  appendChild(c: FakeEl) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  focus() {
    this.focused++;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
}

type MsgListener = (e: { origin: string; data: unknown; source: unknown }) => void;

function fakeDom(opts: { body?: boolean } = {}) {
  const documentElement = new FakeEl("html");
  const body = opts.body === false ? null : documentElement.appendChild(new FakeEl("body"));
  const active = new FakeEl("input");
  const all = () => {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl) => (out.push(e), e.children.forEach(walk));
    walk(documentElement);
    return out;
  };
  const listeners: MsgListener[] = [];
  const document = {
    documentElement,
    body,
    activeElement: active,
    getElementById: (id: string) => all().find((e) => e.id === id) ?? null,
    createElement: (tag: string) => new FakeEl(tag),
  };
  const window = {
    addEventListener: (type: string, fn: MsgListener) => type === "message" && listeners.push(fn),
    removeEventListener: (type: string, fn: MsgListener) => {
      const i = listeners.indexOf(fn);
      if (type === "message" && i >= 0) listeners.splice(i, 1);
    },
  };
  /** A message from the launcher iframe (by default), or from `source` if given. */
  const post = (origin: string, data: unknown, source?: unknown) => {
    const frame = all().find((e) => e.tag === "iframe" && e.styles.display !== "none");
    const src = source === undefined ? frame?.contentWindow : source;
    [...listeners].forEach((l) => l({ origin, data, source: src }));
  };
  return { document, window, listeners, post, active, /** Launcher frames still showing (a closing one is hidden at once, removed a moment later). */
    frames: () => all().filter((e) => e.tag === "iframe" && e.styles.display !== "none"),
    attached: () => all().filter((e) => e.tag === "iframe"), root: body ?? documentElement };
}

/** Chrome gives chrome-extension: URLs a real origin; Bun (per WHATWG) says "null". Emulate Chrome. */
class ChromeURL extends URL {
  override get origin(): string {
    return this.protocol === "chrome-extension:" ? `${this.protocol}//${this.host}` : super.origin;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: { document: unknown; window: unknown; URL: unknown };
let dom: ReturnType<typeof fakeDom>;

function install(d: ReturnType<typeof fakeDom>) {
  dom = d;
  g.document = d.document;
  g.window = d.window;
}

beforeEach(() => {
  saved = { document: g.document, window: g.window, URL: g.URL };
  g.URL = ChromeURL;
  install(fakeDom());
});
afterEach(() => {
  g.document = saved.document;
  g.window = saved.window;
  g.URL = saved.URL;
});

const SRC = launcherUrl(BASE, { mode: "overlay", ticket: "t1" });

describe("mountLauncherFrame", () => {
  test("mounts one full-screen iframe on top of everything", () => {
    expect(mountLauncherFrame(SRC, LAUNCHER_CLOSE)).toBe("opened");
    const [f] = dom.frames();
    expect(dom.frames()).toHaveLength(1);
    expect(f!.id).toBe("faber-launcher-frame");
    expect(f!.src).toBe(SRC);
    expect(f!.title).toBe("Faber launcher");
    expect(f!.parent).toBe(dom.root);
    const style = f!.attrs.style!;
    expect(style).toContain("position:fixed!important");
    expect(style).toContain("z-index:2147483647!important");
    expect(style).toContain("background:transparent!important");
  });

  test("the iframe takes focus once it loads", () => {
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    const [f] = dom.frames();
    expect(f!.focused).toBe(0);
    f!.listeners.load!.forEach((fn) => fn());
    expect(f!.focused).toBe(1);
  });

  test("calling it again toggles the launcher closed (the shortcut toggles)", () => {
    expect(mountLauncherFrame(SRC, LAUNCHER_CLOSE)).toBe("opened");
    expect(mountLauncherFrame(SRC, LAUNCHER_CLOSE)).toBe("closed");
    expect(dom.frames()).toHaveLength(0);
    expect(mountLauncherFrame(SRC, LAUNCHER_CLOSE)).toBe("opened");
    expect(dom.frames()).toHaveLength(1);
  });

  test("a close message from the extension's origin removes it and gives focus back", () => {
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    dom.post(ORIGIN, { type: LAUNCHER_CLOSE });
    expect(dom.frames()).toHaveLength(0);
    expect(dom.active.focused).toBe(1);
    expect(dom.listeners).toHaveLength(0); // the listener is cleaned up
  });

  test("a closed frame is hidden and loses its id at once, then is removed from the page", async () => {
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    const [f] = dom.frames();
    dom.post(ORIGIN, { type: LAUNCHER_CLOSE });
    expect(f!.styles.display).toBe("none");
    expect(f!.id).toBe("");
    expect(dom.document.getElementById("faber-launcher-frame")).toBeNull();
    await Bun.sleep(150);
    expect(dom.attached()).toHaveLength(0);
  });

  test("close messages from the page itself or other origins are ignored", () => {
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    for (const origin of ["https://evil.example", "chrome-extension://otherextensionidotherextensionid", "null", ""]) {
      dom.post(origin, { type: LAUNCHER_CLOSE });
    }
    expect(dom.frames()).toHaveLength(1);
    expect(dom.active.focused).toBe(0);
  });

  test("other message types and junk payloads from the right origin are ignored", () => {
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    for (const data of [null, undefined, "faber:launcher-close", { type: "something-else" }, { kind: LAUNCHER_CLOSE }, 42]) {
      dom.post(ORIGIN, data);
    }
    expect(dom.frames()).toHaveLength(1);
  });

  test("a page without <body> (e.g. an XML or frameset document) gets the frame on <html>", () => {
    install(fakeDom({ body: false }));
    expect(mountLauncherFrame(SRC, LAUNCHER_CLOSE)).toBe("opened");
    expect(dom.frames()[0]!.parent).toBe(dom.document.documentElement);
  });

  test("closing with the shortcut and reopening still closes on the next message", () => {
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    mountLauncherFrame(SRC, LAUNCHER_CLOSE); // toggled closed by the shortcut
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    dom.post(ORIGIN, { type: LAUNCHER_CLOSE });
    expect(dom.frames()).toHaveLength(0);
    expect(dom.listeners).toHaveLength(0);
  });

  // Regression: the shortcut toggle used to leave the message listener behind (fixed in 78786ce).
  test("closing with the shortcut removes the message listener and restores focus", () => {
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    expect(dom.listeners).toHaveLength(1);
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    expect(dom.listeners).toHaveLength(0);
    expect(dom.active.focused).toBe(1);
  });

  test("a close message from the right origin but another window (e.g. a page-made frame of launcher.html) is ignored", () => {
    mountLauncherFrame(SRC, LAUNCHER_CLOSE);
    for (const source of [null, {}, globalThis, { frameOf: null }]) dom.post(ORIGIN, { type: LAUNCHER_CLOSE }, source);
    expect(dom.frames()).toHaveLength(1);
    dom.post(ORIGIN, { type: LAUNCHER_CLOSE });
    expect(dom.frames()).toHaveLength(0);
  });

  test("it is self-contained: the function source references no imports (chrome.scripting serialises it)", () => {
    const src = mountLauncherFrame.toString();
    expect(src).not.toMatch(/\bLAUNCHER_CLOSE\b|\b__vite|\brequire\(|\bimport\(/);
  });
});
