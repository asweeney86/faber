/**
 * The launcher's shortcut as Chrome actually has it. Chrome owns extension shortcuts (the
 * user changes them at chrome://extensions/shortcuts; no API can set them), so everywhere
 * the extension shows the shortcut asks Chrome rather than assuming the default.
 */
export const LAUNCHER_COMMAND = "open-launcher";

/** Chrome's text for a command's shortcut ("⇧⌘K", "Ctrl+Shift+K"); "" or missing = none set. */
export function shortcutText(command: { shortcut?: string } | undefined): string | null {
  const s = command?.shortcut?.trim();
  return s ? s : null;
}

/** null when the user removed the shortcut. */
export async function launcherShortcut(): Promise<string | null> {
  const all = await chrome.commands.getAll();
  return shortcutText(all.find((c) => c.name === LAUNCHER_COMMAND));
}

/** The report to send the daemon, or null if it already has this one. */
export function shortcutReport(label: string | null, daemonUrl: string, lastReported: string | null): { key: string; label: string } | null {
  const key = `${daemonUrl}|${label ?? ""}`;
  return key === lastReported ? null : { key, label: label ?? "" };
}
