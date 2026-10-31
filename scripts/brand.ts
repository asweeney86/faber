#!/usr/bin/env bun
/**
 * Generate every logo asset from packages/shared/src/brand.ts.
 *
 *   bun run brand                 write brand/*.svg, brand/png/*, brand/favicon.ico and the extension icons
 *   bun run brand --sheet out.png also render a contact sheet of everything, enlarged, on light and dark
 *
 * PNGs are rendered by Playwright's Chromium so they match what browsers draw from the SVGs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRAND, DROP_ANIMATION_CSS, ICON_VARIANTS, bannerSvg, iconSvg, logoSvg, markSvg, ribbonPath } from "../packages/shared/src/brand";

const root = join(import.meta.dir, "..");
const brandDir = join(root, "brand");
const extIcons = join(root, "packages/extension/static/icons");

/** Toolbar badge for "saved and pinned": an amber dot ringed in white so it separates from the tile. */
const PIN_BADGE = `<circle cx="50" cy="14" r="14" fill="#fff"/><circle cx="50" cy="14" r="9.2" fill="#F2A20C"/>`;
/** Mid-grey that keeps ≥3:1 against both Chrome's light (#f1f3f4) and dark (#35363a) toolbars. */
const GREY = "#8B8B98";

/**
 * Toolbar states for the current tab (see packages/extension/src/lib/tabstate.ts).
 * Flat tile at these sizes; every state keeps the same tile + ribbon silhouette.
 */
