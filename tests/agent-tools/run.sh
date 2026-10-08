#!/usr/bin/env bash
# Behavior tests for scripts/agent-tools. Needs only bash, coreutils, git, python3 and node.
# Usage: bash tests/agent-tools/run.sh   (exit 0 only when every case passes)
set -u

HERE=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
TOOLS="$REPO/scripts/agent-tools"
FIXTURES="$HERE/fixtures"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cc27-agent-tools.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
passed=0
failed=0
n=0

ok() { passed=$((passed + 1)); echo "ok   $1"; }
bad() { failed=$((failed + 1)); echo "FAIL $1"; shift; for line in "$@"; do echo "     $line"; done; }

# run NAME EXPECTED_EXIT CMD... ; leaves output in $OUT, receipts in $RECEIPTS
run() {
	local name=$1 expected=$2
	shift 2
	n=$((n + 1))
	RECEIPTS="$WORK/receipts-$n"
	OUT="$WORK/out-$n.txt"
	CLEARCASE_RECEIPTS_DIR="$RECEIPTS" "$@" >"$OUT" 2>&1
	CODE=$?
	if [[ $CODE == "$expected" ]]; then
		ok "$name (exit $CODE)"
	else
		bad "$name" "expected exit $expected, got $CODE" "$(tail -n 5 "$OUT")"
	fi
}

has() {
	if grep -qF -- "$2" "$OUT"; then ok "$1"; else bad "$1" "output lacks: $2" "$(tail -n 5 "$OUT")"; fi
}

lacks() {
	if grep -qF -- "$2" "$OUT"; then bad "$1" "output has: $2"; else ok "$1"; fi
}

# receipt_is NAME RESULT EXIT : the single receipt in $RECEIPTS has this result and exit code and every field
receipt_is() {
	local file
	file=$(compgen -G "$RECEIPTS/*/receipt.json" | head -n 1)
	if [[ -z $file ]]; then bad "$1" "no receipt in $RECEIPTS"; return; fi
	local verdict
	verdict=$(python3 - "$file" "$2" "$3" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
problems = []
if r["result"] != sys.argv[2]: problems.append(f"result {r['result']}")
if r["exitCode"] != int(sys.argv[3]): problems.append(f"exitCode {r['exitCode']}")
for field in ["command", "tools", "revision", "environment", "startedAt", "finishedAt", "artifacts"]:
    if field not in r: problems.append(f"missing {field}")
for path in r["artifacts"].values():
    import os
    if not os.path.isfile(os.path.expanduser(path)): problems.append(f"missing artifact {path}")
if r["result"] == "PASS" and (r["exitCode"] != 0 or r["reason"]): problems.append("PASS with nonzero exit or skip reason")
print("; ".join(problems))
EOF
)
	if [[ -z $verdict ]]; then ok "$1"; else bad "$1" "$verdict" "$file"; fi
}

echo "# pstack check-plan.mjs fixtures through verify plan-format"
run "valid plan passes" 0 "$TOOLS/verify" plan-format --plan "$FIXTURES/plans/valid.md"
has "valid plan reports zero problems" "1 PR sections, 0 problems"
receipt_is "valid plan receipt is PASS" PASS 0
run "invalid plan fails with the checker's own exit code" 1 "$TOOLS/verify" plan-format --plan "$FIXTURES/plans/invalid.md"
for message in "long dash" 'How to read this lacks "One box is one unit of work"' "lanes are [1,2,3,4,5,6,7,8,9,11]" "perf boxes are [Metric., Probe., Baseline.]"; do
	has "invalid plan diagnoses: $message" "$message"
