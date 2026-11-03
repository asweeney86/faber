# Shortcuts for the bun scripts. Everything else: see package.json.

BUMP ?= patch

.PHONY: release release-dry-run

## Cut a release: make release [BUMP=patch|minor|major|x.y.z]
release:
	bun scripts/cut-release.ts $(BUMP)

## Show what a release would contain, without changing anything
release-dry-run:
	bun scripts/cut-release.ts $(BUMP) --dry-run
