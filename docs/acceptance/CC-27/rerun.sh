#!/usr/bin/env bash
# Rerun CC-27 verification items 1-6 from clean non-interactive shells.
# Usage: CC27_READBACK=PATH CC27_PSTACK_CHECKOUT=DIR [CC27_EXPORT=PATH] [CC27_OUT=DIR] bash docs/acceptance/CC-27/rerun.sh
# CC27_PSTACK_CHECKOUT is a clean checkout of the pinned backnotprop/pstack revision (see README.md).
# Writes receipts/, transcripts/, summary.tsv and identity-audit.txt under CC27_OUT (default .local/cc27-rerun).
# Exits 1 if any step's exit code differs from the expected one or a receipt fails the identity audit,
# 3 (INCOMPLETE) if CC27_READBACK or CC27_PSTACK_CHECKOUT is unset because their comparisons were then
# SKIPPED, otherwise 0.
set -u

WT=$(cd "${BASH_SOURCE[0]%/*}/../../.." && pwd)
OUT=$(mkdir -p "${CC27_OUT:-$WT/.local/cc27-rerun}" && cd "${CC27_OUT:-$WT/.local/cc27-rerun}" && pwd)
READBACK=${CC27_READBACK:-}
EXPORT=${CC27_EXPORT:-}
CHECKOUT=${CC27_PSTACK_CHECKOUT:-}
[[ -d $CHECKOUT ]] && CHECKOUT=$(cd "$CHECKOUT" && pwd)
CLEAN_PATH=/usr/local/bin:/usr/bin:/bin
mkdir -p "$OUT/receipts" "$OUT/transcripts"
printf 'step\texpected\tactual\tverdict\tcommand\n' >"$OUT/summary.tsv"
{ git -C "$WT" rev-parse HEAD; git -C "$WT" status --porcelain; } >"$OUT/revision.txt"
mismatches=0

# step NAME EXPECTED DIR COMMAND : run COMMAND in a clean shell inside DIR
step() {
	local name=$1 expected=$2 dir=$3 command=$4
	env -i HOME="$HOME" PATH="$CLEAN_PATH" CLEARCASE_RECEIPTS_DIR="$OUT/receipts/$name" \
		bash --noprofile --norc -c "cd '$dir' && $command" >"$OUT/transcripts/$name.txt" 2>&1
	local actual=$? verdict=MATCH
	[[ $actual == "$expected" ]] || { verdict=MISMATCH; mismatches=$((mismatches + 1)); }
	printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$expected" "$actual" "$verdict" "$command" >>"$OUT/summary.tsv"
	printf '%-8s %-34s expected %s, got %s\n' "$verdict" "$name" "$expected" "$actual"
}

nonode=$(mktemp -d "${TMPDIR:-/tmp}/cc27-nonode.XXXXXX")
ln -s /usr/bin/python3 "$nonode/python3"
ln -s /usr/bin/git "$nonode/git"
nogit=$(mktemp -d "${TMPDIR:-/tmp}/cc27-nogit.XXXXXX")
ln -s /usr/bin/python3 "$nogit/python3"
ln -s /usr/bin/node "$nogit/node"
readback_args=${READBACK:+--linear-relations "'$READBACK'"}
readback_expect=$([[ -n $READBACK ]] && echo 0 || echo 3)
checkout_args=${CHECKOUT:+--checkout "'$CHECKOUT'"}
checkout_expect=$([[ -n $CHECKOUT ]] && echo 0 || echo 3)

echo "# 1. bootstrap twice, doctor, pstack pin against upstream (exit 3 = SKIPPED without CC27_PSTACK_CHECKOUT), removal"
step v1-bootstrap-first 0 "$WT" "scripts/agent-tools/receipt --name bootstrap-first -- scripts/agent-tools/bootstrap"
step v1-bootstrap-repeat 0 "$WT" "scripts/agent-tools/receipt --name bootstrap-repeat -- scripts/agent-tools/bootstrap"
step v1-doctor 0 "$WT" "scripts/agent-tools/doctor"
step v1-pstack-upstream "$checkout_expect" "$WT" "scripts/agent-tools/verify pstack-upstream $checkout_args"
step v1-bootstrap-remove 0 "$WT" "scripts/agent-tools/receipt --name bootstrap-remove -- scripts/agent-tools/bootstrap --remove"

echo "# 2. planning checker and pstack check-plan.mjs"
step v2-check-plan 0 "$WT" "scripts/agent-tools/check-plan"

echo "# 3. Linear readback comparison (exit 3 = SKIPPED when CC27_READBACK is unset)"
step v3-linear-relations "$readback_expect" "$WT" "scripts/agent-tools/check-plan --require-linear-relations $readback_args"
if [[ -n $EXPORT ]]; then
	# Informational: lists description drift between generated briefs and live Linear text. Drift exits 1.
	step v3-description-drift "${CC27_EXPORT_EXPECT:-1}" "$WT" \
		"scripts/agent-tools/receipt --name description-drift -- python3 scripts/planning/generate.py --compare-linear '$EXPORT'"
fi

