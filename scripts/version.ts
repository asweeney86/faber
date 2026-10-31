#!/usr/bin/env bun
/**
 * Show or set Faber's version (every package.json and packages/daemon/src/version.ts).
 *
 *   bun scripts/version.ts          print it (fails if the files disagree)
 *   bun scripts/version.ts 0.2.0    set it everywhere
 */
import { join } from "node:path";
import { checkVersions, setVersion } from "./release-lib";

const root = join(import.meta.dir, "..");
const next = process.argv[2];
if (next) {
  setVersion(root, next.replace(/^v/, ""));
  console.log(`Version is now ${checkVersions(root)}`);
} else {
  console.log(checkVersions(root));
}
