#!/usr/bin/env bun
/**
 * Render the Homebrew formula from one or more SHA256SUMS files (the release workflow
 * builds macOS and Linux on different runners, then merges them here).
 *
 *   bun scripts/formula.ts --version 0.2.0 --sums a/SHA256SUMS --sums b/SHA256SUMS > faber.rb
 *   bun scripts/formula.ts ... --base-url file:///path/to/tarballs    (to test a local tap)
 */
import { readFileSync } from "node:fs";
import { renderFormula, TARGETS, type Target } from "./release-lib";

const argv = process.argv.slice(2);
const values = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));
const version = values("version")[0]?.replace(/^v/, "");
if (!version) throw new Error("--version is required");
const baseUrl = values("base-url")[0] ?? `https://github.com/asweeney86/faber/releases/download/v${version}`;

const shas: Partial<Record<Target, string>> = {};
for (const file of values("sums")) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([0-9a-f]{64})\s+faber-(.+)-([a-z]+-[a-z0-9]+)\.tar\.gz$/.exec(line.trim());
    if (!m) continue;
    if (m[2] !== version) throw new Error(`${file} lists ${m[2]}, expected ${version}`);
    if (!TARGETS.includes(m[3] as Target)) throw new Error(`${file}: unknown target ${m[3]}`);
    shas[m[3] as Target] = m[1]!;
  }
}
process.stdout.write(renderFormula({ version, baseUrl, shas }));
