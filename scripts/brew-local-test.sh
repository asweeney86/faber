#!/usr/bin/env bash
# Install a freshly built release with Homebrew, from a throwaway local tap, the way a
# user would: brew install, brew test, then (on CI only) faber setup with the real
# background service, faber doctor, and a clean uninstall.
#
#   bash scripts/brew-local-test.sh dist/release
#
# Locally it stops after `brew test`, so it never touches your ~/.faber or port 7777.
set -euo pipefail

dist="$(cd "${1:?usage: brew-local-test.sh <dist dir>}" && pwd)"
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(bun "$root/scripts/version.ts")"
tap="faber-local/test"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1

cleanup() {
  brew services stop faber >/dev/null 2>&1 || true
  brew uninstall --force faber >/dev/null 2>&1 || true
  brew untap "$tap" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if brew list --formula faber >/dev/null 2>&1; then
  echo "faber is already installed with Homebrew here; not touching it." >&2
  exit 1
fi

brew tap-new --no-git "$tap" >/dev/null
formula_dir="$(brew --repository "$tap")/Formula"
bun "$root/scripts/formula.ts" --version "$version" --sums "$dist/SHA256SUMS" --base-url "file://$dist" > "$formula_dir/faber.rb"

echo "==> brew install $tap/faber"
brew install "$tap/faber"
echo "==> brew test faber"
brew test faber
test "$(faber version)" = "$version"
test -f "$(brew --prefix)/opt/faber/share/faber/extension/manifest.json"

if [ "${CI:-}" != "true" ]; then
  echo "OK (installed and tested; run on CI to also check setup with the background service)"
  exit 0
fi

echo "==> faber setup (fresh machine, offline AI)"
mkdir -p "$HOME/.faber"
printf '[embed]\nprovider = "fake"\nmodel = "fake-embed"\n[enrich]\nprovider = "fake"\nmodel = "fake-enrich"\n' > "$HOME/.faber/config.toml"
faber setup --yes --no-launcher --no-open
echo "==> the service answers"
status_json="$(curl -fsS http://127.0.0.1:7777/api/status)"
grep -q "\"version\":\"$version\"" <<<"$status_json"
services="$(brew services list)"
echo "$services"
grep -Eq '^faber[[:space:]]+started' <<<"$services"
echo "==> faber doctor"
doctor_out="$(faber doctor || true)"
echo "$doctor_out"
grep -q "Daemon running at http://127.0.0.1:7777" <<<"$doctor_out"
echo "==> the service restarts the daemon if it dies"
pkill -9 -f "opt/faber/bin/faber serve"
for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:7777/api/status >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS http://127.0.0.1:7777/api/status >/dev/null
echo "==> faber uninstall"
faber uninstall --yes
sleep 1
if curl -fsS http://127.0.0.1:7777/api/status >/dev/null 2>&1; then echo "the daemon is still running after uninstall" >&2; exit 1; fi
echo "OK"
