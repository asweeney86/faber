import { ApiRequestError, type CaptureRequest } from "@faber/shared";

/**
 * Captures recorded while the daemon was unreachable, flushed in order once it
 * is back. Bounded in count and in bytes so it can never fill chrome.storage.local
 * (10 MB): page text is capped per item, and when the total is still too large
 * the oldest items lose their text first, then are dropped.
 */

export interface QueuedCapture {
  id: string;
  req: CaptureRequest;
  /** Failed send attempts so far. */
  attempts: number;
}

export interface QueueLimits {
  maxItems: number;
  maxItemChars: number;
  maxTotalBytes: number;
  maxAttempts: number;
}

export const QUEUE_LIMITS: QueueLimits = {
  maxItems: 500,
  maxItemChars: 50_000,
  maxTotalBytes: 5_000_000,
  maxAttempts: 5,
};

/** Approximate stored size (chrome.storage serialises to JSON). */
export function queueBytes(q: readonly QueuedCapture[]): number {
  let n = 2;
  for (const it of q) n += JSON.stringify(it).length + 1;
  return n;
}

export function enqueueCapture(
  queue: readonly QueuedCapture[],
  req: CaptureRequest,
  opts: { id?: string; now?: number; limits?: Partial<QueueLimits> } = {},
): QueuedCapture[] {
  const lim = { ...QUEUE_LIMITS, ...opts.limits };
  const ts = req.ts ?? opts.now ?? Date.now();
  if (queue.some((q) => q.req.url === req.url && q.req.ts === ts)) return [...queue];
  const capped: CaptureRequest = { ...req, ts };
  if (capped.content !== undefined && capped.content.length > lim.maxItemChars) capped.content = capped.content.slice(0, lim.maxItemChars);

  let next = [...queue, { id: opts.id ?? crypto.randomUUID(), req: capped, attempts: 0 }];
  if (next.length > lim.maxItems) next = next.slice(next.length - lim.maxItems);
  return shrinkToFit(next, lim.maxTotalBytes);
}

/** Strip text from the oldest items, then drop the oldest items, until the queue fits. */
export function shrinkToFit(queue: QueuedCapture[], maxBytes: number): QueuedCapture[] {
  const next = [...queue];
  let size = queueBytes(next);
  for (let i = 0; i < next.length && size > maxBytes; i++) {
    const it = next[i]!;
    if (it.req.content === undefined) continue;
    const { content: _drop, ...rest } = it.req;
    next[i] = { ...it, req: rest };
    size = queueBytes(next);
  }
  while (next.length > 0 && size > maxBytes) {
    next.shift();
    size = queueBytes(next);
  }
  return next;
}

/** The daemon is up but hasn't approved this extension yet (Settings → Capture & Sources in the app). */
export function isPairingRequired(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 403 && /^pairing required/i.test(err.message);
}

/**
 * True when the failure means "try again later": the daemon is unreachable
 * (fetch rejects with TypeError), timed out, or answered 408/429/5xx.
 * Anything else (4xx, bad data) will never succeed and is dropped.
 */
export function isRetryable(err: unknown): boolean {
  if (isPairingRequired(err)) return true;
  if (err instanceof ApiRequestError) return err.status >= 500 || err.status === 408 || err.status === 429;
  if (err instanceof TypeError) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export interface FlushResult {
  sentIds: string[];
  droppedIds: string[];
  /** The item whose send failed retryably; flushing stopped there. */
  failedId: string | null;
  /** False when the failure was not the item's fault (awaiting pairing), so it shouldn't use up an attempt. */
  countAttempt: boolean;
}

/**
 * Send items oldest-first. Stops at the first retryable failure (daemon still
 * down); items the daemon rejects outright are dropped.
 */
export async function flushQueue(items: readonly QueuedCapture[], send: (c: CaptureRequest) => Promise<void>): Promise<FlushResult> {
  const r: FlushResult = { sentIds: [], droppedIds: [], failedId: null, countAttempt: true };
  for (const it of items) {
    try {
      await send(it.req);
      r.sentIds.push(it.id);
    } catch (err) {
      if (isRetryable(err)) {
        r.failedId = it.id;
        r.countAttempt = !isPairingRequired(err);
        return r;
      }
      r.droppedIds.push(it.id);
    }
  }
  return r;
}

/**
 * Apply a flush result to the *current* queue (which may have gained items
 * while flushing): remove what was sent or dropped, count the failed attempt,
 * and give up on an item after `maxAttempts`.
 */
export function applyFlush(queue: readonly QueuedCapture[], r: FlushResult, maxAttempts = QUEUE_LIMITS.maxAttempts): QueuedCapture[] {
  const gone = new Set([...r.sentIds, ...r.droppedIds]);
  const out: QueuedCapture[] = [];
  for (const it of queue) {
    if (gone.has(it.id)) continue;
    if (it.id === r.failedId && r.countAttempt) {
      const attempts = it.attempts + 1;
      if (attempts >= maxAttempts) continue;
      out.push({ ...it, attempts });
    } else {
      out.push(it);
    }
  }
  return out;
}
