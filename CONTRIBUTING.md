# Contributing

Thanks for helping. Faber is small on purpose: one daemon, one SQLite file, one extension.

## Setup

```bash
bun install
bun run typecheck && bun run test     # must pass before a PR
bun run test:e2e                      # Playwright; needs `bunx playwright install chromium` once
```

You don't need Ollama for tests: they use the offline `fake` providers. To try real models, run `ollama pull qwen3:8b` and `ollama pull qwen3-embedding`, then `bun faber demo` with a throwaway `FABER_HOME`.

## Guidelines

- **Privacy first.** Never send document text anywhere new without going through the provider factory in `packages/core/src/providers/index.ts`, which enforces `privacy.allow_remote`. Never add document-derived text to collection exports.
- **Validate at the boundary.** Anything from HTTP bodies or imported files goes through validators (`search/filters.ts`, `collections.ts`, `settings.ts`) before it reaches SQL or storage.
- **Keep the extension's logic pure.** Chrome APIs stay in thin adapters (`packages/extension/src/background.ts`); decisions live in `src/lib/*` with unit tests.
- **Schema changes** go in `packages/core/src/db.ts` as idempotent `addColumn` steps in `migrate()`, with a test that upgrades an old database.
- **Tests with every fix.** Bugs get a regression test; UI changes get a Playwright assertion.

## Changing the enrichment prompt

Bump `PROMPT_VERSION` in `packages/core/src/enrich/prompt.ts`. Each enrichment records provider, model and prompt version, so `faber requeue` can re-run old ones.

## Changing the logo

The logo's geometry and colors live in `packages/shared/src/brand.ts`. After changing them, run `bun run brand` to regenerate `brand/` (SVGs, PNGs, `favicon.ico`) and the extension icons, and commit the results; `scripts/brand.test.ts` fails if they're stale. See [brand/README.md](brand/README.md).
