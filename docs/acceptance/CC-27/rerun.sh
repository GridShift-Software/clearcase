#!/usr/bin/env bash
# Rerun CC-27 verification items 1-6 from clean non-interactive shells.
# Usage: CC27_READBACK=PATH [CC27_PSTACK_CHECKOUT=DIR] [CC27_EXPORT=PATH] [CC27_OUT=DIR] [CC27_BUN=PATH] bash docs/acceptance/CC-27/rerun.sh
# CC27_PSTACK_CHECKOUT is optional: the pstack-upstream comparison it fed is retired and FAILs (1) with or without it.
# Environment it assumes, checked before any step (exit 2 otherwise): a committed checkout of this repository with
# its dependencies installed (`bun install --frozen-lockfile`, so node_modules/typescript exists, which the guard's
# tests need), Bun at CC27_BUN or on the caller's PATH, and python3, git and node in /usr/local/bin, /usr/bin or /bin.
# Each clean shell gets PATH=/usr/local/bin:/usr/bin:/bin and CLEARCASE_BUN=CC27_BUN, because the doctor requires Bun
# and on puk it lives in ~/.local/bin, outside the clean PATH. The two fixture-test steps also append Bun's directory
# to that PATH, because two of the suite's receipt tests run `bun` by name. The throwaway worktree gets the checkout's
# node_modules linked in, as the CI guard step does; nothing is installed. The app step names a missing Chromium, so
# verify-clearcase stops at its preflight (exit 3) without building or driving a browser: the app path itself is
# proved by the verify-clearcase skill under the browser lock, not here.
# Writes receipts/, transcripts/, summary.tsv, revision.txt and identity-audit.txt under CC27_OUT (default
# .local/cc27-rerun), first deleting those of an earlier run there. The inventory below names every required step,
# its expected exit code and the receipts it must leave, and the audit at the end checks each of them. Exits
#   2 if the environment above is missing, if CC27_OUT holds receipts/ or transcripts/ that rerun.sh did not write,
#     if the revision and status of the checkout cannot be read, or if any output cannot be written. The run stops
#     there and is not evidence.
#   1 if a step's exit code differs from the expected one, git status of the throwaway worktree fails, or the audit
#     finds an inventoried step without exactly one MATCH row in summary.tsv, a non-empty transcript and exactly its
#     receipts, a receipt that names another head, a PASS receipt without a base, a merge base and a working tree
#     Git reported clean, or a receipt whose receipt.json, stdout.txt or stderr.txt is missing.
#   3 (INCOMPLETE) if CC27_READBACK is unset, because the Linear readback comparison then did not run.
#   0 otherwise.
set -u

die() {
	echo "rerun.sh: $*. The run stopped and is not evidence." >&2
	exit 2
}
WT=$(cd "${BASH_SOURCE[0]%/*}/../../.." && pwd)
OUT=$(mkdir -p "${CC27_OUT:-$WT/.local/cc27-rerun}" && cd "${CC27_OUT:-$WT/.local/cc27-rerun}" && pwd) ||
	die "cannot create ${CC27_OUT:-$WT/.local/cc27-rerun}"
READBACK=${CC27_READBACK:-}
EXPORT=${CC27_EXPORT:-}
CHECKOUT=${CC27_PSTACK_CHECKOUT:-}
[[ -d $CHECKOUT ]] && CHECKOUT=$(cd "$CHECKOUT" && pwd)
CLEAN_PATH=/usr/local/bin:/usr/bin:/bin
BUN=${CC27_BUN-$(command -v bun)}
[[ -x $BUN ]] || die "Bun is not executable at '$BUN'; set CC27_BUN"
[[ -f $WT/node_modules/typescript/package.json ]] || die "$WT has no node_modules/typescript; run bun install --frozen-lockfile"
HEADER=$'step\texpected\tactual\tverdict\tcommand'
scratch=() fresh=
cleanup() {
	[[ -n $fresh && -d $fresh ]] && git -C "$WT" worktree remove --force "$fresh" >/dev/null 2>&1
	rm -rf "${scratch[@]}"
}
trap cleanup EXIT

