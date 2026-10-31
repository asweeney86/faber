# Faber — Chrome extension

Manifest V3 extension that records the pages you choose to watch, fetches Google Docs/Slides/Sheets text with your own Google session, and gives you a search popup. Everything goes to your local daemon (`bun faber serve`); nothing is sent anywhere else.

## Install (load unpacked)

```bash
bun packages/extension/build.ts      # → packages/extension/build/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `packages/extension/build`.
3. Approve the extension in the app (**Settings → Browser extensions**) or with `bun faber extensions approve <id>`. Until then the popup shows "Approve Faber in the app" and visits are queued.
4. In the extension's options, check the daemon address (default `http://127.0.0.1:7777`; only loopback addresses are accepted) and turn on what you want watched. **Nothing is captured until you turn a rule on.**

Rebuild after pulling changes, then press the reload icon on the extension card.

## What it does

| Feature | How |
|---|---|
| Passive capture | When you spend the dwell time (default 4s) on a watched page **as the active tab of the focused window**, the visit is sent to the daemon. Background tabs don't accrue time. Reloads within 10 minutes aren't counted twice. Dwell state lives in `chrome.storage.session`, so it survives the service worker being suspended. |
| Privacy | Never runs in incognito. Only asks for `activeTab`; the broad `tabs` permission is optional and off unless you turn on the toolbar-icon setting. A referrer is only reported when it is itself a watched page. |
| Google text | Docs, Slides and Sheets text is fetched from Google's export URLs with `credentials: "include"`, so it works with whatever you can already open. Sign-in pages and 403/404s are reported to the daemon as errors; network errors, timeouts (30s), 429s and 5xx are retried later instead, and a 429 pauses backfill for 15 minutes. Downloads stop at 500k characters. |
| Other sites | Custom rules (`wiki.example.com`, `*.atlassian.net`, `github.com/my-org`) save the page's visible text. Chrome asks for permission per site. |
| Backfill | Every minute, text is fetched for up to 5 imported docs (`faber import-chrome`) whose source is enabled in the watchlist, using the Google account each doc was last opened with. |
| Meetings | With the Calendar rule on, a doc opened from an open Calendar event (event dialog, or within 30s of opening a full event page) is linked to that meeting. |
| Offline queue | If the daemon is down or the extension isn't approved yet, captures are queued and sent later: at most 500 items and ~5 MB (page text capped at 50k characters per item; oldest text is dropped first). An item the daemon keeps failing on is dropped after 5 tries. |
| Toolbar icon | Shows whether the current tab is saved: filled when saved, amber dot when pinned, grey outline when not ("Not saved — click to save"), neutral grey when it can't tell (daemon offline, not approved, or no access). Hover for details. Uses `GET /api/docs/lookup`, which records nothing; answers are cached for 30s. By default it works on Google Docs/Calendar and watched sites; turn on **Show saved status on every site** in Options to grant the optional `tabs` permission (the address goes only to your local daemon and isn't stored). |
| Search | Toolbar popup (<kbd>⌘⇧K</kbd> / <kbd>Ctrl+Shift+K</kbd>) or type `faber` + space in the address bar. |
| This page | The popup shows the current doc's summary, tags, note and pin, or offers **Save this page**. |

## Layout

```
src/background.ts     service worker: chrome event wiring only
src/lib/              pure logic (capture decisions, export classification, queue, formatting) + tests
src/popup/, options/  React UIs
src/ui/components.tsx shared icons, chips, switch
static/               html, css, icons (generated from the shared logo: `bun run brand` at the repo root; add `--sheet out.png` for an enlarged preview, including the toolbar states on light and dark toolbars)
build.ts              Bun.build bundler + manifest
```

## Tests

```bash
bun test packages/extension                                  # unit tests
bunx playwright test --project=extension                     # e2e against a seeded daemon
```

The e2e suite builds with `FABER_TEST=1` (output in `build-test/`), which also grants `https://127.0.0.1/*` so loopback test pages can be watched without a permission prompt. Screenshots land in `e2e/.results/screenshots/extension/`.

## Auto-reload while developing

```bash
bun run dev:extension        # from the repo root
```

Builds into `build/` (same folder, so the extension id and its pairing are kept), then rebuilds on every save under `src/`, `static/` or `../shared/src` and tells Chrome to reload the extension. Load `build/` unpacked once; open popups and options pages close on reload. The dev build talks to `ws://127.0.0.1:7779` (`FABER_EXT_DEV_PORT` to change); normal builds compile that code out. Finish with `bun run build:extension`.