export const ACTION_SVGS = {
  saved: iconSvg(),
  pinned: iconSvg({ extra: PIN_BADGE }),
  /** Not saved: outlined tile and outlined ribbon in grey. */
  unsaved:
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect class="faber-tile" x="3" y="3" width="58" height="58" rx="12" fill="rgba(139,139,152,0.16)" stroke="${GREY}" stroke-width="6"/>` +
    `<path class="faber-ribbon" d="${ribbonPath(18.75, 14.75, 26.5, 34.5)}" fill="none" stroke="${GREY}" stroke-width="5.5" stroke-linejoin="round"/>` +
    `</svg>`,
  /** Unknown (offline, unpaired, no access): neutral grey tile, solid ribbon. */
  unknown: iconSvg({ tile: "#7D7D8A" }),
} as const;

/** Every SVG written to brand/, by path relative to it. */
export function svgFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "faber-mark.svg": markSvg(),
    "faber-mark-outline.svg": markSvg({ outline: true }),
    "faber-mark-ink.svg": markSvg({ color: BRAND.ink }),
    "faber-mark-white.svg": markSvg({ color: BRAND.white }),
    "faber-icon.svg": iconSvg(),
    "faber-icon-animated.svg": iconSvg({ style: DROP_ANIMATION_CSS }),
    "faber-logo.svg": logoSvg(),
    "faber-logo-on-light.svg": logoSvg({ text: BRAND.inkText }),
    "faber-logo-on-purple.svg": logoSvg({ ribbon: BRAND.white }),
    "faber-banner.svg": bannerSvg(),
  };
  for (const [name, v] of Object.entries(ICON_VARIANTS)) files[`variants/faber-icon-${name}.svg`] = iconSvg({ tile: v.tile, ribbon: v.ribbon });
  return files;
}

/** App-icon PNG sizes. */
const ICON_SIZES = [16, 32, 48, 64, 96, 128, 180, 192, 256, 512, 1024];
const iconFor = (_size: number) => iconSvg();

/** A .ico holding PNG images (supported by every browser since Windows Vista-era formats). */
export function icoFromPngs(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const header = 6 + 16 * images.length;
  const total = header + images.reduce((s, i) => s + i.png.length, 0);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);
  let offset = header;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    buf[e] = size >= 256 ? 0 : size;
    buf[e + 1] = size >= 256 ? 0 : size;
    view.setUint16(e + 4, 1, true); // planes
    view.setUint16(e + 6, 32, true); // bits per pixel
    view.setUint32(e + 8, png.length, true);
    view.setUint32(e + 12, offset, true);
    buf.set(png, offset);
    offset += png.length;
  });
  return buf;
}

const sized = (svg: string, w: number, h = w) => svg.replace("<svg ", `<svg width="${w}" height="${h}" `);

if (import.meta.main) {
  const write = (path: string, data: string | Uint8Array) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };
  for (const [name, svg] of Object.entries(svgFiles())) write(join(brandDir, name), svg + "\n");

  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const render = async (svg: string, size: number) => {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(`<html><body style="margin:0;background:transparent">${sized(svg, size)}</body></html>`);
      const png = new Uint8Array(await page.screenshot({ omitBackground: true }));
      await page.close();
      return png;
    };

    const icons = new Map<number, Uint8Array>();
    for (const size of ICON_SIZES) {
      const png = await render(iconFor(size), size);
      icons.set(size, png);
      write(join(brandDir, `png/faber-icon-${size}.png`), png);
    }
    write(join(brandDir, "favicon.ico"), icoFromPngs([16, 32, 48].map((size) => ({ size, png: icons.get(size)! }))));

    for (const size of [16, 32, 48, 128]) write(join(extIcons, `icon-${size}.png`), icons.get(size)!);
    for (const [state, svg] of Object.entries(ACTION_SVGS)) {
      for (const size of [16, 32]) write(join(extIcons, `action-${state}-${size}.png`), await render(svg, size));
    }

    const sheetAt = process.argv.indexOf("--sheet");
    if (sheetAt !== -1 && process.argv[sheetAt + 1]) {
      const png = (path: string) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;
      const svgs = svgFiles();
      const svgCell = (name: string, bg: string, h = 64) =>
        `<div style="background:${bg};padding:14px;border-radius:12px;display:flex;align-items:center;justify-content:center;min-height:${h + 10}px">${svgs[name]!.replace("<svg ", `<svg height="${h}" `)}</div>`;
      const toolbar = (bg: string, fg: string) =>
        `<div style="background:${bg};color:${fg};padding:12px 16px;border-radius:10px;display:flex;gap:24px;font:12px system-ui">` +
        Object.keys(ACTION_SVGS)
          .map(
            (s) =>
              `<div style="text-align:center"><div style="display:flex;gap:8px;align-items:flex-end">` +
              `<img src="${png(join(extIcons, `action-${s}-16.png`))}" width="16" height="16">` +
              `<img src="${png(join(extIcons, `action-${s}-32.png`))}" width="16" height="16">` +
              `<img src="${png(join(extIcons, `action-${s}-16.png`))}" width="64" height="64" style="image-rendering:pixelated">` +
              `<img src="${png(join(extIcons, `action-${s}-32.png`))}" width="64" height="64" style="image-rendering:pixelated">` +
              `</div>${s}</div>`,
          )
          .join("") +
        `</div>`;
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.setContent(`<html><body style="margin:0;padding:24px;background:#171724;color:#ddd;font:13px system-ui;display:grid;gap:18px">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">
          ${svgCell("faber-logo.svg", "#1c1c29", 48)}${svgCell("faber-logo-on-light.svg", "#f6f3f2", 48)}${svgCell("faber-logo-on-purple.svg", "#432971", 48)}
          <div style="display:flex;gap:14px">${svgCell("faber-mark.svg", "#1c1c29")}${svgCell("faber-mark-outline.svg", "#1c1c29")}${svgCell("faber-mark-ink.svg", "#f6f3f2")}</div>
        </div>
        <div style="display:flex;gap:18px;align-items:flex-end">
          ${[512, 192, 96, 48, 32, 16].map((s) => `<div style="text-align:center"><img src="${png(join(brandDir, `png/faber-icon-${s}.png`))}" width="${Math.min(s, 128)}" height="${Math.min(s, 128)}"><div>${s}</div></div>`).join("")}
          ${[16, 32].map((s) => `<div style="text-align:center"><img src="${png(join(brandDir, `png/faber-icon-${s}.png`))}" width="96" height="96" style="image-rendering:pixelated"><div>${s} ×${96 / s}</div></div>`).join("")}
        </div>
        <div style="display:flex;gap:14px">${Object.keys(ICON_VARIANTS).map((v) => `<div style="text-align:center">${svgs[`variants/faber-icon-${v}.svg`]!.replace("<svg ", '<svg width="72" height="72" ')}<div>${v}</div></div>`).join("")}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">${toolbar("#f1f3f4", "#202124")}${toolbar("#35363a", "#e8eaed")}</div>
      </body></html>`);
      write(process.argv[sheetAt + 1]!, new Uint8Array(await page.screenshot({ fullPage: true })));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`Wrote ${brandDir} and ${extIcons}`);
}
