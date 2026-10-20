#!/usr/bin/env bash
# Rerun the GRS-21 (CC-11) evidence that the gate does not produce, at the checked-out revision, then regenerate the
# matrix and the defect table from it. Run `bun run --bun gate` first on the same clean tree: the matrix reads the
# gate's parity scorecard and test:e2e summaries (.local/gate/).
#
#   scripts/verify/evidence.sh [step ...]     steps: acceptance layout layout-v5 metrics dispositions matrix (default: all)
#
# Browser steps run one at a time, each through the browser lock scripts/browser-lock.mjs resolves; without admission
# (see there) the script exits 2 before any step.
# Outputs go to .local/GRS-21/ (ignored); layout-v5 and metrics read the real v5 sample named by
# .local/v5-verification.json and keep everything they write there. Each step prints its own summary line; the script
# exits with the first non-zero step status it saw, after running every step.
set -uo pipefail
cd "$(dirname "$0")/../.."
lock=$(bun scripts/browser-lock.mjs) || exit 2
LOCK=()
[ -n "$lock" ] && LOCK=("$lock")
OUT=.local/GRS-21
mkdir -p "$OUT"
SHA=$(git rev-parse HEAD)
steps=("$@")
[ ${#steps[@]} -eq 0 ] && steps=(acceptance layout layout-v5 metrics dispositions matrix)
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then echo "evidence: the tree is not clean; commit first (evidence is per revision)" >&2; exit 2; fi
status=0
run() { local name=$1; shift; echo "== $name at ${SHA:0:12}"; "$@" > "$OUT/$name.log" 2>&1; local s=$?; tail -3 "$OUT/$name.log"; echo "== $name exit $s"; [ $s -ne 0 ] && [ $status -eq 0 ] && status=$s; return 0; }
for s in "${steps[@]}"; do
	case $s in
		acceptance) rm -rf "$OUT/acceptance-out"; run acceptance env CLEARCASE_E2E_OUT="$PWD/$OUT/acceptance-out" "${LOCK[@]}" unshare -rn env OUTER_UID="$(id -u)" OUTER_GID="$(id -g)" tests/e2e/pilot/offline.sh "$(command -v bun)" tests/e2e/acceptance/suite.mjs ;;
		layout) run layout "${LOCK[@]}" bun scripts/verify/layout.mjs --case synthetic --shots ;;
		layout-v5) run layout-v5 "${LOCK[@]}" bun scripts/verify/layout.mjs --case v5 --shots ;;
		metrics) run metrics "${LOCK[@]}" bun scripts/verify/metrics.mjs ;;
		dispositions) run dispositions bun scripts/verify/dispositions.mjs --md docs/acceptance/CC-11/defects-table.md --json "$OUT/dispositions.json" ;;
		matrix) run matrix bun scripts/verify/matrix.mjs --sha "$SHA" ;;
		*) echo "evidence: unknown step $s" >&2; exit 2 ;;
	esac
done
echo "evidence: exit $status at $SHA"
exit $status
