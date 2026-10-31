/**
 * The Faber logo, defined once: geometry, colors and SVG builders.
 *
 * Everything that shows the logo is built from this file: the SVGs in brand/,
 * every PNG (favicons, extension and toolbar icons, written by
 * `bun run brand`) and the React marks in the web app and the extension.
 * Change the shape or a color here and regenerate; don't edit outputs by hand.
 *
 * Design: "C1 Minimal Ribbon", a flat bookmark ribbon with a notched tail. The
 * mark is mauve on dark backgrounds; the app icon is a white ribbon on a solid
 * violet tile. Flat colors only: no gradients (PRD §3).
 *
 * Animation hooks: every SVG uses the same structure, so it can be animated with
 * CSS without editing paths:
 *   .faber-tile     the rounded square (app icon only)
 *   .faber-ribbon   the ribbon; anchor transforms at its top edge
 *                   (transform-box: fill-box; transform-origin: 50% 0)
 *   .faber-wordmark the "Faber" letters (logos only)
 */

export const BRAND = {
  /** Ribbon on dark backgrounds, and the default accent of the mark. */
  mauve: "#D69CF1",
  /** App-icon tile (white ribbon on it: 4.9:1). */
  tile: "#7056EF",
  /** Deep ink: ribbon on the light tile, wordmark on light backgrounds. */
  ink: "#2B1D4C",
  /** Wordmark on light backgrounds. */
  inkText: "#1E1A2E",
  white: "#FFFFFF",
} as const;

/** Alternative tile colors from the design sheet (white ribbon, except "light"). */
export const ICON_VARIANTS = {
  mauve: { tile: "#CB96ED", ribbon: BRAND.white },
  blue: { tile: "#4FA2DB", ribbon: BRAND.white },
  green: { tile: "#5FC283", ribbon: BRAND.white },
  peach: { tile: "#EE918B", ribbon: BRAND.white },
  yellow: { tile: "#F9CF4F", ribbon: BRAND.white },
  light: { tile: "#F8F6F6", ribbon: BRAND.ink },
} as const;
export type IconVariant = keyof typeof ICON_VARIANTS;

const n = (v: number) => String(Math.round(v * 100) / 100);

/**
 * The ribbon outline in the box (x, y, w, h): rounded top corners, straight
 * sides, and a V notch a quarter of the height deep with softened tips.
 */
export function ribbonPath(x: number, y: number, w: number, h: number): string {
  const r = w * 0.14; // top corners
  const notch = h * 0.25; // depth of the V
  const tip = w * 0.11; // rounding of the two tail tips
  const apex = w * 0.07; // rounding of the V's inner point
  const ax = x + w / 2;
  const ay = y + h - notch;
  // Unit vector from the right tail tip to the apex (mirrored for the left).
  const len = Math.hypot(w / 2, notch);
  const ux = w / 2 / len;
  const uy = notch / len;
  const bottom = y + h;
  return [
    `M${n(x)} ${n(y + r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}`,
    `H${n(x + w - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}`,
    `V${n(bottom - tip)}`,
    `Q${n(x + w)} ${n(bottom)} ${n(x + w - ux * tip)} ${n(bottom - uy * tip)}`,
    `L${n(ax + ux * apex)} ${n(ay + uy * apex)}`,
    `Q${n(ax)} ${n(ay)} ${n(ax - ux * apex)} ${n(ay + uy * apex)}`,
    `L${n(x + ux * tip)} ${n(bottom - uy * tip)}`,
    `Q${n(x)} ${n(bottom)} ${n(x)} ${n(bottom - tip)}`,
    "Z",
  ].join("");
}

/** The standalone mark: a 32×40 ribbon. */
export const MARK_VIEWBOX = "0 0 32 40";
export const MARK_PATH = ribbonPath(0, 0, 32, 40);

/** The app icon: a 64×64 tile with the ribbon at (16, 12), sized to land on whole pixels at 16 and 32 px. */
export const ICON_VIEWBOX = "0 0 64 64";
export const TILE_RADIUS = 14;
export const ICON_RIBBON_PATH = ribbonPath(16, 12, 32, 40);

/**
 * "Faber" in Plus Jakarta Sans Bold (SIL Open Font License 1.1), outlined so the
 * logo needs no font. Cap height 29 (baseline at y = 29), tracking -0.02em,
 * starting at x = 0; about 103 wide.
 */
