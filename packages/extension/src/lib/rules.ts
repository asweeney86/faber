import { normalisePattern, parsePattern, type WatchRule } from "@faber/shared";

export type PatternCheck = { ok: true; pattern: string; host: string } | { ok: false; error: string };

/**
 * Validate a site pattern typed into Options, normalised the same way the
 * daemon does so duplicates ("Wiki.Example.com/", "https://wiki.example.com")
 * are caught before the round trip.
 */
export function validateNewPattern(input: string, rules: readonly WatchRule[]): PatternCheck {
  const pattern = normalisePattern(input);
  const pp = pattern ? parsePattern(pattern) : null;
  if (!pattern || !pp) {
    return { ok: false, error: "Use a site with an optional path, e.g. wiki.example.com or github.com/my-org (not a whole domain like .com)" };
  }
  const dupe = rules.find((r) => normalisePattern(r.pattern) === pattern);
  if (dupe) return { ok: false, error: `You already watch that (“${dupe.label}”)` };
  return { ok: true, pattern, host: pp.host };
}
