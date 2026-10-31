/** Decorative project colors (theme tokens --c-<name>), cycling through the palette. */
const TINTS = ["mauve", "green", "blue", "yellow", "peach", "teal", "pink", "lavender"] as const;
export type Tint = (typeof TINTS)[number];

/** A project's color, from its id: the same project is the same color on every screen. */
export function projectTint(id: string): Tint {
  // FNV-1a plus a final mix, so similar ids still spread across the palette.
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return TINTS[(h >>> 0) % TINTS.length]!;
}
