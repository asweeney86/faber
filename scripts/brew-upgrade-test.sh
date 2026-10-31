#!/usr/bin/env bash
# Upgrade a real Homebrew install from the previous published release to this build,
# with the real background service running, the way a user's machine would:
#
#   1. brew install the previous release (its published faber.rb, real download URLs)
#   2. faber demo + faber setup  (brew services, extension copy, Google sources)
#   3. brew upgrade to this build (a local formula pointing at dist/)
#   4. the running daemon must restart itself into the new version, keep every document,
#      and bring the installed extension copy along
#   5. roll back: the previous release's binary must still open the upgraded data
#
#   bash scripts/brew-upgrade-test.sh <previous faber.rb> <dist dir>
#
# CI only: it uses ~/.faber, port 7777 and brew services.
set -euo pipefail

old_formula="$(cd "$(dirname "${1:?usage: brew-upgrade-test.sh <previous faber.rb> <dist dir>}")" && pwd)/$(basename "$1")"
dist="$(cd "${2:?usage: brew-upgrade-test.sh <previous faber.rb> <dist dir>}" && pwd)"
root="$(cd "$(dirname "$0")/.." && pwd)"
new_version="$(bun "$root/scripts/version.ts")"
old_version="$(sed -n 's/^  version "\(.*\)"$/\1/p' "$old_formula")"
tap="faber-upgrade/test"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1

if [ "${CI:-}" != "true" ]; then
  echo "This test uses ~/.faber, port 7777 and brew services; it only runs on CI." >&2
  exit 1
fi
if [ "$old_version" = "$new_version" ]; then
  echo "Previous release is $old_version too: nothing to upgrade from."
  exit 0
fi
echo "Upgrade test: $old_version → $new_version"

cleanup() {
  faber uninstall --yes >/dev/null 2>&1 || true
  brew uninstall --force faber >/dev/null 2>&1 || true
  brew untap "$tap" >/dev/null 2>&1 || true
}
trap cleanup EXIT

status() { curl -fsS http://127.0.0.1:7777/api/status; }
field() { bun -e "const s = JSON.parse(await Bun.stdin.text()); console.log(s.$1)"; }
wait_for_version() {
  for _ in $(seq 1 120); do
    if [ "$(status 2>/dev/null | field version 2>/dev/null)" = "$1" ]; then return 0; fi
    sleep 1
  done
  echo "the daemon never reported version $1" >&2
  tail -50 "$(brew --prefix)/var/log/faber.log" >&2 || true
  return 1
}

brew tap-new --no-git "$tap" >/dev/null
formula_dir="$(brew --repository "$tap")/Formula"

echo "==> brew install faber $old_version (published release)"
cp "$old_formula" "$formula_dir/faber.rb"
brew install "$tap/faber"
mkdir -p "$HOME/.faber"
printf '[embed]\nprovider = "fake"\nmodel = "fake-embed"\n[enrich]\nprovider = "fake"\nmodel = "fake-enrich"\n' > "$HOME/.faber/config.toml"
faber demo >/dev/null
faber setup --yes --no-launcher --no-open
wait_for_version "$old_version"
before="$(status)"
docs_before="$(field docs <<<"$before")"
enriched_before="$(field enriched <<<"$before")"
echo "running $old_version with $docs_before docs ($enriched_before enriched)"

echo "==> brew upgrade faber → $new_version"
bun "$root/scripts/formula.ts" --version "$new_version" --sums "$dist/SHA256SUMS" --base-url "file://$dist" > "$formula_dir/faber.rb"
brew upgrade "$tap/faber"
echo "==> the service restarts itself into $new_version"
wait_for_version "$new_version"
after="$(status)"
test "$(field docs <<<"$after")" = "$docs_before"
test "$(field enriched <<<"$after")" = "$enriched_before"
grep -q "\"version\": \"$new_version\"" "$HOME/.faber/extension/manifest.json"
brew services info faber --json | grep -Eq '"running":[[:space:]]*true'
faber search gateway --json | grep -q '"hits"'
doctor_out="$(faber doctor || true)"
echo "$doctor_out"
grep -q "Daemon running at http://127.0.0.1:7777" <<<"$doctor_out"
grep -q "Background service installed (brew)" <<<"$doctor_out"

echo "==> roll back: $old_version still opens the upgraded data"
old_url="$(sed -n '/on_arm do/,/end/s/^ *url "\(.*\)"$/\1/p' "$old_formula" | head -1)"
work="$(mktemp -d)"
curl -fsSL "$old_url" -o "$work/old.tar.gz"
tar -xzf "$work/old.tar.gz" -C "$work"
old_bin="$(echo "$work"/faber-*/bin/faber)"
"$old_bin" status | tee "$work/status.txt"
grep -q "docs      $docs_before " "$work/status.txt"
echo "OK: $old_version → $new_version kept $docs_before docs, restarted itself, and rolls back"
