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
MARKER="$WORK/command-ran"
unset CLEARCASE_BASE_REF
passed=0
failed=0
n=0

commit_all() { git -C "$1" add -A && git -C "$1" -c user.name=t -c user.email=t@example.invalid commit -qm "$2"; }
# git_fixture DIR : make DIR a Git checkout whose dev branch holds its files, as in a clone of the repository
git_fixture() { git -C "$1" init -q -b dev && commit_all "$1" fixture; }

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

# receipt_is NAME RESULT EXIT : every receipt in $RECEIPTS has this result and exit code and every field.
# A PASS receipt must also list git and name the head, base and merge-base commits.
receipt_is() {
	local verdict
	verdict=$(python3 - "$RECEIPTS" "$2" "$3" <<'EOF'
import glob, json, os, re, sys
files = sorted(glob.glob(os.path.join(sys.argv[1], "*", "receipt.json")))
problems = [] if files else ["no receipt"]
for file in files:
    r = json.load(open(file))
    if r["result"] != sys.argv[2]: problems.append(f"result {r['result']}")
    if r["exitCode"] != int(sys.argv[3]): problems.append(f"exitCode {r['exitCode']}")
    for field in ["command", "tools", "revision", "environment", "startedAt", "finishedAt", "artifacts"]:
        if field not in r: problems.append(f"missing {field}")
    for path in r["artifacts"].values():
        if not os.path.isfile(os.path.expanduser(path)): problems.append(f"missing artifact {path}")
    if r["result"] == "PASS":
        if r["exitCode"] != 0 or r["reason"]: problems.append("PASS with nonzero exit or skip reason")
        if not any(tool["name"] == "git" and tool["path"] for tool in r["tools"]): problems.append("PASS without git")
        for key in ["head", "base", "mergeBase"]:
            if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", r["revision"].get(key) or ""):
                problems.append(f"PASS without revision.{key}")
print("; ".join(problems))
EOF
)
	if [[ -z $verdict ]]; then ok "$1"; else bad "$1" "$verdict" "$RECEIPTS"; fi
}

# receipt_revision NAME HEAD BASE_REF BASE MERGE_BASE : every receipt in $RECEIPTS records exactly this revision
receipt_revision() {
	local verdict
	verdict=$(python3 - "$RECEIPTS" "${@:2}" <<'EOF'
import glob, json, os, sys
files = sorted(glob.glob(os.path.join(sys.argv[1], "*", "receipt.json")))
problems = [] if files else ["no receipt"]
for file in files:
    revision = json.load(open(file))["revision"]
    for key, value in zip(["head", "baseRef", "base", "mergeBase"], sys.argv[2:]):
        if revision.get(key) != value: problems.append(f"{key} is {revision.get(key)!r}, expected {value!r}")
print("; ".join(problems))
EOF
)
	if [[ -z $verdict ]]; then ok "$1"; else bad "$1" "$verdict"; fi
}

no_receipt() {
	if compgen -G "$RECEIPTS/*/receipt.json" >/dev/null; then bad "$1" "unexpected receipt in $RECEIPTS"; else ok "$1"; fi
}

# not_run NAME : the wrapped command, which creates $MARKER, did not run
not_run() {
	if [[ -e $MARKER ]]; then bad "$1" "the command ran"; rm -f "$MARKER"; else ok "$1"; fi
}

echo "# pstack check-plan.mjs fixtures through verify plan-format"
repo_base_ref=
for ref in origin/dev dev; do
	repo_base=$(git -C "$REPO" rev-parse --verify -q "$ref^{commit}") && repo_base_ref=$ref && break
done
repo_head=$(git -C "$REPO" rev-parse HEAD)
repo_fork=$(git -C "$REPO" merge-base HEAD "$repo_base")
run "valid plan passes" 0 "$TOOLS/verify" plan-format --plan "$FIXTURES/plans/valid.md"
has "valid plan reports zero problems" "1 PR sections, 0 problems"
receipt_is "valid plan receipt is PASS" PASS 0
receipt_revision "valid plan receipt records this checkout's head and default base" "$repo_head" "$repo_base_ref" "$repo_base" "$repo_fork"
short_base=$(git -C "$REPO" rev-parse --short "$repo_base")
run "valid plan passes with an explicit short --base" 0 "$TOOLS/verify" plan-format --plan "$FIXTURES/plans/valid.md" --base "$short_base"
receipt_revision "explicit --base is recorded as given and resolved to its full commit" "$repo_head" "$short_base" "$repo_base" "$repo_fork"
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
	python3 "$HERE/make_tree.py" "$REPO" "$tree" "$fixture" && git_fixture "$tree" || { bad "$name: build fixture tree"; continue; }
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