# logged FILE COMMAND... : run COMMAND with its stdout and stderr appended to FILE, and return its exit code. A FILE
# that cannot be opened stops the run, so a failed write is never read as COMMAND's result.
logged() {
	local file=$1 fd code
	shift
	exec {fd}>>"$file" || die "cannot write $file"
	"$@" >&"$fd" 2>&1
	code=$?
	exec {fd}>&-
	return "$code"
}

# A receipt left by an earlier run must not pass as this run's evidence, so clear an earlier run's outputs.
if [[ -e $OUT/receipts || -e $OUT/transcripts ]]; then
	if [[ $(head -n 1 "$OUT/summary.tsv" 2>/dev/null) != "$HEADER" ]]; then
		echo "rerun.sh: $OUT holds receipts/ or transcripts/ that rerun.sh did not write; set CC27_OUT to a new directory." >&2
		exit 2
	fi
	rm -rf "$OUT/receipts" "$OUT/transcripts" "$OUT/summary.tsv" "$OUT/revision.txt" "$OUT/identity-audit.txt" ||
		die "cannot delete the outputs of the earlier run in $OUT"
fi
mkdir -p "$OUT/receipts" "$OUT/transcripts" || die "cannot create $OUT/receipts and $OUT/transcripts"
printf '%s\n' "$HEADER" >"$OUT/summary.tsv" || die "cannot write $OUT/summary.tsv"
# A Git query that fails must not read as a clean checkout.
exec {revision}>"$OUT/revision.txt" || die "cannot write $OUT/revision.txt"
if ! { git -C "$WT" rev-parse HEAD && git -C "$WT" status --porcelain --untracked-files=normal; } >&"$revision"; then
	echo "rerun.sh: cannot read the revision and status of $WT, or write them to $OUT/revision.txt; see the error above." >&2
	exit 2
fi
exec {revision}>&-
mismatches=0

# step NAME EXPECTED DIR COMMAND : run COMMAND in a clean shell inside DIR, with its output in transcripts/NAME.txt
step() {
	local name=$1 expected=$2 dir=$3 command=$4 actual verdict=MATCH
	logged "$OUT/transcripts/$name.txt" env -i HOME="$HOME" PATH="$CLEAN_PATH" ${BUN:+"CLEARCASE_BUN=$BUN"} \
		CLEARCASE_RECEIPTS_DIR="$OUT/receipts/$name" bash --noprofile --norc -c "cd '$dir' && $command"
	actual=$?
	[[ $actual == "$expected" ]] || { verdict=MISMATCH; mismatches=$((mismatches + 1)); }
	printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$expected" "$actual" "$verdict" "$command" >>"$OUT/summary.tsv" ||
		die "cannot write $OUT/summary.tsv"
	printf '%-8s %-34s expected %s, got %s\n' "$verdict" "$name" "$expected" "$actual"
}

for dir in nonode nogit nobun oldbun fresh; do
	path=$(mktemp -d "${TMPDIR:-/tmp}/cc27-$dir.XXXXXX") || die "cannot create a temporary directory"
	scratch+=("$path")
	printf -v "$dir" %s "$path"
done
rmdir "$fresh" || die "cannot prepare $fresh for the throwaway worktree"
ln -s /usr/bin/python3 "$nonode/python3" && ln -s /usr/bin/git "$nonode/git" || die "cannot link tools into $nonode"
for tool in python3 node; do ln -s "$(PATH=$CLEAN_PATH command -v "$tool")" "$nogit/$tool" || die "cannot link $tool"; done
for tool in python3 git node; do ln -s "$(PATH=$CLEAN_PATH command -v "$tool")" "$nobun/$tool" || die "cannot link $tool"; done
printf '#!/bin/sh\necho 1.3.9\n' >"$oldbun/bun" && chmod +x "$oldbun/bun" || die "cannot write $oldbun/bun"
# Expected exits at the GRS-104 tooling change (the old lines expected 0 or 3): the retired pstack-upstream steps and
# the required plan-format and linear-relations steps FAIL (1) where they were SKIPPED (3), and check-plan fails (1)
# on the delivery plan's format backlog. At GRS-159 plan-format became the project's own delivery-plan contract, so
# v2-check-plan returns to 0, a missing required readback is the only failure and exits 3, and the pstack
# check-plan.mjs steps call that checker by its new name, pstack-plan-format.
readback_args=${READBACK:+--linear-relations "'$READBACK'"}
readback_expect=$([[ -n $READBACK ]] && echo 0 || echo 3)
checkout_args=${CHECKOUT:+--checkout "'$CHECKOUT'"}
checkout_expect=1

