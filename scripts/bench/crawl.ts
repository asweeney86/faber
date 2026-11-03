#!/usr/bin/env bun
/**
 * Fill a Faber library with real reading: news and tech articles from public RSS feeds and
 * Hacker News, captured the way the browser extension captures a page (URL, title, visible
 * text, visit time). Each page gets a plausible browsing history (a first visit after it
 * was published, and for some, repeat visits), so ranking by use has something to work with.
 *
 *   bun scripts/bench/crawl.ts [--daemon http://127.0.0.1:7777] [--target 1000] [--out ~/.faber/bench]
 *
 * Writes <out>/corpus.json: every captured page with its text and visits, which
 * scripts/bench/run.ts uses to build recall queries. Re-running adds only new pages.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    daemon: { type: "string", default: "http://127.0.0.1:7777" },
    target: { type: "string", default: "1000" },
    out: { type: "string", default: join(homedir(), ".faber", "bench") },
    seed: { type: "string", default: "42" },
  },
});
const DAEMON = values.daemon!.replace(/\/$/, "");
const TARGET = Number(values.target);
const OUT = values.out!;
mkdirSync(OUT, { recursive: true });

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const DAY = 86_400_000;

/** Feeds by site. NYT blocks scripted article fetches, so its pages carry the feed's summary. */
const FEEDS: { site: string; url: string; textFromFeed?: boolean }[] = [
  ...["", "world/", "uk/", "business/", "technology/", "science_and_environment/", "health/", "entertainment_and_arts/", "politics/", "education/"].map((s) => ({
    site: "BBC",
    url: `https://feeds.bbci.co.uk/news/${s}rss.xml`,
  })),
  ...["HomePage", "World", "US", "Business", "Technology", "Science", "Health", "Arts", "Climate", "Books", "Travel", "Sports", "Politics", "Upshot"].map((s) => ({
    site: "NYT",
    url: `https://rss.nytimes.com/services/xml/rss/nyt/${s}.xml`,
    textFromFeed: true,
  })),
  ...["world", "technology", "science", "uk/business", "environment", "culture", "books", "us-news", "lifeandstyle", "sport"].map((s) => ({
    site: "Guardian",
    url: `https://www.theguardian.com/${s}/rss`,
  })),
  { site: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  { site: "NPR", url: "https://feeds.npr.org/1019/rss.xml" },
  { site: "NPR", url: "https://feeds.npr.org/1007/rss.xml" },
  { site: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { site: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/science" },
  { site: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { site: "Wired", url: "https://www.wired.com/feed/rss" },
  { site: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
];

export interface CorpusDoc {
  url: string;
  site: string;
  title: string;
  /** What was captured as the page text. */
  text: string;
  /** "page" = fetched article text, "feed" = the feed's summary (page unavailable). */
  text_from: "page" | "feed";
  published: number | null;
  visits: number[];
}

// ---------- tiny deterministic RNG, so a re-run builds the same history ----------
let seed = Number(values.seed) >>> 0 || 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

async function get(url: string, accept = "*/*"): Promise<Response | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

interface FeedItem {
  url: string;
  title: string;
  summary: string;
  published: number | null;
}

/** RSS <item> or Atom <entry>. */
function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)) {
    const block = m[0];
    const tag = (name: string) => {
      const t = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
      return t ? decode(t[1]!) : "";
    };
    let url = tag("link");
    if (!url) url = /<link\b[^>]*href="([^"]+)"/.exec(block)?.[1] ?? "";
    url = url.replace(/&amp;/g, "&").trim();
    if (!/^https?:\/\//.test(url)) continue;
    const when = Date.parse(tag("pubDate") || tag("published") || tag("updated") || tag("dc:date"));
    out.push({ url: cleanUrl(url), title: tag("title"), summary: tag("description") || tag("summary") || tag("content"), published: Number.isFinite(when) ? when : null });
  }
  return out;
}

/** Drop tracking parameters: the same article shouldn't become two documents. */
function cleanUrl(u: string): string {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|at_|cmp|smid|partner|ref$|src$)/i.test(k)) url.searchParams.delete(k);
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

/** Readable text of an article page: its paragraphs, minus navigation, footers and boilerplate. */
async function articleText(html: string): Promise<{ title: string; text: string }> {
  const paras: string[] = [];
  let skip = 0;
  let current: string[] | null = null;
  let title = "";
  const rw = new HTMLRewriter()
    .on("meta[property='og:title']", { element: (e) => void (title ||= e.getAttribute("content") ?? "") })
    .on("nav, footer, aside, header, script, style, noscript, figure, form", {
      element(e) {
        skip++;
        e.onEndTag(() => void skip--);
      },
    })
    .on("p, h2, li", {
      element(e) {
        if (skip) return;
        current = [];
        const mine = current;
        e.onEndTag(() => {
          const t = decode(mine.join(""));
          if (t.length >= 40) paras.push(t);
          if (current === mine) current = null;
        });
      },
      text(t) {
        if (current && !skip) current.push(t.text);
      },
    });
  await rw.transform(new Response(html)).text();
  const seen = new Set<string>();
  const text = paras.filter((p) => !seen.has(p) && seen.add(p)).join("\n\n");
  return { title: decode(title), text: text.slice(0, 30_000) };
}

