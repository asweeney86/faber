import { describe, expect, test } from "bun:test";
import { ApiRequestError, type CaptureRequest } from "@faber/shared";
import { Mutex } from "./mutex";
import { QUEUE_LIMITS, applyFlush, enqueueCapture, flushQueue, isPairingRequired, isRetryable, queueBytes, type QueuedCapture } from "./queue";

const req = (url: string, ts: number, content?: string): CaptureRequest => ({ url, ts, ...(content !== undefined ? { content } : {}) });
const item = (id: string, url = `https://${id}`, attempts = 0): QueuedCapture => ({ id, req: req(url, 1), attempts });
const PAIRING = new ApiRequestError(403, "pairing required: approve this extension in Faber settings");

describe("enqueueCapture", () => {
  test("appends with an id and a timestamp", () => {
    const q = enqueueCapture([], { url: "https://a.example" }, { id: "x", now: 42 });
    expect(q).toEqual([{ id: "x", req: { url: "https://a.example", ts: 42 }, attempts: 0 }]);
  });

  test("ignores exact duplicates but keeps repeat visits at other times", () => {
    let q = enqueueCapture([], req("https://a", 1));
    q = enqueueCapture(q, req("https://a", 1));
    expect(q).toHaveLength(1);
    expect(enqueueCapture(q, req("https://a", 2))).toHaveLength(2);
  });

  test("drops the oldest beyond the item cap", () => {
    let q: QueuedCapture[] = [];
    for (let i = 0; i < 5; i++) q = enqueueCapture(q, req(`https://${i}`, i), { limits: { maxItems: 3 } });
    expect(q.map((c) => c.req.ts)).toEqual([2, 3, 4]);
  });

  test("caps page text per item", () => {
    const q = enqueueCapture([], req("https://a", 1, "x".repeat(QUEUE_LIMITS.maxItemChars + 100)));
    expect(q[0]!.req.content!.length).toBe(QUEUE_LIMITS.maxItemChars);
  });

  test("keeps the total size under budget: oldest text goes first, then oldest items", () => {
    const limits = { maxItemChars: 1000, maxTotalBytes: 2500 };
    let q: QueuedCapture[] = [];
    for (let i = 0; i < 3; i++) q = enqueueCapture(q, req(`https://${i}`, i, "y".repeat(1000)), { limits });
    expect(queueBytes(q)).toBeLessThanOrEqual(2500);
    expect(q.map((c) => c.req.url)).toEqual(["https://0", "https://1", "https://2"]);
    expect(q[0]!.req.content).toBeUndefined();
    expect(q[2]!.req.content).toHaveLength(1000);

    // A budget too small for even the bare visits drops the oldest items.
    const tiny = enqueueCapture(q, req("https://3", 3), { limits: { maxTotalBytes: 250 } });
    expect(queueBytes(tiny)).toBeLessThanOrEqual(250);
    expect(tiny.at(-1)!.req.url).toBe("https://3");
  });

  test("500 large pages stay far below the 10 MB storage quota", () => {
    let q: QueuedCapture[] = [];
    const page = "z".repeat(300_000);
    for (let i = 0; i < 500; i++) q = enqueueCapture(q, req(`https://${i}`, i, page));
    expect(q).toHaveLength(500);
    expect(queueBytes(q)).toBeLessThanOrEqual(QUEUE_LIMITS.maxTotalBytes);
  });

  test("does not mutate the input", () => {
    const orig = [item("a")];
    enqueueCapture(orig, req("https://b", 2));
    expect(orig).toHaveLength(1);
  });
});

describe("isRetryable / isPairingRequired", () => {
  test("network errors, timeouts, 408/429/5xx and pairing are retryable", () => {
    expect(isRetryable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryable(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(true);
    expect(isRetryable(new ApiRequestError(503, "down"))).toBe(true);
    expect(isRetryable(new ApiRequestError(408, "slow"))).toBe(true);
    expect(isRetryable(new ApiRequestError(429, "slow"))).toBe(true);
    expect(isRetryable(PAIRING)).toBe(true);
  });

  test("other 4xx and programming errors are not", () => {
    expect(isRetryable(new ApiRequestError(400, "bad"))).toBe(false);
    expect(isRetryable(new ApiRequestError(403, "forbidden: origin not allowed"))).toBe(false);
    expect(isRetryable(new SyntaxError("Unexpected token"))).toBe(false);
    expect(isRetryable(new Error("boom"))).toBe(false);
  });

  test("pairing is recognised only from the daemon's 403 message", () => {
    expect(isPairingRequired(PAIRING)).toBe(true);
    expect(isPairingRequired(new ApiRequestError(403, "forbidden"))).toBe(false);
    expect(isPairingRequired(new ApiRequestError(401, "pairing required"))).toBe(false);
  });
});

describe("flushQueue + applyFlush", () => {
  const q = [item("1"), item("2"), item("3")];

  test("sends everything in order when the daemon is up", async () => {
    const sent: string[] = [];
    const r = await flushQueue(q, async (c) => void sent.push(c.url));
    expect(sent).toEqual(["https://1", "https://2", "https://3"]);
    expect(applyFlush(q, r)).toEqual([]);
  });

  test("stops at the first network failure, keeps the rest and counts an attempt", async () => {
    let calls = 0;
    const r = await flushQueue(q, async () => {
      if (++calls === 2) throw new TypeError("Failed to fetch");
    });
    expect(r.sentIds).toEqual(["1"]);
    const next = applyFlush(q, r);
    expect(next.map((i) => [i.id, i.attempts])).toEqual([
      ["2", 1],
      ["3", 0],
    ]);
  });

  test("drops items the daemon rejects and continues", async () => {
    const r = await flushQueue(q, async (c) => {
      if (c.url === "https://2") throw new ApiRequestError(400, "bad url");
    });
    expect(r.droppedIds).toEqual(["2"]);
    expect(applyFlush(q, r)).toEqual([]);
  });

  test("gives up on a poison item after the max attempts", async () => {
    let cur: QueuedCapture[] = [item("p")];
    for (let i = 0; i < QUEUE_LIMITS.maxAttempts; i++) {
      const r = await flushQueue(cur, async () => {
        throw new ApiRequestError(500, "boom");
      });
      cur = applyFlush(cur, r);
    }
    expect(cur).toEqual([]);
  });

  test("waiting for pairing does not use up attempts", async () => {
    let cur: QueuedCapture[] = [item("p")];
    for (let i = 0; i < QUEUE_LIMITS.maxAttempts + 2; i++) {
      const r = await flushQueue(cur, async () => {
        throw PAIRING;
      });
      cur = applyFlush(cur, r);
    }
    expect(cur).toEqual([item("p")]);
  });

  test("items queued during a flush survive it", async () => {
    const snapshot = [item("1")];
    const r = await flushQueue(snapshot, async () => {});
    const current = [...snapshot, item("new")];
    expect(applyFlush(current, r).map((i) => i.id)).toEqual(["new"]);
  });
});

describe("Mutex", () => {
  test("serialises read-modify-write so concurrent updates are not lost", async () => {
    const m = new Mutex();
    let store: number[] = [];
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const append = (n: number) =>
      m.run(async () => {
        const cur = store;
        await tick();
        store = [...cur, n];
      });
    await Promise.all([append(1), append(2), append(3)]);
    expect(store).toEqual([1, 2, 3]);
  });

  test("a failing section does not block the next", async () => {
    const m = new Mutex();
    await expect(m.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await m.run(async () => 7)).toBe(7);
  });
});