echo "# 4. valid and invalid plan fixtures"
step v4-fixture-tests 0 "$WT" "scripts/agent-tools/receipt --name fixture-tests -- bash tests/agent-tools/run.sh"

echo "# 5. verification capability on synthetic fixtures"
step v5-plan-format-valid 0 "$WT" "scripts/agent-tools/verify plan-format --plan tests/agent-tools/fixtures/plans/valid.md"
step v5-plan-format-invalid 1 "$WT" "scripts/agent-tools/verify plan-format --plan tests/agent-tools/fixtures/plans/invalid.md"
step v5-app-deferred 3 "$WT" "scripts/agent-tools/verify app"
step v5-pstack-upstream-no-checkout 3 "$WT" "scripts/agent-tools/verify pstack-upstream"

echo "# 6. fresh worktree, missing dependency, skipped check"
fresh=$(mktemp -d "${TMPDIR:-/tmp}/cc27-fresh-wt.XXXXXX")
rmdir "$fresh"
git -C "$WT" worktree add --detach "$fresh" HEAD >"$OUT/transcripts/v6-worktree-add.txt" 2>&1
step v6-doctor 0 "$fresh" "scripts/agent-tools/doctor"
step v6-check-plan "$readback_expect" "$fresh" "scripts/agent-tools/check-plan --require-linear-relations $readback_args"
step v6-fixture-tests 0 "$fresh" "scripts/agent-tools/receipt --name fixture-tests -- bash tests/agent-tools/run.sh"
step v6-pstack-upstream "$checkout_expect" "$fresh" "scripts/agent-tools/verify pstack-upstream $checkout_args"
step v6-doctor-without-node 1 "$fresh" "PATH='$nonode' scripts/agent-tools/doctor"
step v6-plan-format-without-node 3 "$fresh" "PATH='$nonode' scripts/agent-tools/verify plan-format"
step v6-required-readback-missing 3 "$fresh" "scripts/agent-tools/check-plan --require-linear-relations"
step v6-doctor-empty-path 2 "$fresh" "PATH=/nonexistent scripts/agent-tools/doctor"
step v6-doctor-without-git 1 "$fresh" "PATH='$nogit' scripts/agent-tools/doctor"
step v6-plan-format-without-git 3 "$fresh" "PATH='$nogit' scripts/agent-tools/verify plan-format --base origin/dev --plan tests/agent-tools/fixtures/plans/valid.md"
step v6-check-plan-without-git 3 "$fresh" "PATH='$nogit' scripts/agent-tools/check-plan --base origin/dev --require-linear-relations $readback_args"
step v6-plan-format-bad-base 3 "$fresh" "scripts/agent-tools/verify plan-format --base clearcase-base-does-not-exist --plan tests/agent-tools/fixtures/plans/valid.md"
git -C "$fresh" status --porcelain >"$OUT/transcripts/v6-fresh-status.txt"
git -C "$WT" worktree remove "$fresh" >>"$OUT/transcripts/v6-worktree-add.txt" 2>&1
git -C "$WT" worktree list >"$OUT/transcripts/v6-worktree-list-after.txt"
rm -rf "$nonode" "$nogit"

# Every receipt that names a head names the tested one; every PASS receipt also names its base and merge base.
python3 - "$OUT/receipts" "$(git -C "$WT" rev-parse HEAD)" >"$OUT/identity-audit.txt" <<'EOF' || mismatches=$((mismatches + 1))
import json, pathlib, re, sys
rows, problems = [], []
for path in sorted(pathlib.Path(sys.argv[1]).rglob("receipt.json")):
    receipt, where = json.loads(path.read_text()), path.parent.relative_to(sys.argv[1])
    revision = receipt["revision"]
    rows.append(f"{receipt['result']:<8}{receipt['exitCode']:<3}{where}  head={revision['head']} base={revision['base']} "
                f"mergeBase={revision['mergeBase']}")
    if revision["head"] not in (None, sys.argv[2]):
        problems.append(f"{where}: head {revision['head']} is not the tested head")
    full = [re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision[key] or "") for key in ("head", "base", "mergeBase")]
    if receipt["result"] == "PASS" and not all(full):
        problems.append(f"{where}: PASS without head, base and merge base")
passed = sum(row.startswith("PASS") for row in rows)
print("\n".join(rows + problems))
print(f"identity audit: {len(rows)} receipts, {passed} PASS each with head {sys.argv[2]}, base and merge base; "
      f"{len(problems)} problems")
sys.exit(1 if problems else 0)
EOF
tail -n 1 "$OUT/identity-audit.txt"

# Committed evidence must not carry the home directory.
find "$OUT" -type f -exec sed -i "s#$HOME#~#g" {} +
echo "summary: $OUT/summary.tsv ($mismatches mismatches)"
((mismatches == 0)) || exit 1
unset_inputs=()
[[ -n $READBACK ]] || unset_inputs+=(CC27_READBACK)
[[ -n $CHECKOUT ]] || unset_inputs+=(CC27_PSTACK_CHECKOUT)
if ((${#unset_inputs[@]})); then
	echo "INCOMPLETE: ${unset_inputs[*]} not set, so those comparisons were SKIPPED. A skipped check is not a pass."
	exit 3
fi
