import { BRAND, ICON_RIBBON_PATH, ICON_VIEWBOX, MARK_PATH, MARK_VIEWBOX, TILE_RADIUS, WORDMARK_PATH, WORDMARK_WIDTH } from "@faber/shared";

/*
 * The Faber logo, drawn from the shared brand geometry (packages/shared/src/brand.ts).
 * Class names match the generated SVGs (.faber-tile, .faber-ribbon, .faber-wordmark)
 * so the same CSS animations apply.
 */

/** The ribbon. Its color comes from --brand-ribbon, which deepens on light backgrounds. */
export function FaberMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox={MARK_VIEWBOX} width={(size * 32) / 40} height={size} className={className} aria-hidden="true">
      <path className="faber-ribbon" d={MARK_PATH} fill="var(--brand-ribbon)" />
    </svg>
  );
}

/** The app icon: white ribbon on the flat violet tile (same image as the favicon). */
export function FaberIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox={ICON_VIEWBOX} width={size} height={size} className={className} aria-hidden="true">
      <rect className="faber-tile" width="64" height="64" rx={TILE_RADIUS} fill={BRAND.tile} />
      <path className="faber-ribbon" d={ICON_RIBBON_PATH} fill={BRAND.white} />
    </svg>
  );
}

/** The outlined "Faber" letters, in the current text color. */
export function FaberWordmark({ height = 15, className }: { height?: number; className?: string }) {
  return (
    <svg viewBox={`0 -0.5 ${WORDMARK_WIDTH} 30`} width={(height * WORDMARK_WIDTH) / 30} height={height} className={className} aria-hidden="true">
      <path className="faber-wordmark" d={WORDMARK_PATH} fill="currentColor" />
    </svg>
  );
}
