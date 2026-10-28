#!/bin/bash
# Heavy checks on boat.dev VMs, forked from the saved snapshot `clearcase-golden` (docs/sprint/research/boat-fleet.md,
# section 4). Owner only: it drives the signed-in `boat` CLI (boat new --from, boat exec, boat delete); no API key and no
# boat CI app. Colleagues check locally. The sandboxes are --no-env and --no-monitoring, hold synthetic data only, and are
# deleted on every exit.
#
#   scripts/boat/run-checks.sh [--sha REV] [--shards 4] [--snapshot clearcase-golden] [--type default]
#                              [--only test|check|build|e2e] [--out DIR]
#
# --only test runs the vitest shards, check runs `bun run --bun check`, build runs the build and build:hosted, e2e runs
# test:e2e; with none, the shards plus one sandbox for check and build. CLEARCASE_SPRINT=1 is set, as in CI-lite.
# Exit 0 every check passed, 1 a check failed, 2 infrastructure (boat signed out, snapshot missing, rate limited, no
# capacity, a sandbox that never became ready): never a silent 0.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

rev=HEAD shards=4 snapshot=clearcase-golden type=default only= out=
while [ $# -gt 0 ]; do
  case $1 in
    --sha) rev=$2; shift 2 ;;
    --shards) shards=$2; shift 2 ;;
    --snapshot) snapshot=$2; shift 2 ;;
    --type) type=$2; shift 2 ;;
    --only) only=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
case $only in ''|test|check|build|e2e) ;; *) echo "--only takes test, check, build or e2e" >&2; exit 2 ;; esac
[[ $shards =~ ^[1-9][0-9]*$ ]] || { echo "--shards takes a positive number" >&2; exit 2; }

boat_preflight
boat_has_snapshot "$snapshot" || infra "no saved snapshot named $snapshot; build it with scripts/boat/build-golden.sh"
sha=$(git rev-parse --verify "$rev^{commit}") || infra "cannot resolve $rev"
[ -n "$out" ] || out=.local/boat/$sha
mkdir -p "$out"

# One "name|command" per sandbox. The commands run in /home/user/clearcase.
jobs=()
if [ -z "$only" ] || [ "$only" = test ]; then
  for i in $(seq 1 "$shards"); do
    jobs+=("shard-$i|mkdir -p /home/user/out && bunx vitest run --shard=$i/$shards --reporter=junit --outputFile=/home/user/out/junit-$i.xml --maxWorkers=6")
  done
fi
case $only in
  '') jobs+=("check-build|bun run --bun check && bun run --bun build && bun run --bun build:hosted") ;;
  check) jobs+=("check|bun run --bun check") ;;
  build) jobs+=("build|bun run --bun build && bun run --bun build:hosted") ;;
  e2e) jobs+=("e2e|bun run --bun test:e2e") ;;
esac

ids=()
tmp=$(mktemp -d)
cleanup() {
  git update-ref -d refs/boat/pr 2>/dev/null || true
  rm -rf "$tmp"
  for id in "${ids[@]}"; do boat delete "$id" --yes --no-update >/dev/null 2>&1 || echo "run-checks: could not delete sandbox $id; delete it by hand" >&2; done
}
trap cleanup EXIT

created=$(boat new --from "$snapshot" --type "$type" --ttl 2400 --count "${#jobs[@]}" --no-env --no-monitoring --json --no-update | sandbox_ids) \
  || infra "boat new failed (rate limited, out of capacity or no balance?)"
mapfile -t ids <<<"$created"
[ -n "${ids[0]:-}" ] || infra "boat new printed no sandbox ids"
[ "${#ids[@]}" -eq "${#jobs[@]}" ] || infra "asked for ${#jobs[@]} sandboxes and got ${#ids[@]}"
printf '%s\n' "${ids[@]}" > "$out/sandboxes.txt"
for id in "${ids[@]}"; do boat_wait_ready "$id" || infra "sandbox $id did not become ready"; done

# What the golden snapshot holds, then the smallest bundle that carries $sha to it (full history if its base is unknown here).
golden=$(boat exec "${ids[0]}" --timeout 60 --no-update -- cat clearcase/.boat-golden.json 2>/dev/null || true)
golden_sha=$(python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("sha",""))' <<<"$golden" 2>/dev/null || true)
golden_lock=$(python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("bunLockSha256",""))' <<<"$golden" 2>/dev/null || true)
git update-ref refs/boat/pr "$sha"
if [ -n "$golden_sha" ] && git merge-base --is-ancestor "$golden_sha" "$sha" 2>/dev/null; then
  git bundle create "$tmp/pr.bundle" refs/boat/pr "^$golden_sha" >/dev/null 2>&1 || infra "git bundle failed"
else
  echo "run-checks: the golden snapshot's commit is unknown or not an ancestor of $sha; sending full history" >&2
  git bundle create "$tmp/pr.bundle" refs/boat/pr >/dev/null 2>&1 || infra "git bundle failed"
fi
lock=$(sha256sum bun.lock | cut -d' ' -f1)
[ "$lock" = "$golden_lock" ] || echo "run-checks: golden is stale (bun.lock differs); each sandbox runs bun install" >&2

for n in "${!jobs[@]}"; do
  id=${ids[$n]} name=${jobs[$n]%%|*} cmd=${jobs[$n]#*|}
  (
    rc=0
    if boat scp "$tmp/pr.bundle" "$id:/home/user/pr.bundle" --no-update > "$out/$name.log" 2>&1; then
      boat exec "$id" --timeout 0 --stream --cwd clearcase --no-update -- bash -lc "
        set -e
        git fetch -q /home/user/pr.bundle refs/boat/pr && git checkout -q --detach FETCH_HEAD
        [ \"\$(sha256sum bun.lock | cut -d' ' -f1)\" = '$golden_lock' ] || bun install --frozen-lockfile
        export CLEARCASE_SPRINT=1
        $cmd" >> "$out/$name.log" 2>&1 || rc=$?
    else
      rc=2
    fi
    echo "$rc" > "$out/$name.rc"
  ) &
done
wait

failed=0 infra_failed=0
: > "$out/results.txt"
for n in "${!jobs[@]}"; do
  id=${ids[$n]} name=${jobs[$n]%%|*}
  rc=$(cat "$out/$name.rc" 2>/dev/null || echo 2)
  boat scp "$id:/home/user/out" "$out/" --recursive --no-update >/dev/null 2>&1 || true
  cost=$(boat usage "$id" --json --no-update 2>/dev/null | tr -d '\n' || true)
  printf '%s rc=%s sandbox=%s usage=%s\n' "$name" "$rc" "$id" "${cost:-unknown}" >> "$out/results.txt"
  [ "$rc" -eq 0 ] || { failed=1; [ "$rc" -ne 2 ] || infra_failed=1; }
done
cat "$out/results.txt"
echo "sha $sha; logs and results in $out"
[ "$infra_failed" -eq 0 ] || exit 2
exit "$failed"
