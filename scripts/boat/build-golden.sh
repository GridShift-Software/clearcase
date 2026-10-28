#!/bin/bash
# Builds the saved snapshot `clearcase-golden` (docs/sprint/research/boat-fleet.md, section 2): Bun 1.4.2, the repository at
# REV with its dependencies installed, a warm build, and .boat-golden.json recording what it holds. Owner only: it needs
# the signed-in `boat` CLI on a paid plan (a trial cannot save snapshots) and costs about 15 minutes of one `default`
# sandbox. No case material and no secrets: the sandbox has none of your account's logins (--no-env), the checkout
# arrives as a git bundle, and the fixtures are the synthetic ones.
#
#   scripts/boat/build-golden.sh [--rev REV] [--name clearcase-golden] [--type default]
#
# Exit 0 saved, 1 a build step failed, 2 infrastructure (boat signed out, rate limited).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

rev=origin/sprint/hosted-demo-20261105 name=clearcase-golden type=default
while [ $# -gt 0 ]; do
  case $1 in
    --rev) rev=$2; shift 2 ;;
    --name) name=$2; shift 2 ;;
    --type) type=$2; shift 2 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

boat_preflight
sha=$(git rev-parse --verify "$rev^{commit}") || infra "cannot resolve $rev"
tmp=$(mktemp -d)
id=
cleanup() {
  git update-ref -d refs/boat/golden 2>/dev/null || true
  rm -rf "$tmp"
  [ -z "$id" ] || boat delete "$id" --yes --no-update >/dev/null 2>&1 || true
}
trap cleanup EXIT

git update-ref refs/boat/golden "$sha"
git bundle create "$tmp/golden.bundle" refs/boat/golden >/dev/null 2>&1 || infra "git bundle failed"

id=$(boat new --type "$type" --ttl 3600 --no-env --json --no-update | sandbox_ids | head -n1)
[ -n "$id" ] || infra "boat new printed no sandbox id"
echo "sandbox $id"
boat_wait_ready "$id" || infra "sandbox $id did not become ready"
run() { boat exec "$id" --timeout 0 --stream --no-update -- bash -lc "$1"; }

boat scp "$tmp/golden.bundle" "$id:/home/user/golden.bundle" --no-update
# ~/.profile, not ~/.bashrc: bash -lc reads the first and Ubuntu's .bashrc returns early when not interactive.
run '
  set -euo pipefail
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
  {
    echo "export BUN_INSTALL=\$HOME/.bun"
    echo "export PATH=\$BUN_INSTALL/bin:\$PATH"
    echo "export CLEARCASE_CHROMIUM=/usr/bin/google-chrome-stable"
  } >> ~/.profile
  git init -q clearcase && cd clearcase
  git fetch -q /home/user/golden.bundle refs/boat/golden && git checkout -q --detach FETCH_HEAD
' || { echo "golden: could not install Bun or unpack the checkout" >&2; exit 1; }
run '
  set -euo pipefail
  cd clearcase
  bun install --frozen-lockfile
  bunx svelte-kit sync
  bun run --bun build
  bun run --bun build:hosted
  bunx vitest run tests/hosted-smoke/native-viewer --maxWorkers=2 || echo "warm-up run failed; the snapshot is still usable"
  printf "{\"sha\":\"%s\",\"bunLockSha256\":\"%s\",\"bun\":\"%s\",\"chrome\":\"%s\",\"builtAt\":\"%s\"}\n" \
    "$(git rev-parse HEAD)" "$(sha256sum bun.lock | cut -d" " -f1)" "$(bun --version)" \
    "$(google-chrome-stable --version | tr -d "\n")" "$(date -u +%FT%TZ)" > .boat-golden.json
  cat .boat-golden.json
' || { echo "golden: a build step failed" >&2; exit 1; }

# Stop first: a snapshot of a running sandbox can miss the last minute of writes.
boat stop "$id" --no-update >/dev/null
for _ in $(seq 1 30); do boat info "$id" --json --no-update | grep -qi '"stopped"' && break; sleep 5; done
boat snapshot "$id" "$name" --no-update
dated="$name-$(date -u +%Y%m%d)"
boat snapshot "$id" "$dated" --no-update || echo "golden: could not save the dated copy $dated (a saved name each counts against the plan's ten)" >&2
echo "saved snapshot $name at $sha"
