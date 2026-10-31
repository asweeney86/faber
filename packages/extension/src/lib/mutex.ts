/**
 * Serialises async read-modify-write sections (chrome.storage has no
 * transactions). Each `run` starts after the previous one settles, success or not.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
