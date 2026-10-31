import type { DocSource, WatchRule } from "@faber/shared";

/** Max characters of exported Google text sent to the daemon. */
export const MAX_EXPORT_CHARS = 500_000;
/** Give up on an export that takes longer than this. */
export const EXPORT_TIMEOUT_MS = 30_000;
/** After Google rate-limits us, pause the backfill this long. */
export const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * `transient` failures (network, timeout, 429, 5xx) are retried later and are
 * NOT reported to the daemon, which would count them against the doc's limited
 * fetch attempts. Permanent ones (no access, not found) are reported.
 */
export type ExportResult =
  | { ok: true; text: string }
  | { ok: false; error: string; transient: boolean; rateLimited?: boolean };

export interface ExportHead {
  status: number;
  contentType: string | null;
  /** URL after redirects; Google bounces signed-out users to accounts.google.com. */
  finalUrl: string;
}

/** Decide from status/headers alone whether the body is worth reading. Returns null when it is. */
export function classifyExportHead(h: ExportHead): Extract<ExportResult, { ok: false }> | null {
  if (h.status === 401 || h.status === 403) {
    return { ok: false, transient: false, error: `No access (${h.status}): sign in to Google in this browser profile or request access` };
  }
  if (h.status === 404) return { ok: false, transient: false, error: "Document not found (404): it may have been deleted" };
  if (h.status === 429) return { ok: false, transient: true, rateLimited: true, error: "Rate limited by Google (429)" };
  if (h.status === 408 || h.status >= 500) return { ok: false, transient: true, error: `Google returned HTTP ${h.status}` };
  if (h.status < 200 || h.status >= 300) return { ok: false, transient: false, error: `Export failed with HTTP ${h.status}` };

  let host = "";
  try {
    host = new URL(h.finalUrl).hostname;
  } catch {
    /* keep empty */
  }
  if (host === "accounts.google.com") {
    return { ok: false, transient: false, error: "Not signed in: Google redirected to the sign-in page" };
  }
  if ((h.contentType ?? "").toLowerCase().includes("text/html")) {
    return { ok: false, transient: false, error: "Got a web page instead of the document text: not signed in or no access" };
  }
  return null;
}

export function cleanExportText(raw: string, max = MAX_EXPORT_CHARS): string {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** Read a response body as text, stopping (and cancelling the download) once `maxChars` is reached. */
export async function readTextCapped(body: ReadableStream<Uint8Array> | null, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= maxChars) {
        await reader.cancel().catch(() => {});
        return { text: text.slice(0, maxChars), truncated: true };
      }
    }
    text += decoder.decode();
    return { text, truncated: false };
  } finally {
    reader.releaseLock();
  }
}

/** Network-level failure (offline, DNS, timeout) while fetching an export URL. Always transient. */
export function exportNetworkError(err: unknown): ExportResult {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return { ok: false, transient: true, error: `Export timed out after ${EXPORT_TIMEOUT_MS / 1000}s` };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, transient: true, error: `Network error fetching export: ${msg}` };
}

const SOURCE_BY_EXTRACTOR: Partial<Record<WatchRule["extractor"], DocSource>> = {
  gdocs: "gdoc",
  gslides: "gslides",
  gsheets: "gsheets",
};

/** Google sources whose watch rule is enabled: the only ones the backfill may fetch. */
export function enabledGoogleSources(rules: readonly WatchRule[]): DocSource[] {
  const out: DocSource[] = [];
  for (const r of rules) {
    const s = r.builtin && r.enabled ? SOURCE_BY_EXTRACTOR[r.extractor] : undefined;
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