export const WORDMARK_WIDTH = 102.73;
export const WORDMARK_PATH = "M5.3 29L0 29L0 0L19.35 0L19.35 4.67L5.3 4.67L5.3 12.69L17.6 12.69L17.6 17.36L5.3 17.36L5.3 29ZM27.17 29.47L27.17 29.47Q24.95 29.47 23.32 28.73Q21.68 27.99 20.79 26.61Q19.89 25.22 19.89 23.39L19.89 23.39Q19.89 21.64 20.67 20.26Q21.45 18.88 23.09 17.94Q24.72 17.01 27.21 16.62L27.21 16.62L33.52 15.61L33.52 14.91Q33.52 13.55 32.45 12.63Q31.38 11.72 29.63 11.72L29.63 11.72Q27.99 11.72 26.73 12.59Q25.46 13.47 24.88 14.91L24.88 14.91L20.71 12.88Q21.33 11.21 22.68 9.98Q24.02 8.76 25.85 8.06Q27.68 7.36 29.82 7.36L29.82 7.36Q32.43 7.36 34.41 8.31Q36.4 9.26 37.51 10.96Q38.62 12.65 38.62 14.91L38.62 14.91L38.62 29L33.79 29L33.79 26.78Q33.4 27.21 32.93 27.56L32.93 27.56Q31.81 28.49 30.37 28.98Q28.92 29.47 27.17 29.47ZM33.52 20.36L33.52 19.5L28.19 20.4Q26.67 20.67 25.93 21.37Q25.19 22.07 25.19 23.2L25.19 23.2Q25.19 24.29 26.02 24.93Q26.86 25.57 28.11 25.57L28.11 25.57Q29.7 25.57 30.93 24.89Q32.16 24.21 32.84 23.01Q33.52 21.8 33.52 20.36L33.52 20.36ZM54.11 29.47L54.11 29.47Q51.81 29.47 49.91 28.53L49.91 28.53Q48.35 27.83 47.34 26.59L47.34 26.59L47.34 29L42.55 29L42.55 -0.47L47.65 -0.47L47.65 9.97Q48.54 8.95 49.83 8.29L49.83 8.29Q51.7 7.36 54.15 7.36L54.15 7.36Q57.15 7.36 59.56 8.84Q61.97 10.32 63.39 12.81Q64.81 15.3 64.81 18.41L64.81 18.41Q64.81 21.49 63.41 24.02Q62.01 26.55 59.6 28.01Q57.19 29.47 54.11 29.47ZM53.53 24.8L53.53 24.8Q55.28 24.8 56.64 23.98Q58 23.16 58.76 21.72Q59.52 20.28 59.52 18.41Q59.52 16.54 58.76 15.12Q58 13.7 56.64 12.87Q55.28 12.03 53.53 12.03L53.53 12.03Q51.85 12.03 50.51 12.85Q49.17 13.66 48.41 15.12Q47.65 16.58 47.65 18.41L47.65 18.41Q47.65 20.28 48.41 21.72Q49.17 23.16 50.51 23.98Q51.85 24.8 53.53 24.8ZM77.97 29.47L77.97 29.47Q74.7 29.47 72.25 27.99Q69.8 26.51 68.43 23.98Q67.07 21.45 67.07 18.37L67.07 18.37Q67.07 15.18 68.45 12.71Q69.84 10.24 72.23 8.8Q74.62 7.36 77.58 7.36L77.58 7.36Q80.07 7.36 81.96 8.17Q83.85 8.99 85.17 10.43Q86.5 11.87 87.2 13.72Q87.9 15.57 87.9 17.71L87.9 17.71Q87.9 18.26 87.84 18.84Q87.78 19.42 87.63 19.85L87.63 19.85L72.37 19.85Q72.48 20.94 72.91 21.84L72.91 21.84Q73.57 23.36 74.92 24.17Q76.26 24.99 78.01 24.99Q79.76 24.99 80.99 24.25Q82.21 23.51 82.92 22.27L82.92 22.27L87.04 24.29Q86.42 25.81 85.1 26.98Q83.77 28.14 81.96 28.81Q80.15 29.47 77.97 29.47ZM72.48 15.96L72.48 15.96L82.45 15.96Q82.41 15.22 82.18 14.6L82.18 14.6Q81.63 13.2 80.44 12.38Q79.26 11.56 77.58 11.56L77.58 11.56Q75.99 11.56 74.74 12.36Q73.5 13.16 72.87 14.68L72.87 14.68Q72.6 15.3 72.48 15.96ZM96.07 29L90.97 29L90.97 7.82L95.76 7.82L95.76 10.82Q96.46 9.23 97.71 8.52L97.71 8.52Q99.26 7.59 101.48 7.59L101.48 7.59L102.73 7.59L102.73 12.11L100.9 12.11Q98.72 12.11 97.4 13.45Q96.07 14.79 96.07 17.21L96.07 17.21L96.07 29Z";

