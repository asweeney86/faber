/**
 * Site icons for web-page documents, shown next to their titles.
 *
 * The daemon asks the site itself (never a third-party favicon service): it reads the home
 * page's <link rel="icon"> tags and falls back to /favicon.ico. Icons are cached on disk per
 * host, and so is "this site has none", so each site is asked at most once a week.
 * Only hosts of documents already in the library are fetched (callers look the doc up first).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_HTML = 256 * 1024;
const MAX_ICON = 256 * 1024;
const TIMEOUT_MS = 5_000;
const MISS_TTL_MS = 7 * 24 * 3600_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Faber";

export interface Icon {
  type: string;
  bytes: Uint8Array;
}

interface Meta {
  type: string | null;
  at: number;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Google's own icons for Docs, Slides and Sheets. Their pages sit behind sign-in, so the
 * icon can't be read from the page; Google serves these at fixed addresses.
 */
export const GOOGLE_ICONS = {
  gdoc: "https://ssl.gstatic.com/docs/documents/images/kix-favicon-2023q4.ico",
  gslides: "https://ssl.gstatic.com/docs/presentations/images/favicon-2023q4.ico",
  gsheets: "https://ssl.gstatic.com/docs/spreadsheets/spreadsheets_2023q4.ico",
} as const;

export class Favicons {
  private dir: string;
  private inflight = new Map<string, Promise<Icon | null>>();

  constructor(
    home: string,
    private fetcher: Fetcher = fetch,
  ) {
    this.dir = join(home, "favicons");
  }

  /** The icon for the site at `pageUrl`, or null if it has none (or can't be reached). */
  async get(pageUrl: string): Promise<Icon | null> {
    let origin: URL;
    try {
      origin = new URL(pageUrl);
    } catch {
      return null;
    }
    if (origin.protocol !== "https:" && origin.protocol !== "http:") return null;
    const host = origin.host.toLowerCase();
    if (!/^[a-z0-9.\-:\[\]]+$/.test(host)) return null;
    return this.once(host, () => this.fetchIcon(`${origin.protocol}//${origin.host}`));
  }

  /** The icon for a Google Docs, Slides or Sheets document. */
  async google(kind: keyof typeof GOOGLE_ICONS): Promise<Icon | null> {
    return this.once(`google-${kind}`, () => this.fetchImage(GOOGLE_ICONS[kind]));
  }