# need NAME EXPECTED HEAD DIR RECEIPTS COMMAND : the inventory. Step NAME runs COMMAND in a clean shell inside DIR. It
# must exit EXPECTED and leave a non-empty transcript and exactly the receipts named in RECEIPTS. HEAD is "head" when
# each of them must name the tested head, and "none" when git is missing on purpose, so none of them can.
names=() expects=() heads=() dirs=() wants=() commands=()
need() { names+=("$1") expects+=("$2") heads+=("$3") dirs+=("$4") wants+=("$5") commands+=("$6"); }
# 1. bootstrap twice, doctor, the retired pstack-upstream comparison (FAILs, 1), removal
need v1-bootstrap-first 0 head "$WT" "doctor bootstrap-first" "scripts/agent-tools/receipt --name bootstrap-first -- scripts/agent-tools/bootstrap"
need v1-bootstrap-repeat 0 head "$WT" "doctor bootstrap-repeat" "scripts/agent-tools/receipt --name bootstrap-repeat -- scripts/agent-tools/bootstrap"
need v1-doctor 0 head "$WT" doctor "scripts/agent-tools/doctor"
need v1-pstack-upstream "$checkout_expect" head "$WT" pstack-upstream "scripts/agent-tools/verify pstack-upstream $checkout_args"
need v1-bootstrap-remove 0 head "$WT" bootstrap-remove "scripts/agent-tools/receipt --name bootstrap-remove -- scripts/agent-tools/bootstrap --remove"
# 2. planning checker and the delivery-plan format
need v2-check-plan 0 head "$WT" "plan-graph plan-format" "scripts/agent-tools/check-plan"
# 3. Linear readback comparison (0 with a CC27_READBACK that matches the plan; without one, 3 for the missing required
#    readback, which also ends the run INCOMPLETE)
need v3-linear-relations "$readback_expect" head "$WT" "plan-graph plan-format linear-relations" \
	"scripts/agent-tools/check-plan --require-linear-relations $readback_args"
if [[ -n $EXPORT ]]; then
	# Informational: lists description drift between generated briefs and live Linear text. Drift exits 1.
	need v3-description-drift "${CC27_EXPORT_EXPECT:-1}" head "$WT" description-drift \
		"scripts/agent-tools/receipt --name description-drift -- python3 scripts/planning/generate.py --compare-linear '$EXPORT'"
fi
# 4. valid and invalid plan fixtures
need v4-fixture-tests 0 head "$WT" fixture-tests "PATH=\"\$PATH:${BUN%/*}\" scripts/agent-tools/receipt --name fixture-tests -- bash tests/agent-tools/run.sh"
# 5. verification capability on synthetic fixtures
need v5-pstack-plan-format-valid 0 head "$WT" pstack-plan-format "scripts/agent-tools/verify pstack-plan-format --plan tests/agent-tools/fixtures/plans/valid.md"
need v5-pstack-plan-format-invalid 1 head "$WT" pstack-plan-format "scripts/agent-tools/verify pstack-plan-format --plan tests/agent-tools/fixtures/plans/invalid.md"
need v5-app-deferred 3 head "$WT" app "CLEARCASE_CHROMIUM=/nonexistent/chrome scripts/agent-tools/verify app"
need v5-pstack-upstream-no-checkout 1 head "$WT" pstack-upstream "scripts/agent-tools/verify pstack-upstream"
# 6. fresh worktree, missing dependency, skipped check
need v6-doctor 0 head "$fresh" doctor "scripts/agent-tools/doctor"
need v6-check-plan "$readback_expect" head "$fresh" "plan-graph plan-format linear-relations" \
	"scripts/agent-tools/check-plan --require-linear-relations $readback_args"
