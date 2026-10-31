#!/usr/bin/env bun
/**
 * Extension dev mode: build into build/, rebuild on every save, and tell the
 * loaded extension to reload itself.
 *
 *   bun run dev:extension        (from the repo root)
 *
 * Load packages/extension/build once via chrome://extensions → Load unpacked;
 * after that, saving a file under src/, static/ or ../shared/src reloads it.
 * Same folder as the normal build, so the extension id (and its pairing) is kept.
 */
import { watch } from "node:fs";
import { join } from "node:path";
import { buildExtension } from "./build";

const here = import.meta.dir;
const port = Number(process.env.FABER_EXT_DEV_PORT ?? 7779);
const out = process.env.FABER_EXT_OUT ?? join(here, "build");

let buildId = "";
const clients = new Set<import("bun").ServerWebSocket<unknown>>();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response("Faber extension dev server", { status: 200 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      // A reconnecting extension that slept through a rebuild learns it is stale here.
      ws.send(JSON.stringify({ build_id: buildId }));
    },
    message() {
      /* keep-alive pings */
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

async function rebuild(reason: string) {
  const id = Date.now().toString(36);
  const started = performance.now();
  const ok = await buildExtension({ test: false, out, devReloadPort: port, buildId: id });
  if (!ok) {
    console.error(`✗ build failed (${reason}); keeping the previous build loaded`);
    return;
  }
  buildId = id;
  for (const ws of clients) ws.send(JSON.stringify({ build_id: buildId }));
  const n = clients.size;
  console.log(
    `✓ built in ${Math.round(performance.now() - started)}ms (${reason}) → ${n ? `reloading ${n} extension${n > 1 ? "s" : ""}` : "no extension connected yet"}`,
  );
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pending = new Set<string>();
const schedule = (file: string) => {
  pending.add(file);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const files = [...pending];
    pending = new Set();
    void rebuild(files.length === 1 ? files[0]! : `${files.length} files`);
  }, 150);
};

for (const dir of [join(here, "src"), join(here, "static"), join(here, "..", "shared", "src"), join(here, "..", "ui", "src")]) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (file && !file.endsWith(".test.ts")) schedule(file);
  });
}

await rebuild("start");
console.log(`Watching for changes. Dev reload server on ws://127.0.0.1:${server.port}`);
console.log(`Load ${out} once in chrome://extensions (Load unpacked); it reloads itself from now on.`);
