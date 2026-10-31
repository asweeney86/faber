/**
 * After an upgrade, the daemon replaces the unpacked extension on disk (~/.faber/extension),
 * but Chrome keeps running the copy it loaded. Reloading makes Chrome read the new files.
 * Only unpacked installs reload, and only once per daemon version, so a copy that wasn't
 * updated (say, loaded from elsewhere) never loops.
 */
export interface UpdateCheck {
  /** chrome.management.getSelf().installType: "development" for unpacked. */
  installType: string;
  manifestVersion: string;
  daemonVersion: string | null;
  /** The daemon version we last reloaded for. */
  reloadedFor: string | null;
}

export function shouldReload(c: UpdateCheck): boolean {
  return c.installType === "development" && !!c.daemonVersion && c.daemonVersion !== c.manifestVersion && c.reloadedFor !== c.daemonVersion;
}
