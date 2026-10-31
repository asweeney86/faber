/**
 * Notice when the faber binary on disk is replaced (brew upgrade, a new release
 * unpacked over the old one) while the daemon keeps running the old one.
 *
 * As a background service the daemon then exits with UPGRADE_EXIT_CODE and the service
 * manager starts the new version, which brings the extension and launcher along at
 * startup. Run by hand, it just says so.
 */
import { realpathSync, statSync } from "node:fs";

/** Identity of whatever `path` currently resolves to; null when it's gone. */
export function binaryIdentity(path: string): string | null {
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    return `${real}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

export type UpgradeEvent = { kind: "replaced" } | { kind: "removed" };

/**
 * Poll `path`; call `onChange` once when it starts resolving to a different file, or
 * has been gone for `missingChecks` polls in a row (an upgrade briefly unlinks it).
 */
export function watchForUpgrade(path: string, onChange: (e: UpgradeEvent) => void, intervalMs = 30_000, missingChecks = 4): () => void {
  const start = binaryIdentity(path);
  if (start === null) return () => {};
  let fired = false;
  let missing = 0;
  const timer = setInterval(() => {
    if (fired) return;
    const now = binaryIdentity(path);
    if (now === start) {
      missing = 0;
      return;
    }
    if (now === null && ++missing < missingChecks) return;
    fired = true;
    clearInterval(timer);
    onChange(now === null ? { kind: "removed" } : { kind: "replaced" });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