need v6-fixture-tests 0 head "$fresh" fixture-tests "PATH=\"\$PATH:${BUN%/*}\" scripts/agent-tools/receipt --name fixture-tests -- bash tests/agent-tools/run.sh"
need v6-pstack-upstream "$checkout_expect" head "$fresh" pstack-upstream "scripts/agent-tools/verify pstack-upstream $checkout_args"
need v6-doctor-without-node 1 head "$fresh" doctor "PATH='$nonode' scripts/agent-tools/doctor"
need v6-pstack-plan-format-without-node 1 head "$fresh" pstack-plan-format "PATH='$nonode' scripts/agent-tools/verify pstack-plan-format --plan tests/agent-tools/fixtures/plans/valid.md"
need v6-required-readback-missing 3 head "$fresh" "plan-graph plan-format linear-relations" \
	"scripts/agent-tools/check-plan --require-linear-relations"
need v6-doctor-empty-path 2 none "$fresh" "" "PATH=/nonexistent scripts/agent-tools/doctor"
need v6-doctor-without-git 1 none "$fresh" doctor "PATH='$nogit' scripts/agent-tools/doctor"
need v6-doctor-without-bun 1 head "$fresh" doctor "unset CLEARCASE_BUN; PATH='$nobun' scripts/agent-tools/doctor"
need v6-doctor-old-bun 1 head "$fresh" doctor "CLEARCASE_BUN='$oldbun/bun' scripts/agent-tools/doctor"
need v6-plan-format-without-git 1 none "$fresh" plan-format \
	"PATH='$nogit' scripts/agent-tools/verify plan-format --base origin/dev --plan tests/agent-tools/fixtures/plans/valid.md"
need v6-check-plan-without-git 3 none "$fresh" "plan-graph plan-format linear-relations" \
	"PATH='$nogit' scripts/agent-tools/check-plan --base origin/dev --require-linear-relations $readback_args"
need v6-plan-format-bad-base 1 head "$fresh" plan-format \
	"scripts/agent-tools/verify plan-format --base clearcase-base-does-not-exist --plan tests/agent-tools/fixtures/plans/valid.md"

logged "$OUT/transcripts/v6-worktree-add.txt" git -C "$WT" worktree add --detach "$fresh" HEAD ||
	die "cannot add the throwaway worktree $fresh; see $OUT/transcripts/v6-worktree-add.txt"
ln -s "$WT/node_modules" "$fresh/node_modules" || die "cannot link node_modules into $fresh"
for i in "${!names[@]}"; do
	step "${names[i]}" "${expects[i]}" "${dirs[i]}" "${commands[i]}"
done
if ! logged "$OUT/transcripts/v6-fresh-status.txt" git -C "$fresh" status --porcelain --untracked-files=normal; then
	echo "MISMATCH git status of the fresh worktree failed: $OUT/transcripts/v6-fresh-status.txt"
	mismatches=$((mismatches + 1))
fi
logged "$OUT/transcripts/v6-worktree-add.txt" git -C "$WT" worktree remove "$fresh"
logged "$OUT/transcripts/v6-worktree-list-after.txt" git -C "$WT" worktree list

# Committed evidence must not carry the home directory.
find "$OUT" -type f -exec sed -i "s#$HOME#~#g" {} + || die "cannot replace the home directory in the files under $OUT"