done
receipt_is "invalid plan receipt is FAIL" FAIL 1
if grep -qF "long dash" "$(compgen -G "$RECEIPTS/*/stderr.txt")"; then ok "checker stderr preserved in receipt"; else bad "checker stderr preserved in receipt"; fi

echo "# planning graph fixtures through verify plan-graph / linear-relations"
for fixture in "$FIXTURES"/graph/*.json; do
	name=$(basename "$fixture" .json)
	tree="$WORK/tree-$name"
	python3 "$HERE/make_tree.py" "$REPO" "$tree" "$fixture" || { bad "$name: build fixture tree"; continue; }
	read -r capability expected < <(python3 -c 'import json,sys; f=json.load(open(sys.argv[1])); print(f["capability"], f["expect"]["exit"])' "$fixture")
	args=("$TOOLS/verify" "$capability" --root "$tree")
	[[ $capability == linear-relations ]] && args+=(--readback "$tree/readback.json")
	run "graph $name" "$expected" "${args[@]}"
	while IFS= read -r message; do has "graph $name diagnoses: $message" "$message"; done < <(
		python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["expect"]["output"]))' "$fixture")
	receipt_is "graph $name receipt" "$([[ $expected == 0 ]] && echo PASS || echo FAIL)" "$expected"
done

echo "# skipped and deferred checks are never PASS"
run "app capability is deferred" 3 "$TOOLS/verify" app
has "app deferral names GRS-12" "deferred to GRS-12"
receipt_is "app receipt is SKIPPED" SKIPPED 3
run "required Linear comparison without a readback fails" 3 "$TOOLS/check-plan" --require-linear-relations
has "check-plan reports the skipped comparison" "linear-relations=SKIPPED"
has "check-plan overall verdict is FAIL" "check-plan: FAIL"
run "missing command is SKIPPED, not PASS" 3 "$TOOLS/receipt" --name missing -- definitely-not-a-command-cc27
receipt_is "missing command receipt" SKIPPED 3

echo "# receipt writer preserves output and exit codes"
run "wrapped command keeps exit 7" 7 "$TOOLS/receipt" --name exit7 --tool bash -- bash -c 'echo to-stdout; echo to-stderr >&2; exit 7'
has "wrapped stdout is streamed" "to-stdout"
has "wrapped stderr is streamed" "to-stderr"
receipt_is "exit 7 receipt is FAIL" FAIL 7
if grep -qx to-stdout "$RECEIPTS"/*/stdout.txt && grep -qx to-stderr "$RECEIPTS"/*/stderr.txt; then
	ok "stdout and stderr captured separately"
else
	bad "stdout and stderr captured separately"
fi

echo "# doctor and missing dependencies"
run "doctor passes in this environment" 0 "$TOOLS/doctor"
has "doctor checks the skill pin" "skills match skills.lock.json"
NONODE="$WORK/bin-without-node"
mkdir -p "$NONODE"
for tool in python3 git; do ln -s "$(command -v "$tool")" "$NONODE/$tool"; done
run "doctor fails without node" 1 env PATH="$NONODE" "$TOOLS/doctor"
has "doctor names node and the fix" "fix: install Node.js >= 18"
run "plan-format without node is SKIPPED" 3 env PATH="$NONODE" "$TOOLS/verify" plan-format
receipt_is "no-node receipt is SKIPPED" SKIPPED 3
run "doctor without python3 explains the PATH" 2 env PATH=/nonexistent "$TOOLS/doctor"
has "no-python message is actionable" "fix: install Python >= 3.10"
run "doctor fails on a missing skills dir" 1 env CLEARCASE_SKILLS_DIR="$WORK/no-skills" HOME="$WORK/no-home" "$TOOLS/doctor"
has "missing skills dir is diagnosed" "pstack bundle not found"

echo "# the doctor flags a changed or missing pinned skill"
SKILLS=${CLEARCASE_SKILLS_DIR:-$HOME/.agents/skills}
PLANTED="$WORK/planted-skills"
mapfile -t pinned < <(python3 -c 'import json,sys; print("\n".join(sorted(json.load(open(sys.argv[1]))["skills"])))' "$TOOLS/skills.lock.json")
for name in "${pinned[@]}"; do mkdir -p "$PLANTED/$name" && cp -a "$SKILLS/$name/." "$PLANTED/$name/"; done
run "doctor passes on a copy of the pinned skills" 0 "$TOOLS/doctor" --skills-dir "$PLANTED"
changed=${pinned[0]} missing=${pinned[-1]}
echo "planted" >"$PLANTED/$changed/PLANTED.md"
rm -rf "${PLANTED:?}/$missing"
run "doctor fails on a changed and a missing pinned skill" 1 "$TOOLS/doctor" --skills-dir "$PLANTED"
has "doctor names the changed skill" "$changed differs from the pin"
has "doctor names the missing skill" "$missing missing"
has "doctor gives the relock fix" "bootstrap --relock"
lacks "doctor reports no matching pin" "skills match skills.lock.json"

echo "# pstack-upstream compares the pin with the pinned revision's Git objects"
UP="$WORK/pstack-checkout"
INSTALLED="$WORK/pstack-installed"
PIN="$WORK/pin-copy/scripts/agent-tools"
mkdir -p "$UP/skills/alpha" "$UP/skills/beta/references" "$UP/skills/gamma" "$UP/.cursor-plugin" "$INSTALLED/local-skill" "${PIN%/*}"
for skill in alpha beta gamma; do echo "# $skill" >"$UP/skills/$skill/SKILL.md"; done
echo "reference" >"$UP/skills/beta/references/notes.md"
echo '{"name": "pstack", "version": "9.9.9", "license": "MIT"}' >"$UP/.cursor-plugin/plugin.json"
echo "*.log" >"$UP/.gitignore"
upstream_commit() { git -C "$UP" add -A && git -C "$UP" -c user.name=t -c user.email=t@example.invalid commit -qm "$1"; }
git -C "$UP" init -q && upstream_commit synthetic
cp -a "$UP/skills/alpha" "$UP/skills/beta" "$INSTALLED/"
echo "# local" >"$INSTALLED/local-skill/SKILL.md"
cp -r "$TOOLS" "${PIN%/*}/"
# pin_edit CODE : run python CODE with lock and pin (its provenance.pstack) bound, then save the copied lock
pin_edit() {
	python3 - "$PIN/skills.lock.json" "$1" <<'EOF'
import json, sys
lock = json.load(open(sys.argv[1]))
pin = lock["provenance"]["pstack"]
exec(sys.argv[2])
open(sys.argv[1], "w").write(json.dumps(lock, indent=2) + "\n")
EOF
}
pin_edit "pin.update(revision='$(git -C "$UP" rev-parse HEAD)', version='9.9.9', license='MIT', notInstalled=[]); lock['skills'] = {'alpha': {'group': 'other'}, 'local-skill': {'group': 'other'}}"
run "pstack-upstream without a checkout is SKIPPED" 3 "$PIN/verify" pstack-upstream --skills-dir "$INSTALLED"
receipt_is "no-checkout receipt is SKIPPED" SKIPPED 3
run "pstack-upstream with a missing checkout is SKIPPED" 3 "$PIN/verify" pstack-upstream --checkout "$WORK/no-such-checkout" --skills-dir "$INSTALLED"
has "names the missing checkout" "pstack checkout not found"
run "mislabelled, unpinned and unlisted upstream skills fail" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the mislabelled skill" "alpha is an installed upstream skill but is pinned as other"
has "names the unpinned skill" "beta is an installed upstream skill but is not pinned"
has "names the unlisted upstream skill" "upstream skills not installed are ['gamma']"
receipt_is "mismatch receipt is FAIL" FAIL 1
run "relock from the checkout pins the installed upstream skills" 0 "$PIN/bootstrap" --relock --checkout "$UP" --skills-dir "$INSTALLED"
has "relock reports what is not installed" "Upstream skills not installed: gamma"
pin_edit "pin['notInstalled'] = ['gamma']"
run "pstack-upstream passes on a matching pin and install" 0 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "pass counts the pinned skills" "2 pinned pstack skills match"
receipt_is "matching receipt is PASS" PASS 0
echo "planted" >>"$INSTALLED/beta/references/notes.md"
run "a changed installed file fails" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the changed file" "beta/references/notes.md differs"
run "relock refuses an install that differs from the checkout" 1 "$PIN/bootstrap" --relock --checkout "$UP" --skills-dir "$INSTALLED"
has "refusal names the changed file" "beta/references/notes.md differs"
cp "$UP/skills/beta/references/notes.md" "$INSTALLED/beta/references/notes.md"
echo "payload" | tee "$UP/skills/alpha/payload.log" >"$INSTALLED/alpha/payload.log"
run "an ignored file in the checkout's working tree is not upstream content" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the installed-only file" "alpha/payload.log only installed"
rm "$INSTALLED/alpha/payload.log"
mkdir -p "$WORK/not-git/skills" && cp -a "$UP/skills/alpha" "$WORK/not-git/skills/"
run "relock refuses a directory that is not a Git checkout" 1 "$PIN/bootstrap" --relock --checkout "$WORK/not-git" --skills-dir "$INSTALLED"
has "refusal asks for a pstack checkout" "is not a pstack checkout"
run "relock refuses a missing path" 1 "$PIN/bootstrap" --relock --checkout "$WORK/no-such-checkout" --skills-dir "$INSTALLED"
run "the pin survives the refused relocks" 0 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
echo "# alpha 2" >"$UP/skills/alpha/SKILL.md"
upstream_commit "upstream moves on"
run "a later upstream HEAD still compares the pinned revision" 0 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
pin_edit "pin['revision'] = '0' * 40"
run "a clone without the pinned revision fails" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the missing revision" "has no .cursor-plugin/plugin.json at 0000000000000000000000000000000000000000"
git -C "$UP" rm -rq skills/beta && upstream_commit "upstream drops beta"
cp "$UP/skills/alpha/SKILL.md" "$INSTALLED/alpha/SKILL.md"
run "relock follows the checkout's HEAD" 0 "$PIN/bootstrap" --relock --checkout "$UP" --skills-dir "$INSTALLED"
has "relock names the pins it removes" "Removed pstack pins: beta"

echo "# bootstrap is idempotent and removable in a fresh checkout"
FRESH="$WORK/fresh"
mkdir -p "$FRESH/scripts" "$FRESH/docs"
cp -r "$REPO/scripts/agent-tools" "$REPO/scripts/planning" "$FRESH/scripts/"
cp -r "$REPO/docs/plan" "$FRESH/docs/"
cp "$REPO/docs/delivery-plan.md" "$FRESH/docs/"
cp "$REPO/.gitignore" "$FRESH/"
git -C "$FRESH" init -q && git -C "$FRESH" add -A && git -C "$FRESH" -c user.name=t -c user.email=t@example.invalid commit -qm fixture
run "first bootstrap links" 0 "$FRESH/scripts/agent-tools/bootstrap"
has "first bootstrap reports linked" "linked ->"
run "second bootstrap is a no-op" 0 "$FRESH/scripts/agent-tools/bootstrap"
has "second bootstrap reports unchanged" "unchanged ->"
mkdir -p "$WORK/other-skills"
ln -s "$(readlink "$FRESH/.local/agent-tools/skills")/poteto-mode" "$WORK/other-skills/poteto-mode"
run "conflicting bootstrap is refused" 1 "$FRESH/scripts/agent-tools/bootstrap" --skills-dir "$WORK/other-skills"
has "conflict explains the fix" "bootstrap --remove first"
if [[ -z $(git -C "$FRESH" status --porcelain) ]]; then ok "bootstrap leaves tracked files untouched"; else bad "bootstrap leaves tracked files untouched" "$(git -C "$FRESH" status --porcelain)"; fi
run "remove deletes only local state" 0 "$FRESH/scripts/agent-tools/bootstrap" --remove
if [[ ! -e $FRESH/.local/agent-tools ]]; then ok "local bootstrap state removed"; else bad "local bootstrap state removed"; fi

echo "# summary"
echo "$passed passed, $failed failed"
((failed == 0))
