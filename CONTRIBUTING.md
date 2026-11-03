# Contributing

Thanks for helping. Faber is small on purpose: one daemon, one SQLite file, one extension.

## Setup

```bash
bun install
bun run typecheck && bun run test     # must pass before a PR
bun run test:e2e                      # Playwright; needs `bunx playwright install chromium` once
```

You don't need Ollama for tests: they use the offline `fake` providers. To try real models, run `ollama pull qwen3:4b` and `ollama pull qwen3-embedding:0.6b`, then `bun faber demo` with a throwaway `FABER_HOME`.

## Guidelines

- **Privacy first.** Never send document text anywhere new without going through the provider factory in `packages/core/src/providers/index.ts`, which enforces `privacy.allow_remote`. Never add document-derived text to collection exports.
- **Validate at the boundary.** Anything from HTTP bodies or imported files goes through validators (`search/filters.ts`, `collections.ts`, `settings.ts`) before it reaches SQL or storage.
- **Keep the extension's logic pure.** Chrome APIs stay in thin adapters (`packages/extension/src/background.ts`); decisions live in `src/lib/*` with unit tests.
- **Schema changes** go in `packages/core/src/db.ts` as idempotent steps in `migrate()`. Follow the upgrade rules below.
- **Tests with every fix.** Bugs get a regression test; UI changes get a Playwright assertion.

## Changing the enrichment prompt

Bump `PROMPT_VERSION` in `packages/core/src/enrich/prompt.ts`. Each enrichment records provider, model and prompt version, so `faber requeue` can re-run old ones.

## Changing the logo

The logo's geometry and colors live in `packages/shared/src/brand.ts`. After changing them, run `bun run brand` to regenerate `brand/` (SVGs, PNGs, `favicon.ico`) and the extension icons, and commit the results; `scripts/brand.test.ts` fails if they're stale. See [brand/README.md](brand/README.md).

## Upgrades must never break anyone

People upgrade with `brew upgrade faber`, and nobody reads release notes first. So:

- **Migrations are additive.** Add tables, or add columns that are nullable or have a default. Never rename or drop anything, and never change what a value means. That way a database upgraded by a new version still opens in the previous one, so rolling back to an older release works. If a change truly can't be additive, raise `MIN_READER_VERSION` to the new `SCHEMA_VERSION`. Older versions then refuse the database with a message pointing at the backup, instead of misreading it.
- **Bump `SCHEMA_VERSION` with every migration.** Before migrating, `openDatabase` writes a copy to `~/.faber/backups/` and keeps the last five. The migration then runs in a single transaction.
- **Every release snapshots its database.** `bun scripts/fixture.ts` writes `packages/core/test/fixtures/v<version>.sqlite.gz`, and `packages/core/test/upgrade.test.ts` opens every snapshot with the current code. Commit the fixture with the release; the release workflow refuses to build without it.
- **Config stays compatible.** New settings need defaults in `DEFAULT_CONFIG_TOML`. Unknown keys are ignored, so an old config file always loads.
- **The API stays compatible.** After an upgrade, the extension can run the previous version for a few minutes before it reloads itself (`src/lib/selfupdate.ts`). Add fields and endpoints; don't remove or rename them.
- **Installed copies live at stable paths.** These are `~/.faber/extension` (its folder decides the extension's id, and so its approval) and `~/Applications/Faber Launcher.app`. Services start from `<brew prefix>/opt/faber/bin/faber`, never from a versioned `Cellar` path.

## Releasing

```bash
npm run release
```

It checks that you're on a clean, up-to-date `main` whose CI passed, shows the changes since the
last release, and suggests the next minor version (pick patch, major, or type one instead). Nothing
changes until you confirm. Then it:

1. Sets the version everywhere (`scripts/version.ts`).
2. Snapshots this version's database for future upgrade tests (`scripts/fixture.ts`).
3. Runs the type check and the tests. If anything fails, the bump is undone.
4. Commits `Release x.y.z` with the merged PR titles since the last release as notes.
5. Tags `vx.y.z`, pushes, and follows the release workflow until it's published.

`.github/workflows/release.yml` then does the rest:

1. Runs the tests.
2. Builds single-binary tarballs for macOS (arm64 and x64, with the universal launcher app) and Linux (x64 and arm64).
3. Smoke-tests a tarball, then upgrades from the previous release and rolls back (`scripts/smoke.ts --upgrade-from`).
4. Installs with Homebrew on a clean runner, runs `faber setup` with the real background service, then uninstalls (`scripts/brew-local-test.sh`).
5. Publishes the GitHub release with `SHA256SUMS` and `faber.rb`.
6. Updates the tap, [asweeney86/homebrew-faber](https://github.com/asweeney86/homebrew-faber). Its source lives in `packaging/homebrew-tap/`.

To try a release locally:

```bash
bun scripts/release.ts --targets darwin-arm64           # → dist/release/
bun scripts/smoke.ts dist/release/faber-*-darwin-arm64.tar.gz
bash scripts/brew-local-test.sh dist/release            # brew install from a throwaway local tap
```

### What still needs an account

Two install steps can only be removed by the project owner's developer accounts:

- **Chrome Web Store (removes Developer mode and Load unpacked).** Run `bun scripts/store-package.ts`. It writes `dist/store/` with the extension zip, the 1280×800 screenshots, the icon, and `listing.md` (description, single purpose, permission justifications and privacy answers, ready to paste). Upload it at the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) (one-time $5 registration). Once it's published, add its store id to `daemon.allowed_extension_ids` in `DEFAULT_CONFIG_TOML` (`packages/core/src/config.ts`), so the store copy is trusted without pairing. Then have `faber setup` open the store page instead of `chrome://extensions`.
- **Apple notarization (only matters for tarballs downloaded with a browser).** Homebrew installs aren't quarantined, so they run as they are. To notarize, you need an Apple Developer ID ($99/year). Store the certificate and an app-specific password as repository secrets. In `release.yml`, sign `bin/faber` and `Faber Launcher.app` with `codesign --options runtime --sign "Developer ID Application: …"`, then submit with `xcrun notarytool submit --wait` before packing the tarballs.

The tap updates as soon as a release is published, using the `TAP_DEPLOY_KEY` secret. That's a write deploy key for `asweeney86/homebrew-faber` only. If it's ever removed, the tap's hourly workflow still picks up new releases.