async function hackerNews(limit: number): Promise<{ site: string; item: FeedItem }[]> {
  const ids = new Set<number>();
  for (const list of ["topstories", "beststories", "newstories"]) {
    const res = await get(`https://hacker-news.firebaseio.com/v0/${list}.json`);
    if (res) for (const id of ((await res.json()) as number[]).slice(0, 200)) ids.add(id);
  }
  const items: { site: string; item: FeedItem }[] = [];
  const queue = [...ids];
  await pool(queue, 12, async (id) => {
    if (items.length >= limit) return;
    const res = await get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    const it = res ? ((await res.json()) as { url?: string; title?: string; time?: number; type?: string } | null) : null;
    if (!it?.url || it.type !== "story") return;
    items.push({ site: "Hacker News", item: { url: cleanUrl(it.url), title: it.title ?? "", summary: "", published: it.time ? it.time * 1000 : null } });
  });
  return items;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

/** A plausible history: first visit after publication (mostly recent), some pages revisited. */
function history(published: number | null, now: number): number[] {
  const earliest = Math.max(published ?? now - 30 * DAY, now - 30 * DAY);
  const first = earliest + rand() * Math.max(60_000, now - earliest - 60_000);
  const visits = [first];
  // Zipf-ish: most pages are read once, a few become regulars.
  const r = rand();
  const extra = r < 0.7 ? 0 : r < 0.88 ? 1 : r < 0.96 ? 3 : 8;
  for (let k = 0; k < extra; k++) visits.push(first + rand() * (now - first));
  return visits.sort((a, b) => a - b).map(Math.round);
}

async function capture(doc: CorpusDoc) {
  const [first, ...rest] = doc.visits;
  const post = (body: unknown) =>
    fetch(`${DAEMON}/api/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const r = await post({ url: doc.url, title: doc.title, ts: first, dwell_ms: 20_000 + Math.round(rand() * 120_000), content: doc.text });
  if (!r.ok) throw new Error(`capture ${doc.url}: ${r.status} ${await r.text()}`);
  for (const ts of rest) await post({ url: doc.url, title: doc.title, ts, dwell_ms: 15_000 });
}

// ---------- main ----------
const corpusPath = join(OUT, "corpus.json");
const corpus: CorpusDoc[] = existsSync(corpusPath) ? JSON.parse(readFileSync(corpusPath, "utf8")) : [];
const have = new Set(corpus.map((d) => d.url));
const started = performance.now();
const now = Date.now();

const candidates: { site: string; item: FeedItem; textFromFeed?: boolean }[] = [];
await pool(FEEDS, 6, async (f) => {
  const res = await get(f.url, "application/rss+xml, application/atom+xml, application/xml, text/xml");
  if (!res) return console.error(`  feed unavailable: ${f.url}`);
  for (const item of parseFeed(await res.text())) candidates.push({ site: f.site, item, textFromFeed: f.textFromFeed });
});
candidates.push(...(await hackerNews(250)));
// Interleave sites so a partial run is still a mix, and skip what we already have.
const bySite = new Map<string, typeof candidates>();
for (const c of candidates) {
  if (have.has(c.item.url) || !c.item.title) continue;
  have.add(c.item.url);
  bySite.set(c.site, [...(bySite.get(c.site) ?? []), c]);
}
const order: typeof candidates = [];
for (let more = true; more; ) {
  more = false;
  for (const list of bySite.values()) {
    const c = list.shift();
    if (c) {
      order.push(c);
      more = true;
    }
  }
}
console.log(`${candidates.length} feed items, ${order.length} new; capturing up to ${TARGET - corpus.length}`);

let added = 0;
let failed = 0;
const captureMs: number[] = [];
await pool(order, 8, async (c) => {
  if (corpus.length >= TARGET) return;
  let text = "";
  let from: "page" | "feed" = "feed";
  let title = c.item.title;
  if (!c.textFromFeed) {
    const res = await get(c.item.url, "text/html");
    if (res && (res.headers.get("content-type") ?? "").includes("html")) {
      const page = await articleText(await res.text());
      if (page.text.length >= 400) {
        text = page.text;
        from = "page";
        title = c.item.title || page.title;
      }
    }
  }
  if (!text) text = [c.item.title, c.item.summary].filter(Boolean).join("\n\n");
  if (text.length < 60) {
    failed++;
    return;
  }
  if (corpus.length >= TARGET) return;
  const doc: CorpusDoc = { url: c.item.url, site: c.site, title, text, text_from: from, published: c.item.published, visits: history(c.item.published, now) };
  const t = performance.now();
  try {
    await capture(doc);
  } catch (e) {
    failed++;
    console.error(`  ${e instanceof Error ? e.message : e}`);
    return;
  }
  captureMs.push(performance.now() - t);
  corpus.push(doc);
  added++;
  if (added % 50 === 0) {
    console.log(`  ${corpus.length} pages (${added} new, ${failed} skipped)`);
    writeFileSync(corpusPath, JSON.stringify(corpus));
  }
});
writeFileSync(corpusPath, JSON.stringify(corpus));

captureMs.sort((a, b) => a - b);
const q = (p: number) => Math.round(captureMs[Math.floor((captureMs.length - 1) * p)] ?? 0);
const sites = new Map<string, number>();
for (const d of corpus) sites.set(d.site, (sites.get(d.site) ?? 0) + 1);
const summary = {
  pages: corpus.length,
  added,
  skipped: failed,
  from_page: corpus.filter((d) => d.text_from === "page").length,
  from_feed: corpus.filter((d) => d.text_from === "feed").length,
  sites: Object.fromEntries([...sites].sort((a, b) => b[1] - a[1])),
  capture_ms: { p50: q(0.5), p95: q(0.95), max: q(1) },
  seconds: Math.round((performance.now() - started) / 1000),
};
writeFileSync(join(OUT, "crawl-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
