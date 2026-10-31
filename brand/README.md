# Faber brand assets

The logo is a flat bookmark ribbon with a notched tail ("C1 Minimal Ribbon"). Every file here is generated from one source, [`packages/shared/src/brand.ts`](../packages/shared/src/brand.ts), which defines the geometry and colors. The same source draws the logo inside the web app and the extension.

```bash
bun run brand                      # regenerate everything below + the extension icons
bun run brand --sheet sheet.png    # also render a contact sheet of every asset
```

Don't edit the SVGs by hand. A unit test (`scripts/brand.test.ts`) fails when they drift from `brand.ts`.

## Files

| File | Use |
| --- | --- |
| `faber-icon.svg` | App icon / favicon: white ribbon on a solid violet tile |
| `faber-icon-animated.svg` | The ribbon drops into the tile, loops (pure CSS; static under `prefers-reduced-motion`) |
| `faber-mark.svg` | Ribbon alone, mauve, for dark backgrounds |
| `faber-mark-outline.svg` | Lighter outline ribbon |
| `faber-mark-ink.svg` · `faber-mark-white.svg` | Ribbon in deep ink (light backgrounds) or white (purple backgrounds) |
| `faber-logo.svg` | Ribbon + wordmark for dark backgrounds |
| `faber-logo-on-light.svg` · `faber-logo-on-purple.svg` | Lockups for light and purple backgrounds |
| `faber-banner.svg` | White lockup on the violet tile, for backgrounds you don't control (the README) |
| `variants/faber-icon-*.svg` | Mauve, blue, green, peach, yellow and light tiles |
| `png/faber-icon-{16,32,48,96,128,180,192,512}.png` | Raster icons (180 is the Apple touch icon) |
| `favicon.ico` | 16, 32 and 48 px, served by the daemon at `/favicon.ico` |

The extension's icons (`packages/extension/static/icons/`) come from the same run: the app icon at 16–128 px, plus the toolbar states (saved, pinned, unsaved, unknown) at 16 and 32 px.

## Colors

| Token | Hex | Where |
| --- | --- | --- |
| Mauve | `#D69CF1` | Ribbon on dark backgrounds |
| Violet | `#7056EF` | App-icon tile (flat; white ribbon on it is 4.9:1) |
| Ink | `#2B1D4C` | Ribbon on light tiles |
| Ink text | `#1E1A2E` | Wordmark on light backgrounds |

In the UI, `--brand-ribbon` is the mauve in dark mode and a deeper `#A86BD8` in light mode (≥ 3:1 on the sidebar). The UI colors come from the Catppuccin theme the user picks (`packages/shared/src/theme.ts`); every flavor × accent pair is checked for WCAG AA in `theme.test.ts`.

## Wordmark

"Faber" is set in [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) Bold (SIL Open Font License 1.1) with −0.02em tracking, then outlined into a path, so no font is needed to display it. Cap height is 29 on a 40-unit ribbon; the gap between them is 20.

## Animating

Every SVG shares one structure, so you can animate it with CSS without touching the paths:

- `.faber-tile`: the rounded square (icons only)
- `.faber-ribbon`: the ribbon. Set `transform-box: fill-box; transform-origin: 50% 0` so it grows from its top edge, like a ribbon hanging from the spine of a book.
- `.faber-wordmark`: the letters (logos only)

`DROP_ANIMATION_CSS` in `brand.ts` is the example used by `faber-icon-animated.svg`. In React, the web app's `FaberMark` and `FaberWordmark` (`packages/web/src/components/Brand.tsx`) render the same classes.