echo "# receipts record the exact revision and never PASS without it"
NOGIT="$WORK/bin-without-git"
mkdir -p "$NOGIT"
for tool in python3 node; do ln -s "$(command -v "$tool")" "$NOGIT/$tool"; done
run "plan-format without git is SKIPPED" 3 env PATH="$NOGIT" "$TOOLS/verify" plan-format --plan "$FIXTURES/plans/valid.md" --base "$repo_base"
has "missing git is named with the fix" "required tool not found: git; install it or put it on PATH"
receipt_is "no-git plan-format receipt is SKIPPED" SKIPPED 3
valid_tree="$WORK/tree-readback-valid"
run "check-plan without git fails with every step SKIPPED" 3 env PATH="$NOGIT" "$TOOLS/check-plan" --root "$valid_tree" --require-linear-relations --linear-relations "$valid_tree/readback.json"
has "no-git check-plan names each skipped step" "check-plan: FAIL. plan-graph=SKIPPED, plan-format=SKIPPED, linear-relations=SKIPPED."
receipt_is "no-git check-plan receipts are SKIPPED" SKIPPED 3
run "receipt without git does not run the command" 3 env PATH="$NOGIT" "$TOOLS/receipt" --name no-git -- python3 -c "open('$MARKER', 'w')"
not_run "the command did not run without git"
run "an unresolvable --base is SKIPPED" 3 "$TOOLS/verify" plan-format --plan "$FIXTURES/plans/valid.md" --base no-such-base-cc27
has "the bad base is named with the fix" "base 'no-such-base-cc27' does not resolve to a commit"
receipt_is "bad-base receipt is SKIPPED" SKIPPED 3
run "an unresolvable CLEARCASE_BASE_REF is not replaced by a default" 3 env CLEARCASE_BASE_REF=no-such-base-cc27 "$TOOLS/receipt" --name bad-env-base -- touch "$MARKER"
not_run "the command did not run with a bad base"
IDREPO="$WORK/identity"
mkdir -p "$IDREPO/scripts" && cp -r "$TOOLS" "$IDREPO/scripts/"
git_fixture "$IDREPO"
fork=$(git -C "$IDREPO" rev-parse HEAD)
git -C "$IDREPO" checkout -q -b feature && echo feature >"$IDREPO/feature.txt" && commit_all "$IDREPO" feature
git -C "$IDREPO" checkout -q dev && echo later >"$IDREPO/dev.txt" && commit_all "$IDREPO" "dev moves on"
git -C "$IDREPO" checkout -q feature
id_head=$(git -C "$IDREPO" rev-parse HEAD) id_dev=$(git -C "$IDREPO" rev-parse dev)
run "a receipt in a checkout with dev passes" 0 "$IDREPO/scripts/agent-tools/receipt" --name identity -- true
receipt_is "identity receipt is PASS" PASS 0
receipt_revision "receipt records HEAD, dev and the fork point" "$id_head" dev "$id_dev" "$fork"
run "a receipt with --base COMMIT passes" 0 "$IDREPO/scripts/agent-tools/receipt" --name identity --base "$fork" -- true
receipt_revision "receipt records the explicit base commit" "$id_head" "$fork" "$fork" "$fork"
git -C "$IDREPO" checkout -q --orphan unrelated && commit_all "$IDREPO" unrelated && git -C "$IDREPO" checkout -q feature
run "a base with no shared history is SKIPPED" 3 "$IDREPO/scripts/agent-tools/receipt" --name unrelated --base unrelated -- touch "$MARKER"
has "names the unrelated base" "shares no history with HEAD"
not_run "the command did not run with an unrelated base"
git -C "$IDREPO" branch -q -m dev trunk
run "no --base and no dev or origin/dev is SKIPPED" 3 "$IDREPO/scripts/agent-tools/receipt" --name no-base -- touch "$MARKER"
has "missing default base asks for --base" "no base revision: neither origin/dev nor dev exists"
receipt_is "no-base receipt is SKIPPED" SKIPPED 3
not_run "the command did not run without a base"
run "--base names the base when there is no default" 0 "$IDREPO/scripts/agent-tools/receipt" --name trunk-base --base trunk -- true
receipt_revision "receipt records the named base" "$id_head" trunk "$id_dev" "$fork"
git -C "$IDREPO" branch -q -m trunk dev
run "a --root below a checkout's top is SKIPPED" 3 "$IDREPO/scripts/agent-tools/receipt" --name subdir --root "$IDREPO/scripts" -- true
has "names the checkout's top" "but is not its top"
mkdir -p "$WORK/unborn" && git -C "$WORK/unborn" init -q -b dev
run "a checkout without a commit is SKIPPED" 3 "$TOOLS/receipt" --name unborn --root "$WORK/unborn" -- true
has "names the missing commit" "has no commit yet"
OUTSIDE="$WORK/outside"
mkdir -p "$OUTSIDE/scripts" && cp -r "$TOOLS" "$OUTSIDE/scripts/"
run "receipt outside a Git checkout is SKIPPED" 3 "$OUTSIDE/scripts/agent-tools/receipt" --name outside -- touch "$MARKER"
has "names the missing checkout" "no head revision:"
receipt_is "outside receipt is SKIPPED" SKIPPED 3
not_run "the command did not run outside a checkout"

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
has "doctor reports the revision" "PASS     revision       head ${repo_head:0:12}, base $repo_base_ref"
receipt_is "doctor writes a PASS receipt" PASS 0
receipt_revision "doctor receipt records this checkout's revision" "$repo_head" "$repo_base_ref" "$repo_base" "$repo_fork"
if grep -qF "doctor: PASS" "$RECEIPTS"/*/stdout.txt; then ok "doctor receipt keeps the report"; else bad "doctor receipt keeps the report"; fi
run "doctor fails on an unresolvable --base" 1 "$TOOLS/doctor" --base no-such-base-cc27
has "doctor names the bad base" "FAIL     revision       base 'no-such-base-cc27' does not resolve to a commit"
receipt_is "bad-base doctor receipt is FAIL" FAIL 1
run "doctor fails without git" 1 env PATH="$NOGIT" "$TOOLS/doctor"
has "doctor names git and the fix" "fix: install git"
receipt_is "no-git doctor receipt is FAIL" FAIL 1
NONODE="$WORK/bin-without-node"
mkdir -p "$NONODE"
for tool in python3 git; do ln -s "$(command -v "$tool")" "$NONODE/$tool"; done
run "doctor fails without node" 1 env PATH="$NONODE" "$TOOLS/doctor"
has "doctor names node and the fix" "fix: install Node.js >= 18"
receipt_is "no-node doctor receipt is FAIL" FAIL 1
run "plan-format without node is SKIPPED" 3 env PATH="$NONODE" "$TOOLS/verify" plan-format
receipt_is "no-node receipt is SKIPPED" SKIPPED 3
run "doctor without python3 explains the PATH" 2 env PATH=/nonexistent "$TOOLS/doctor"
has "no-python message is actionable" "fix: install Python >= 3.10"
no_receipt "doctor without python3 writes no receipt"
run "doctor fails on a missing skills dir" 1 env CLEARCASE_SKILLS_DIR="$WORK/no-skills" HOME="$WORK/no-home" "$TOOLS/doctor"
has "missing skills dir is diagnosed" "pstack bundle not found"

echo "# the doctor flags a changed or missing pinned skill"
SKILLS=${CLEARCASE_SKILLS_DIR:-$HOME/.agents/skills}
PLANTED="$WORK/planted-skills"
mapfile -t pinned < <(python3 -c 'import json,sys; print("\n".join(sorted(json.load(open(sys.argv[1]))["skills"])))' "$TOOLS/skills.lock.json")
for name in "${pinned[@]}"; do mkdir -p "$PLANTED/$name" && cp -a "$SKILLS/$name/." "$PLANTED/$name/"; done
run "doctor passes on a copy of the pinned skills" 0 "$TOOLS/doctor" --skills-dir "$PLANTED"
changed=${pinned[0]} missing=${pinned[-1]}
rm -rf "${PLANTED:?}/$missing"
run "doctor fails on a missing pinned skill" 1 "$TOOLS/doctor" --skills-dir "$PLANTED"
has "doctor names the missing skill" "$missing missing"
lacks "doctor reports no matching pin when a skill is missing" "skills match skills.lock.json"
mkdir -p "$PLANTED/$missing" && cp -a "$SKILLS/$missing/." "$PLANTED/$missing/"
echo "planted" >"$PLANTED/$changed/PLANTED.md"
run "doctor fails on a changed pinned skill" 1 "$TOOLS/doctor" --skills-dir "$PLANTED"
has "doctor names the changed skill" "$changed differs from the pin"
has "doctor gives the relock fix" "bootstrap --relock"
lacks "doctor reports no matching pin when a skill changed" "skills match skills.lock.json"

echo "# pstack-upstream compares the pin with the pinned revision's Git objects"
UP="$WORK/pstack-checkout"
INSTALLED="$WORK/pstack-installed"
PIN="$WORK/pin-copy/scripts/agent-tools"
mkdir -p "$UP/skills/alpha" "$UP/skills/beta/references" "$UP/skills/gamma" "$UP/.cursor-plugin" "$INSTALLED/local-skill" "${PIN%/*}"
for skill in alpha beta gamma; do echo "# $skill" >"$UP/skills/$skill/SKILL.md"; done
echo "reference" >"$UP/skills/beta/references/notes.md"
echo '{"name": "pstack", "version": "9.9.9", "license": "MIT"}' >"$UP/.cursor-plugin/plugin.json"
echo "*.log" >"$UP/.gitignore"
upstream_commit() { commit_all "$UP" "$1"; }
git -C "$UP" init -q && upstream_commit synthetic
cp -a "$UP/skills/alpha" "$UP/skills/beta" "$INSTALLED/"
echo "# local" >"$INSTALLED/local-skill/SKILL.md"
cp -r "$TOOLS" "${PIN%/*}/"
git_fixture "$WORK/pin-copy"
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
has "relock reports the moved skill" "Moved to pstack: alpha (was other)"
has "relock reports the added skill" "Added: beta"
no_receipt "relock writes no receipt"
pin_edit "pin['notInstalled'] = ['gamma']"
run "pstack-upstream passes on a matching pin and install" 0 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "pass counts the pinned skills" "2 pinned pstack skills match"
receipt_is "matching receipt is PASS" PASS 0
cp "$PIN/skills.lock.json" "$WORK/pin.saved"
pin_edit "pin['version'] = '9.9.8'"
run "a recorded version that differs from the revision fails" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the version mismatch" "plugin.json version is '9.9.9', provenance.pstack records '9.9.8'"
cp "$WORK/pin.saved" "$PIN/skills.lock.json"
pin_edit "lock['skills']['local-skill']['group'] = 'pstack'"
run "a skill pinned as pstack that the revision lacks fails" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the skill the revision lacks" "local-skill is pinned as pstack but is not in the pinned revision"
cp "$WORK/pin.saved" "$PIN/skills.lock.json"
pin_edit "lock['skills']['alpha']['sha256'] = '0' * 64"
run "a stale pinned hash fails" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the stale hash" "alpha: installed files match the revision but not the pinned sha256"
cp "$WORK/pin.saved" "$PIN/skills.lock.json"
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
mkdir -p "$WORK/empty-skills"
run "relock refuses a skills dir without the checkout's skills" 1 "$PIN/bootstrap" --relock --checkout "$UP" --skills-dir "$WORK/empty-skills"
has "refusal names the skills dir" "is installed in"
run "the pin survives the refused relocks" 0 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
cp "$PIN/skills.lock.json" "$WORK/pin.saved"
pin_edit "pin['revision'] = '$(git -C "$UP" rev-parse "HEAD^{tree}")'"
run "a recorded tree ID is not a commit" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the revision that is not a commit" "has no .cursor-plugin/plugin.json at"
cp "$WORK/pin.saved" "$PIN/skills.lock.json"
echo "# alpha 2" >"$UP/skills/alpha/SKILL.md"
upstream_commit "upstream moves on"
run "a later upstream HEAD still compares the pinned revision" 0 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
pinned_rev=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["provenance"]["pstack"]["revision"])' "$PIN/skills.lock.json")
git -C "$UP" replace "$pinned_rev" HEAD
cp "$UP/skills/alpha/SKILL.md" "$INSTALLED/alpha/SKILL.md"
run "plain relock pins the changed install" 0 "$PIN/bootstrap" --relock --skills-dir "$INSTALLED"
run "a replace ref cannot stand in for the pinned revision" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the file the replace ref changed" "alpha/SKILL.md differs"
git -C "$UP" replace -d "$pinned_rev" >/dev/null
cp "$PIN/skills.lock.json" "$WORK/pin.saved"
pin_edit "pin['revision'] = 'HEAD'"
run "a recorded revision that is not a commit ID fails" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the bad revision" "is not a full commit ID"
cp "$WORK/pin.saved" "$PIN/skills.lock.json"
pin_edit "pin['revision'] = '0' * 40"
run "a clone without the pinned revision fails" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the missing revision" "has no .cursor-plugin/plugin.json at 0000000000000000000000000000000000000000"
git -C "$UP" rm -rq skills/beta && upstream_commit "upstream drops beta"
cp "$UP/skills/alpha/SKILL.md" "$INSTALLED/alpha/SKILL.md"
run "relock refuses to drop a pin without --allow-drop" 1 "$PIN/bootstrap" --relock --checkout "$UP" --skills-dir "$INSTALLED"
has "refusal names the pin and the flag" "beta pinned as pstack but not installed skills of"
run "relock follows the checkout's HEAD with --allow-drop" 0 "$PIN/bootstrap" --relock --allow-drop --checkout "$UP" --skills-dir "$INSTALLED"
has "relock names the pins it removes" "Removed: beta"
has "relock notes the revision change" "HEAD differs from provenance.pstack.revision"

echo "# bootstrap is idempotent and removable in a fresh checkout"
FRESH="$WORK/fresh"
mkdir -p "$FRESH/scripts" "$FRESH/docs"
cp -r "$REPO/scripts/agent-tools" "$REPO/scripts/planning" "$FRESH/scripts/"
cp -r "$REPO/docs/plan" "$FRESH/docs/"
cp "$REPO/docs/delivery-plan.md" "$FRESH/docs/"
cp "$REPO/.gitignore" "$FRESH/"
git_fixture "$FRESH"
run "first bootstrap links" 0 "$FRESH/scripts/agent-tools/bootstrap"
has "first bootstrap reports linked" "linked ->"
receipt_is "bootstrap writes the receipt of its doctor run" PASS 0
run "verify list prints the capabilities" 0 "$FRESH/scripts/agent-tools/verify" list
no_receipt "verify list writes no receipt"
run "second bootstrap is a no-op" 0 "$FRESH/scripts/agent-tools/bootstrap"
has "second bootstrap reports unchanged" "unchanged ->"
mkdir -p "$WORK/other-skills"
ln -s "$(readlink "$FRESH/.local/agent-tools/skills")/poteto-mode" "$WORK/other-skills/poteto-mode"
run "conflicting bootstrap is refused" 1 "$FRESH/scripts/agent-tools/bootstrap" --skills-dir "$WORK/other-skills"
has "conflict explains the fix" "bootstrap --remove first"
no_receipt "a refused bootstrap writes no receipt"
if [[ -z $(git -C "$FRESH" status --porcelain) ]]; then ok "bootstrap leaves tracked files untouched"; else bad "bootstrap leaves tracked files untouched" "$(git -C "$FRESH" status --porcelain)"; fi
run "remove deletes only local state" 0 "$FRESH/scripts/agent-tools/bootstrap" --remove
no_receipt "bootstrap --remove writes no receipt"
if [[ ! -e $FRESH/.local/agent-tools ]]; then ok "local bootstrap state removed"; else bad "local bootstrap state removed"; fi

echo "# summary"
echo "$passed passed, $failed failed"
((failed == 0))
