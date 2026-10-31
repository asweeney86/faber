import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_SVGS, icoFromPngs, svgFiles } from "./brand";
import { ICON_RIBBON_PATH, iconSvg, logoSvg, MARK_PATH, markSvg, ribbonPath } from "../packages/shared/src/brand";

const root = join(import.meta.dir, "..");
const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe("brand", () => {
  test("committed SVGs in brand/ match brand.ts (run `bun run brand` after changing the logo)", () => {
    for (const [name, svg] of Object.entries(svgFiles())) {
      expect(readFileSync(join(root, "brand", name), "utf8"), name).toBe(svg + "\n");
    }
  });

  test("the ribbon stays inside its box and is mirror-symmetric", () => {
    const d = ribbonPath(16, 12, 32, 40);
    expect(d).toBe(ICON_RIBBON_PATH);
    expect(d).not.toContain("NaN");
    // Endpoints of every command (plus Q control points), tracking the current point for H/V.
    const coords: (readonly [number, number])[] = [];
    let cur: readonly [number, number] = [0, 0];
    for (const cmd of d.split(/(?=[MLHVQZA])/)) {
      const v = numbers(cmd);
      if (cmd[0] === "H") cur = [v[0]!, cur[1]];
      else if (cmd[0] === "V") cur = [cur[0], v[0]!];
      else if (cmd[0] === "Q") (coords.push([v[0]!, v[1]!]), (cur = [v[2]!, v[3]!]));
      else if (cmd[0] === "A") cur = [v[5]!, v[6]!];
      else if (cmd[0] !== "Z") cur = [v[0]!, v[1]!];
      coords.push(cur);
    }
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(16);
      expect(x).toBeLessThanOrEqual(48);
      expect(y).toBeGreaterThanOrEqual(12);
      expect(y).toBeLessThanOrEqual(52);
    }
    // Every point has a mirror image across x = 32.
    const key = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;
    const set = new Set(coords.map(([x, y]) => key(x, y)));
    for (const [x, y] of coords) expect(set.has(key(64 - x, y)), `${x},${y}`).toBe(true);
  });

  test("every SVG is a single well-formed root with animation hooks", () => {
    const all = { ...svgFiles(), ...Object.fromEntries(Object.entries(ACTION_SVGS).map(([k, v]) => [`action-${k}`, v])) };
    for (const [name, svg] of Object.entries(all)) {
      expect(svg.startsWith("<svg "), name).toBe(true);
      expect(svg.endsWith("</svg>"), name).toBe(true);
      expect(svg.match(/<svg /g)!.length, name).toBe(1);
      expect(svg, name).toContain('class="faber-ribbon"');
      expect(svg, name).not.toContain("NaN");
    }
    expect(iconSvg()).toContain('class="faber-tile"');
    expect(logoSvg()).toContain('class="faber-wordmark"');
    expect(markSvg()).toContain(MARK_PATH);
  });

  test("icons and logos have an accessible name", () => {
    for (const svg of [iconSvg(), markSvg(), logoSvg()]) {
      expect(svg).toContain('role="img"');
      expect(svg).toContain("<title>Faber</title>");
    }
  });

  test("favicon.ico wraps PNGs with a valid directory", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const ico = icoFromPngs([
      { size: 16, png: a },
      { size: 32, png: b },
    ]);
    const v = new DataView(ico.buffer);
    expect([v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)]).toEqual([0, 1, 2]);
    expect([ico[6], ico[22]]).toEqual([16, 32]);
    expect(v.getUint32(6 + 8, true)).toBe(3);
    expect(v.getUint32(6 + 12, true)).toBe(38);
    expect(v.getUint32(22 + 12, true)).toBe(41);
    expect([...ico.slice(38)]).toEqual([1, 2, 3, 4, 5]);
    const real = new DataView(readFileSync(join(root, "brand/favicon.ico")).buffer);
    expect(real.getUint16(4, true)).toBe(3);
  });
});