# The audit is the last look at the evidence. Every inventoried step has one MATCH row, a non-empty transcript and
# exactly its receipts. Every receipt names the tested head, or none where the inventory says git is missing, and its
# receipt.json, stdout.txt and stderr.txt exist in its own directory. Every PASS receipt also names its base and merge
# base and a working tree that Git reported clean.
tested=$(git -C "$WT" rev-parse HEAD) || die "cannot read the tested head of $WT"
inventory=()
for i in "${!names[@]}"; do inventory+=("${names[i]}" "${expects[i]}" "${heads[i]}" "${wants[i]}"); done
exec {audit}>"$OUT/identity-audit.txt" || die "cannot write $OUT/identity-audit.txt"
python3 - "$OUT" "$tested" "${inventory[@]}" >&"$audit" <<'EOF'
import json, os, pathlib, re, sys
out, head, flat = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3:]
steps = [flat[i:i + 4] for i in range(0, len(flat), 4)]
rows, problems, seen, ran = [], [], set(), {}
for line in (out / "summary.tsv").read_text().splitlines()[1:]:
    ran.setdefault(line.split("\t")[0], []).append(line.split("\t")[1:4])
for name, expected, heads, wanted in steps:
    if ran.pop(name, None) != [[expected, expected, "MATCH"]]:
        problems.append(f"{name}: summary.tsv does not hold exactly one MATCH row with exit {expected}")
    transcript = out / "transcripts" / f"{name}.txt"
    if not transcript.is_file() or not transcript.stat().st_size:
        problems.append(f"{name}: transcripts/{name}.txt is missing or empty")
    found = []
    for path in sorted((out / "receipts" / name).glob("*/receipt.json")):
        seen.add(path)
        where = path.parent.relative_to(out / "receipts")
        try:
            receipt = json.loads(path.read_text())
            revision, artifacts = receipt["revision"], receipt["artifacts"]
            rows.append(f"{receipt['result']:<8}{receipt['exitCode']:<3}{where}  head={revision['head']} "
                        f"base={revision['base']} mergeBase={revision['mergeBase']} dirty={revision['dirty']}")
        except (OSError, ValueError, KeyError, TypeError) as error:
            problems.append(f"{where}: receipt.json cannot be read: {error!r}")
            continue
        found.append(receipt["name"])
        if revision["head"] != (head if heads == "head" else None):
            problems.append(f"{where}: head {revision['head']} is not {'the tested head' if heads == 'head' else 'none'}")
        full = [re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision[key] or "") for key in ("head", "base", "mergeBase")]
        if receipt["result"] == "PASS" and not all(full):
            problems.append(f"{where}: PASS without head, base and merge base")
        if receipt["result"] == "PASS" and (revision["dirty"] is not False or revision["diffSha256"] is not None):
            problems.append(f"{where}: PASS without a clean working tree (dirty={revision['dirty']})")
        for key in ("receipt", "stdout", "stderr"):
            artifact = pathlib.Path(os.path.expanduser(str(artifacts.get(key))))
            if not artifact.is_file() or artifact.parent.resolve() != path.parent.resolve():
                problems.append(f"{where}: its {key} artifact {artifacts.get(key)} is missing")
    if sorted(found) != sorted(wanted.split()):
        problems.append(f"{name}: receipts {sorted(found)}, but the inventory requires {sorted(wanted.split())}")
problems += [f"{name}: summary.tsv row of a step that is not in the inventory" for name in ran]
problems += [f"{path.relative_to(out)}: receipt outside the inventoried steps"
             for path in sorted(set((out / "receipts").rglob("receipt.json")) - seen)]
print("\n".join(rows + problems))
print(f"audit: {len(steps)} inventoried steps, each with one MATCH row, a transcript and its receipts; {len(rows)} "
      f"receipts, {sum(row.startswith('PASS') for row in rows)} PASS each with head {head}, base, merge base and a clean "
      f"working tree; every receipt's artifacts present; {len(problems)} problems")
sys.exit(1 if problems else 0)
EOF
audited=$?
exec {audit}>&-
tail -n 1 "$OUT/identity-audit.txt"
echo "summary: $OUT/summary.tsv ($mismatches mismatches)"
if ((mismatches || audited)); then
	((audited == 0)) || echo "FAIL: the audit found problems or did not finish; see $OUT/identity-audit.txt"
	exit 1
fi
if [[ -z $READBACK ]]; then
	echo "INCOMPLETE: CC27_READBACK not set, so the Linear readback comparison did not run. A skipped check is not a pass."
	exit 3
fi