/** Horizontal lockup: ribbon, a gap of 20, then the wordmark centered on the ribbon. */
export const LOGO_VIEWBOX = `0 0 ${n(32 + 20 + WORDMARK_WIDTH)} 40`;

export interface IconOptions {
  tile?: string;
  ribbon?: string;
  /** Extra markup appended inside the svg (e.g. a status badge). */
  extra?: string;
  /** A <style> block, for animated variants. */
  style?: string;
  title?: string;
}

const svgOpen = (viewBox: string, title?: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${title ? ` role="img" aria-label="${title}"` : ""}>` + (title ? `<title>${title}</title>` : "");

/** App icon / favicon: a flat tile + ribbon. */
export function iconSvg(opts: IconOptions = {}): string {
  return [
    svgOpen(ICON_VIEWBOX, opts.title ?? "Faber"),
    opts.style ? `<style>${opts.style}</style>` : "",
    `<rect class="faber-tile" width="64" height="64" rx="${TILE_RADIUS}" fill="${opts.tile ?? BRAND.tile}"/>`,
    `<path class="faber-ribbon" d="${ICON_RIBBON_PATH}" fill="${opts.ribbon ?? BRAND.white}"/>`,
    opts.extra ?? "",
    "</svg>",
  ].join("");
}

/** The ribbon alone. `outline` draws the lighter "C2" variant as a stroke. */
export function markSvg(opts: { color?: string; outline?: boolean; style?: string; title?: string } = {}): string {
  const color = opts.color ?? BRAND.mauve;
  const sw = 3.5;
  const shape = opts.outline
    ? `<path class="faber-ribbon" d="${ribbonPath(sw / 2, sw / 2, 32 - sw, 40 - sw)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>`
    : `<path class="faber-ribbon" d="${MARK_PATH}" fill="${color}"/>`;
  return [svgOpen(MARK_VIEWBOX, opts.title ?? "Faber"), opts.style ? `<style>${opts.style}</style>` : "", shape, "</svg>"].join("");
}

/** Mark + wordmark. Defaults suit dark backgrounds (mauve ribbon, white letters). */
export function logoSvg(opts: { ribbon?: string; text?: string; title?: string } = {}): string {
  return [
    svgOpen(LOGO_VIEWBOX, opts.title ?? "Faber"),
    `<path class="faber-ribbon" d="${MARK_PATH}" fill="${opts.ribbon ?? BRAND.mauve}"/>`,
    `<path class="faber-wordmark" transform="translate(52 5.5)" d="${WORDMARK_PATH}" fill="${opts.text ?? BRAND.white}"/>`,
    "</svg>",
  ].join("");
}

/**
 * The lockup on a violet tile: white ribbon and wordmark, readable on any background.
 * Used where the page color isn't known (e.g. the README on GitHub's light or dark theme).
 */
export function bannerSvg(opts: { title?: string } = {}): string {
  const padX = 24;
  const padY = 16;
  const w = 32 + 20 + WORDMARK_WIDTH + padX * 2;
  const h = 40 + padY * 2;
  return [
    svgOpen(`0 0 ${n(w)} ${h}`, opts.title ?? "Faber"),
    `<rect class="faber-tile" width="${n(w)}" height="${h}" rx="16" fill="${BRAND.tile}"/>`,
    `<g transform="translate(${padX} ${padY})">`,
    `<path class="faber-ribbon" d="${MARK_PATH}" fill="${BRAND.white}"/>`,
    `<path class="faber-wordmark" transform="translate(52 5.5)" d="${WORDMARK_PATH}" fill="${BRAND.white}"/>`,
    "</g></svg>",
  ].join("");
}

/** The ribbon drops into the tile, overshoots a little and settles; it loops, pausing in between. Respects reduced motion. */
export const DROP_ANIMATION_CSS =
  ".faber-ribbon{transform-box:fill-box;transform-origin:50% 0;animation:faber-drop 2.8s cubic-bezier(.3,1.4,.5,1) infinite}" +
  "@keyframes faber-drop{0%{transform:scaleY(0)}22%{transform:scaleY(1)}86%{transform:scaleY(1);opacity:1}100%{transform:scaleY(1);opacity:0}}" +
  "@media (prefers-reduced-motion:reduce){.faber-ribbon{animation:none}}";