  /** From the disk cache, or fetched once (concurrent callers share the fetch) and cached. */
  private async once(key: string, load: () => Promise<Icon | null>): Promise<Icon | null> {
    const cached = this.cached(key);
    if (cached !== undefined) return cached;
    let p = this.inflight.get(key);
    if (!p) {
      p = load()
        .catch(() => null)
        .then((icon) => {
          this.store(key, icon);
          return icon;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private file(host: string) {
    return join(this.dir, host.replace(/[:\[\]]/g, "_"));
  }

  /** undefined = not cached (or a stale miss), null = known to have none. */
  private cached(host: string): Icon | null | undefined {
    const f = this.file(host);
    if (!existsSync(`${f}.json`)) return undefined;
    try {
      const meta = JSON.parse(readFileSync(`${f}.json`, "utf8")) as Meta;
      if (!meta.type) return Date.now() - meta.at < MISS_TTL_MS ? null : undefined;
      return { type: meta.type, bytes: new Uint8Array(readFileSync(`${f}.icon`)) };
    } catch {
      return undefined;
    }
  }

  private store(host: string, icon: Icon | null) {
    try {
      mkdirSync(this.dir, { recursive: true });
      const f = this.file(host);
      if (icon) writeFileSync(`${f}.icon`, icon.bytes);
      const meta: Meta = { type: icon?.type ?? null, at: Date.now() };
      writeFileSync(`${f}.json.tmp`, JSON.stringify(meta));
      renameSync(`${f}.json.tmp`, `${f}.json`);
    } catch {
      // A read-only home just means asking again next time.
    }
  }

  private async fetchIcon(origin: string): Promise<Icon | null> {
    const candidates: string[] = [];
    const html = await this.fetchText(`${origin}/`);
    if (html) candidates.push(...iconLinks(html.text, html.url));
    candidates.push(`${origin}/favicon.ico`);
    for (const url of [...new Set(candidates)].slice(0, 4)) {
      const icon = await this.fetchImage(url);
      if (icon) return icon;
    }
    return null;
  }

  private async request(url: string, accept: string) {
    return this.fetcher(url, { redirect: "follow", headers: { accept, "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  private async fetchText(url: string): Promise<{ text: string; url: string } | null> {
    try {
      const res = await this.request(url, "text/html");
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
      const bytes = await readCapped(res, MAX_HTML, true);
      return bytes ? { text: new TextDecoder().decode(bytes), url: res.url || url } : null;
    } catch {
      return null;
    }
  }

  private async fetchImage(url: string): Promise<Icon | null> {
    if (url.startsWith("data:")) return decodeDataUrl(url);
    try {
      const res = await this.request(url, "image/*");
      if (!res.ok) return null;
      const bytes = await readCapped(res, MAX_ICON, false);
      if (!bytes || bytes.length === 0) return null;
      const type = sniffImage(bytes, res.headers.get("content-type"));
      return type ? { type, bytes } : null;
    } catch {
      return null;
    }
  }
}

/** Read a body up to `max` bytes; past that, null (or the first `max` bytes if `truncate`). */
async function readCapped(res: Response, max: number, truncate: boolean): Promise<Uint8Array | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      if (!truncate) return null;
      break;
    }
  }
  const out = new Uint8Array(Math.min(n, max));
  let o = 0;
  for (const p of parts) {
    const take = Math.min(p.length, out.length - o);
    out.set(p.subarray(0, take), o);
    o += take;
    if (o >= out.length) break;
  }
  return out;
}

/**
 * Icon URLs from a page's <link> tags, best first: SVG, then the largest PNG/ICO up to 64px
 * (we draw them at 14–20px), then apple-touch icons.
 */
export function iconLinks(html: string, base: string): string[] {
  const end = html.search(/<\/head>/i);
  const head = end >= 0 ? html.slice(0, end) : html;
  const found: { url: string; score: number }[] = [];
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = attr(tag, "rel")?.toLowerCase() ?? "";
    const href = attr(tag, "href");
    if (!href || !/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) continue;
    let url: string;
    try {
      url = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!/^(https?:|data:image\/)/i.test(url)) continue;
    const type = attr(tag, "type") ?? "";
    const size = Number(/(\d+)x\d+/i.exec(attr(tag, "sizes") ?? "")?.[1] ?? 0);
    let score = rel.includes("apple-touch-icon") ? 10 : 50;
    if (type.includes("svg") || /\.svg(\?|$)/i.test(url)) score = 100;
    // Small icons that fit a row best (we draw 14–20px), then bigger ones, smallest first.
    else if (size) score += size <= 64 ? 20 + size / 16 : Math.max(1, 10 - size / 64);
    found.push({ url, score });
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.url);
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/g, "&").trim();
}

function decodeDataUrl(url: string): Icon | null {
  const m = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(url);
  if (!m) return null;
  try {
    const bytes = m[2] ? Uint8Array.from(atob(m[3]!), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]!));
    if (bytes.length === 0 || bytes.length > MAX_ICON) return null;
    const type = sniffImage(bytes, m[1]!);
    return type ? { type, bytes } : null;
  } catch {
    return null;
  }
}

/**
 * The image type, from the bytes rather than the server's word for it, so an HTML error page
 * served as "image/x-icon" isn't passed on. SVG is served with a strict CSP (see server.ts).
 */
export function sniffImage(b: Uint8Array, declared: string | null): string | null {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
  if ((declared ?? "").includes("svg") || head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return head.includes("<svg") ? "image/svg+xml" : null;
  }
  return null;
}
