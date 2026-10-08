#!/usr/bin/env bash
# Behavior tests for scripts/agent-tools. Needs bash, coreutils, git, python3, node and, for the cases where the
# doctor passes in this environment, Bun >= 1.4.2 on PATH or in CLEARCASE_BUN.
# Usage: bash tests/agent-tools/run.sh   (exit 0 only when every case passes)
set -u

HERE=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
TOOLS="$REPO/scripts/agent-tools"
cd "$REPO" || exit 1
FIXTURES="$HERE/fixtures"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cc27-agent-tools.XXXXXX")
trap 'chmod -R u+rwx "$WORK"; rm -rf "$WORK"' EXIT
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

# diff_hash : the diffSha256 of the one receipt in $RECEIPTS
diff_hash() {
	python3 -c 'import glob, json, sys; [f] = glob.glob(sys.argv[1] + "/*/receipt.json"); print(json.load(open(f))["revision"]["diffSha256"])' "$RECEIPTS"
}

# receipt_check NAME EXPRESSION : the Python EXPRESSION holds for every receipt r in $RECEIPTS
receipt_check() {
	if python3 - "$RECEIPTS" "$2" <<'EOF'
import glob, json, os, re, sys
files = sorted(glob.glob(os.path.join(sys.argv[1], "*", "receipt.json")))
sys.exit(not (files and all(eval(sys.argv[2], {"re": re}, {"r": json.load(open(f))}) for f in files)))
EOF
	then ok "$1"; else bad "$1" "not true of every receipt: $2" "$(tail -n 3 "$OUT")"; fi
}

# reason_has NAME TEXT : every receipt in $RECEIPTS gives a reason containing TEXT
reason_has() {
	receipt_check "$1" "$(printf '%s in (r["reason"] or "")' "$(python3 -c 'import sys; print(repr(sys.argv[1]))' "$2")")"
}

lacks_in_receipt() {
	if grep -qF -- "$2" "$RECEIPTS"/*/receipt.json; then bad "$1" "receipt has: $2"; else ok "$1"; fi
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
run "an empty --base is SKIPPED, not replaced by a default" 3 "$TOOLS/receipt" --name empty-base --base "" -- touch "$MARKER"
has "the empty base is named" "base '' does not resolve to a commit"
not_run "the command did not run with an empty --base"
run "an empty --base is not replaced by CLEARCASE_BASE_REF" 3 env CLEARCASE_BASE_REF="$repo_base" "$TOOLS/receipt" --name empty-over-env --base "" -- true
run "an empty CLEARCASE_BASE_REF is SKIPPED, not replaced by a default" 3 env CLEARCASE_BASE_REF= "$TOOLS/receipt" --name empty-env-base -- touch "$MARKER"
not_run "the command did not run with an empty CLEARCASE_BASE_REF"
run "an inherited GIT_DIR does not change the recorded revision" 0 env GIT_DIR="$WORK/tree-valid/.git" "$TOOLS/verify" plan-format --plan "$FIXTURES/plans/valid.md"
receipt_revision "receipt records this checkout despite GIT_DIR" "$repo_head" "$repo_base_ref" "$repo_base" "$repo_fork"
run "CLEARCASE_GIT does not replace the git that resolves the revision" 0 env CLEARCASE_GIT=/bin/false "$TOOLS/receipt" --name git-override -- true
lacks_in_receipt "the receipt lists the git on PATH" '"path": "/bin/false"'
IDREPO="$WORK/identity"
mkdir -p "$IDREPO/scripts" && cp -r "$TOOLS" "$IDREPO/scripts/"
git_fixture "$IDREPO"
fork=$(git -C "$IDREPO" rev-parse HEAD)
git -C "$IDREPO" checkout -q -b feature && echo feature >"$IDREPO/feature.txt" && commit_all "$IDREPO" feature
git -C "$IDREPO" checkout -q dev && echo later >"$IDREPO/dev.txt" && commit_all "$IDREPO" "dev moves on"
git -C "$IDREPO" checkout -q feature
id_head=$(git -C "$IDREPO" rev-parse HEAD) id_dev=$(git -C "$IDREPO" rev-parse dev)
run "a receipt in a checkout with dev passes" 0 env -C "$IDREPO" scripts/agent-tools/receipt --name identity -- true
receipt_is "identity receipt is PASS" PASS 0
receipt_revision "receipt records HEAD, dev and the fork point" "$id_head" dev "$id_dev" "$fork"
run "a receipt with --base COMMIT passes" 0 env -C "$IDREPO" scripts/agent-tools/receipt --name identity --base "$fork" -- true
receipt_revision "receipt records the explicit base commit" "$id_head" "$fork" "$fork" "$fork"
run "a receipt whose command runs outside the recorded checkout is SKIPPED" 3 "$IDREPO/scripts/agent-tools/receipt" --name elsewhere -- touch "$MARKER"
has "names the command's directory and the recorded checkout" "outside the checkout"
not_run "the command did not run outside the recorded checkout"
run "--root names the checkout the command runs in" 0 "$IDREPO/scripts/agent-tools/receipt" --name here --root "$REPO" -- true
receipt_revision "receipt records the checkout the command ran in" "$repo_head" "$repo_base_ref" "$repo_base" "$repo_fork"
run "a receipt from a subdirectory of the checkout passes" 0 env -C "$IDREPO/scripts" agent-tools/receipt --name subdirectory -- true
git init -q "$IDREPO/nested"
run "a receipt from a nested repository is SKIPPED" 3 env -C "$IDREPO/nested" ../scripts/agent-tools/receipt --name nested -- touch "$MARKER"
not_run "the command did not run in a nested repository"
echo untracked >"$IDREPO/ä.txt" && echo untracked >"$IDREPO/new"$'\n'"line.txt"
ln -s /nonexistent-cc27 "$IDREPO/broken-link" && ln -s "$WORK" "$IDREPO/dir-link"
run "odd untracked files are fingerprinted" 0 env -C "$IDREPO" scripts/agent-tools/receipt --name odd-files -- true
if python3 -c 'import glob,json,re,sys; r=[json.load(open(f))["revision"] for f in glob.glob(sys.argv[1] + "/*/receipt.json")]; sys.exit(not (r and all(x["dirty"] is True and re.fullmatch("[0-9a-f]{64}", x["diffSha256"] or "") for x in r)))' "$RECEIPTS"; then
	ok "odd untracked files make the receipt dirty with a diff hash"
else
	bad "odd untracked files make the receipt dirty with a diff hash"
fi
run "the doctor reports despite odd untracked files" 1 env -C "$IDREPO" scripts/agent-tools/doctor
has "the doctor's revision row notes the changes" "uncommitted changes"
rm -rf "$IDREPO/nested" "$IDREPO/ä.txt" "$IDREPO/new"$'\n'"line.txt" "$IDREPO/broken-link" "$IDREPO/dir-link"
git -C "$IDREPO" checkout -q --orphan unrelated && commit_all "$IDREPO" unrelated && git -C "$IDREPO" checkout -q feature
run "a base with no shared history is SKIPPED" 3 env -C "$IDREPO" scripts/agent-tools/receipt --name unrelated --base unrelated -- touch "$MARKER"
has "names the unrelated base" "shares no history with HEAD"
not_run "the command did not run with an unrelated base"
git -C "$IDREPO" branch -q -m dev trunk
run "no --base and no dev or origin/dev is SKIPPED" 3 env -C "$IDREPO" scripts/agent-tools/receipt --name no-base -- touch "$MARKER"
has "missing default base asks for --base" "no base revision: neither origin/dev nor dev exists"
receipt_is "no-base receipt is SKIPPED" SKIPPED 3
not_run "the command did not run without a base"
run "--base names the base when there is no default" 0 env -C "$IDREPO" scripts/agent-tools/receipt --name trunk-base --base trunk -- true
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
has "keeps git's own error" "exited 128: fatal: not a git repository"
receipt_is "outside receipt is SKIPPED" SKIPPED 3
not_run "the command did not run outside a checkout"

echo "# evidence that cannot be collected is never PASS"
# A disposable copy of the checkout whose Git data and files these cases damage and then restore.
EV="$WORK/evidence"
EVTOOLS="$EV/scripts/agent-tools"
mkdir -p "$EV/scripts" "$EV/docs" "$EV/tests/agent-tools/fixtures"
cp -r "$TOOLS" "$REPO/scripts/planning" "$EV/scripts/"
cp -r "$REPO/docs/plan" "$REPO/docs/delivery-plan.md" "$EV/docs/"
cp -r "$FIXTURES/plans" "$EV/tests/agent-tools/fixtures/"
cp "$REPO/.gitignore" "$EV/"
git_fixture "$EV"
EVPLAN="$EV/tests/agent-tools/fixtures/plans/valid.md"
READBACK="$WORK/tree-readback-valid/readback.json"
loose() { local id; id=$(git -C "$EV" rev-parse "$1") && echo "$EV/.git/objects/${id:0:2}/${id:2}"; }
run "the doctor passes in the copy" 0 "$EVTOOLS/doctor"
run "check-plan passes in the copy" 0 "$EVTOOLS/check-plan" --require-linear-relations --linear-relations "$READBACK"
echo "untracked synthetic input" >"$EV/untracked.txt"
run "an intact index records the untracked file" 0 "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
receipt_check "the intact-index receipt is dirty with a fingerprint" 'r["revision"]["dirty"] is True and re.fullmatch("[0-9a-f]{64}", r["revision"]["diffSha256"] or "")'
cp "$EV/.git/index" "$WORK/index.saved"
printf 'broken index\n' >"$EV/.git/index"
status_failed='`git status --porcelain` exited 128: fatal: .git/index: index file smaller than expected'
run "a corrupt index is SKIPPED by verify" 3 "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
receipt_is "corrupt-index verify receipt is SKIPPED" SKIPPED 3
reason_has "the verify receipt names the failed git status and its error" "working tree state unknown: $status_failed"
receipt_check "the corrupt-index receipt records no working-tree state" 'r["revision"]["dirty"] is None and r["revision"]["diffSha256"] is None'
run "a corrupt index fails the doctor" 1 "$EVTOOLS/doctor"
has "the doctor's revision row names the failed git status" "FAIL     revision       working tree state unknown: $status_failed"
receipt_is "corrupt-index doctor receipt is FAIL" FAIL 1
reason_has "the doctor receipt names the failed git status" "$status_failed"
run "a corrupt index is SKIPPED by receipt" 3 env -C "$EV" scripts/agent-tools/receipt --name corrupt-index -- touch "$MARKER"
reason_has "the receipt names the failed git status" "$status_failed"
not_run "the command did not run with a corrupt index"
run "a corrupt index fails check-plan with every step SKIPPED" 3 "$EVTOOLS/check-plan" --require-linear-relations --linear-relations "$READBACK"
has "check-plan names each skipped step" "check-plan: FAIL. plan-graph=SKIPPED, plan-format=SKIPPED, linear-relations=SKIPPED."
receipt_is "corrupt-index check-plan receipts are SKIPPED" SKIPPED 3
reason_has "every check-plan receipt names the failed git status" "$status_failed"
cp "$WORK/index.saved" "$EV/.git/index"
tree=$(loose "HEAD^{tree}") && mv "$tree" "$WORK/tree.saved"
run "an unreadable HEAD tree object is SKIPPED" 3 "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the failed git status and the bad tree" '`git status --porcelain` exited 128: error: bad tree object HEAD'
mv "$WORK/tree.saved" "$tree"
changed_file=tests/agent-tools/fixtures/plans/invalid.md
blob=$(loose "HEAD:$changed_file") && mv "$blob" "$WORK/blob.saved"
echo changed >>"$EV/$changed_file"
run "a changed file whose object is unreadable is SKIPPED" 3 env -C "$EV" scripts/agent-tools/receipt --name lost-blob -- touch "$MARKER"
reason_has "names the failed git diff" '`git diff --binary --no-ext-diff --no-textconv --no-color HEAD` exited 128: fatal: unable to read'
not_run "the command did not run without the changed file's object"
mv "$WORK/blob.saved" "$blob" && git -C "$EV" checkout -q -- "$changed_file"
chmod 000 "$EV/$changed_file"
run "an unreadable tracked file is SKIPPED" 3 "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the file git diff cannot hash" "cannot hash $changed_file"
chmod 644 "$EV/$changed_file"
head_object=$(loose HEAD) && mv "$head_object" "$WORK/commit.saved"
run "a HEAD whose commit object is unreadable is SKIPPED" 3 "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the commit HEAD names" "no head revision: HEAD names $(git -C "$EV" rev-parse HEAD), which is not a commit Git can read"
mv "$WORK/commit.saved" "$head_object"
dangling=$(git -C "$EV" -c user.name=t -c user.email=t@example.invalid commit-tree "HEAD^{tree}" -m dangling)
git -C "$EV" update-ref refs/remotes/origin/dev "$dangling" && rm "$(loose "$dangling")"
run "a default base naming an unreadable commit does not fall back to dev" 3 env -C "$EV" scripts/agent-tools/receipt --name broken-origin -- touch "$MARKER"
reason_has "names origin/dev and the commit it names" "base 'origin/dev' does not resolve to a commit in $EV: origin/dev names $dangling, which is not a commit Git can read"
not_run "the command did not run with a broken origin/dev"
git -C "$EV" update-ref -d refs/remotes/origin/dev
# two_states NAME FIRST SECOND : receipts in $EV taken after the shell commands FIRST and then SECOND record different
# fingerprints, so the fingerprint does not hide the change between them
two_states() {
	local first second
	eval "$2" && run "$1: first state" 0 env -C "$EV" scripts/agent-tools/receipt --name state -- true && first=$(diff_hash)
	eval "$3" && run "$1: second state" 0 env -C "$EV" scripts/agent-tools/receipt --name state -- true && second=$(diff_hash)
	if [[ ${first:-None} != None && $first != "${second:-}" ]]; then ok "$1: fingerprints differ"; else bad "$1: fingerprints differ" "${first:-} ${second:-}"; fi
}
git -C "$EV" config diff.external /bin/true
two_states "an external diff driver" "echo one >>'$EV/$changed_file'" "echo two >>'$EV/$changed_file'"
git -C "$EV" config --unset diff.external && git -C "$EV" checkout -q -- "$changed_file"
echo "*.md diff=lossy" >"$EV/.git/info/attributes" && git -C "$EV" config diff.lossy.textconv true
two_states "a textconv filter that prints nothing" "echo one >>'$EV/$changed_file'" "echo two >>'$EV/$changed_file'"
rm "$EV/.git/info/attributes" && git -C "$EV" config --remove-section diff.lossy && git -C "$EV" checkout -q -- "$changed_file"
git init -q "$EV/nested" && echo one >"$EV/nested/file.txt"
two_states "an untracked nested repository" ":" "echo two >'$EV/nested/file.txt'"
touch "$EV/nested/$(printf '\377').txt"
run "a nested repository with a file name that is not UTF-8 is fingerprinted" 0 env -C "$EV" scripts/agent-tools/receipt --name odd-nested -- true
receipt_check "the odd-name receipt is dirty with a fingerprint" 'r["revision"]["dirty"] is True and re.fullmatch("[0-9a-f]{64}", r["revision"]["diffSha256"] or "")'
rm -rf "$EV/nested"
git -C "$EV" update-index --assume-unchanged "$changed_file" && echo hidden >>"$EV/$changed_file"
run "a changed file marked assume-unchanged is SKIPPED" 3 env -C "$EV" scripts/agent-tools/receipt --name assumed -- touch "$MARKER"
reason_has "names the file git does not check" "git does not check 1 tracked files marked assume-unchanged or skip-worktree, for example $changed_file"
not_run "the command did not run with a file git does not check"
git -C "$EV" update-index --no-assume-unchanged "$changed_file" && git -C "$EV" checkout -q -- "$changed_file"
git -C "$EV" update-index --skip-worktree "$changed_file" && echo hidden >>"$EV/$changed_file"
run "a changed file marked skip-worktree is SKIPPED" 3 "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the skip-worktree file" "for example $changed_file"
git -C "$EV" update-index --no-skip-worktree "$changed_file" && git -C "$EV" checkout -q -- "$changed_file"
git -C "$EV" config status.showUntrackedFiles no
run "status.showUntrackedFiles=no does not hide an untracked file" 0 env -C "$EV" scripts/agent-tools/receipt --name hidden-untracked -- true
receipt_check "the receipt is dirty with a fingerprint" 'r["revision"]["dirty"] is True and re.fullmatch("[0-9a-f]{64}", r["revision"]["diffSha256"] or "")'
git -C "$EV" config --unset status.showUntrackedFiles
# The test git fails any call with the argument CC27_GIT_FAIL, prints "lie" for CC27_GIT_LIE, and deletes
# CC27_GIT_VANISH after an ls-files call has listed it. Otherwise it is the real git.
FAKEGIT="$WORK/bin-test-git"
mkdir -p "$FAKEGIT"
sed "s#@GIT@#$(command -v git)#" >"$FAKEGIT/git" <<'EOF'
#!/bin/bash
for arg; do
	[[ -n ${CC27_GIT_FAIL-} && $arg == "$CC27_GIT_FAIL" ]] && { echo "synthetic failure of $arg" >&2; exit 2; }
	[[ -n ${CC27_GIT_LIE-} && $arg == "$CC27_GIT_LIE" ]] && { echo lie; exit 0; }
done
if [[ -n ${CC27_GIT_VANISH-} && " $* " == *" ls-files "* ]]; then
	listing=$(mktemp)
	@GIT@ "$@" >"$listing"
	code=$?
	rm -f "$CC27_GIT_VANISH"
	cat "$listing" && rm -f "$listing"
	exit $code
fi
exec @GIT@ "$@"
EOF
chmod +x "$FAKEGIT/git"
run "a git status that fails is SKIPPED" 3 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=status "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the failed git status" '`git status --porcelain` exited 2: synthetic failure of status'
run "a git status that fails fails the doctor" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=status "$EVTOOLS/doctor"
has "the doctor names the failed git status" 'FAIL     revision       working tree state unknown: `git status'
run "a git diff that fails is SKIPPED" 3 env -C "$EV" PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=diff scripts/agent-tools/receipt --name failing-diff -- touch "$MARKER"
reason_has "names the failed git diff" '`git diff --binary --no-ext-diff --no-textconv --no-color HEAD` exited 2: synthetic failure of diff'
not_run "the command did not run when git diff failed"
run "a git ls-files that fails fails check-plan" 3 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=ls-files "$EVTOOLS/check-plan" --require-linear-relations --linear-relations "$READBACK"
receipt_is "failing ls-files check-plan receipts are SKIPPED" SKIPPED 3
reason_has "every step names the failed git ls-files" '`git ls-files -z --others --exclude-standard` exited 2: synthetic failure of ls-files'
run "a branch that cannot be read is SKIPPED" 3 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=--abbrev-ref "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the failed branch query" 'branch unknown: `git rev-parse --abbrev-ref HEAD` exited 2'
run "a head query that fails keeps git's error" 3 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL='HEAD^{commit}' "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the failed head query" 'no head revision: `git rev-parse --verify -q HEAD^{commit}` exited 2: synthetic failure of HEAD^{commit}'
run "a head that is not a commit ID is SKIPPED" 3 env PATH="$FAKEGIT:$PATH" CC27_GIT_LIE='HEAD^{commit}' "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names what git printed for HEAD" "git printed 'lie' for HEAD, not a commit ID"
run "a merge base that is not a commit ID is SKIPPED" 3 env PATH="$FAKEGIT:$PATH" CC27_GIT_LIE=merge-base "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names what git printed for the merge base" "no merge base: git printed 'lie', not a commit ID"
run "a git whose --version fails is SKIPPED" 3 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=--version "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the failed version probe" 'tool version unknown: `'"$FAKEGIT"'/git --version` exited 2: synthetic failure of --version'
run "a git whose --version fails fails the doctor" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=--version "$EVTOOLS/doctor"
has "the doctor names the git version probe" "git --version\` exited 2"
run "an untracked file that disappears after listing is SKIPPED" 3 env -C "$EV" PATH="$FAKEGIT:$PATH" CC27_GIT_VANISH="$EV/untracked.txt" scripts/agent-tools/receipt --name vanished -- touch "$MARKER"
reason_has "names the file that disappeared" "untracked $EV/untracked.txt: No such file or directory (listed by \`git ls-files --others\`, then not read)"
not_run "the command did not run without the untracked file's content"
echo "untracked synthetic input" >"$EV/untracked.txt" && chmod 000 "$EV/untracked.txt"
run "an unreadable untracked file is SKIPPED" 3 "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the unreadable untracked file" "untracked $EV/untracked.txt: Permission denied"
chmod 644 "$EV/untracked.txt"
mkdir "$EV/locked" && echo hidden >"$EV/locked/file.txt" && chmod 000 "$EV/locked"
run "an untracked directory git cannot open is SKIPPED, though git exits 0" 3 "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names git's warning" "\`git status --porcelain\` exited 0: warning: could not open directory 'locked/': Permission denied"
chmod 755 "$EV/locked" && rm -r "$EV/locked"
BADNODE="$WORK/node-without-version"
printf '#!/bin/bash\n[[ $1 == --version ]] && { echo "synthetic failure of node --version" >&2; exit 1; }\nexec %q "$@"\n' "$(command -v node)" >"$BADNODE"
chmod +x "$BADNODE"
run "a node whose --version fails is SKIPPED" 3 env CLEARCASE_NODE="$BADNODE" "$EVTOOLS/verify" plan-format --plan "$EVPLAN"
reason_has "names the failed node probe" 'node-without-version --version` exited 1: synthetic failure of node --version'
run "a node whose --version fails fails the doctor" 1 env CLEARCASE_NODE="$BADNODE" "$EVTOOLS/doctor"
has "the doctor names the failed node probe" "FAIL     node           \`$BADNODE --version\` exited 1"
BADPY="$WORK/python-without-version"
printf '#!/bin/bash\n[[ $1 == --version ]] && { echo "synthetic failure of python3 --version" >&2; exit 1; }\nexec %q "$@"\n' "$(command -v python3)" >"$BADPY"
chmod +x "$BADPY"
run "a python3 whose --version fails is SKIPPED" 3 env CLEARCASE_PYTHON="$BADPY" "$EVTOOLS/verify" plan-graph
reason_has "names the failed python3 probe" 'python-without-version --version` exited 1: synthetic failure of python3 --version'
run "a python3 whose --version fails fails the doctor" 1 env CLEARCASE_PYTHON="$BADPY" "$EVTOOLS/doctor"
has "the doctor names the failed python3 probe" "FAIL     python3        \`$BADPY --version\` exited 1"
ODD="$WORK/bin-odd-tools"
mkdir -p "$ODD"
printf '#!/bin/sh\nexit 0\n' >"$ODD/silent-tool"
printf '#!/nonexistent-interpreter-cc27\n' >"$ODD/broken-tool"
chmod +x "$ODD/silent-tool" "$ODD/broken-tool"
run "a --tool that prints no version is SKIPPED" 3 env -C "$EV" PATH="$ODD:$PATH" scripts/agent-tools/receipt --name silent --tool silent-tool -- touch "$MARKER"
reason_has "names the silent tool" "tool version unknown: \`$ODD/silent-tool\` printed no version"
not_run "the command did not run without the tool's version"
run "a --tool whose version probe cannot start is SKIPPED" 3 env -C "$EV" PATH="$ODD:$PATH" scripts/agent-tools/receipt --name broken --tool broken-tool -- touch "$MARKER"
reason_has "names the probe that did not run" "tool version unknown: \`$ODD/broken-tool --version\` did not run"
not_run "the command did not run when the version probe could not start"
git -C "$EV" update-index --assume-unchanged scripts/agent-tools/skills.lock.json && chmod 000 "$EVTOOLS/skills.lock.json"
run "the doctor fails on a lock it cannot read" 1 "$EVTOOLS/doctor"
has "the doctor names the unreadable lock" "FAIL     skill-pin      cannot read scripts/agent-tools/skills.lock.json"
has "the doctor names the receipt input it cannot fingerprint" "FAIL     receipt-input  input not fingerprinted: $EVTOOLS/skills.lock.json"
receipt_is "the unreadable-lock doctor receipt is FAIL" FAIL 1
chmod 644 "$EVTOOLS/skills.lock.json" && git -C "$EV" update-index --no-assume-unchanged scripts/agent-tools/skills.lock.json
run "the doctor fails when no wrapper reports its bash" 1 env -u CLEARCASE_BASH_VERSION python3 -I -B "$EVTOOLS/agent_tools.py" doctor
has "the doctor names the unknown bash" "unknown; the bash that runs the entry points is unknown or older than 4.4"
# assume-unchanged keeps git from rereading the file, so the planning row must find it unreadable on its own.
git -C "$EV" update-index --assume-unchanged scripts/planning/generate.py && chmod 000 "$EV/scripts/planning/generate.py"
run "the doctor fails on a planning script it cannot read" 1 "$EVTOOLS/doctor"
has "the doctor names the unreadable planning script" "FAIL     planning       scripts/planning/generate.py is missing or unreadable"
has "the doctor names the file git does not check" "git does not check 1 tracked files marked assume-unchanged or skip-worktree, for example scripts/planning/generate.py"
chmod 644 "$EV/scripts/planning/generate.py" && git -C "$EV" update-index --no-assume-unchanged scripts/planning/generate.py
echo input >"$WORK/unreadable-input.txt" && chmod 000 "$WORK/unreadable-input.txt"
run "an unreadable --input is SKIPPED" 3 env -C "$EV" scripts/agent-tools/receipt --name unreadable-input --input "$WORK/unreadable-input.txt" -- touch "$MARKER"
reason_has "names the unreadable input" "input not fingerprinted: $WORK/unreadable-input.txt: Permission denied"
not_run "the command did not run without its input's fingerprint"
cp "$EVPLAN" "$WORK/unreadable-plan.md" && chmod 000 "$WORK/unreadable-plan.md"
run "an unreadable plan is SKIPPED before the checker runs" 3 "$EVTOOLS/verify" plan-format --plan "$WORK/unreadable-plan.md"
reason_has "names the unreadable plan" "input not fingerprinted: $WORK/unreadable-plan.md: Permission denied"
run "an input that changes while it is read is SKIPPED" 3 env -C "$EV" scripts/agent-tools/receipt --name changing-input --input /proc/self/status -- touch "$MARKER"
reason_has "names the changed input" "input not fingerprinted: /proc/self/status: changed while it was read"
not_run "the command did not run with a changing input"
printf '#!/bin/sh\ntouch "$1"\n' >"$EV/not-executable.sh"
run "a command that cannot start is SKIPPED" 3 env -C "$EV" scripts/agent-tools/receipt --name no-exec -- ./not-executable.sh "$MARKER"
reason_has "names the command and the error" "the command did not start: ./not-executable.sh: Permission denied"
not_run "the command that cannot start did not run"
rm "$EV/not-executable.sh"
mkdir -p "$WORK/read-only" && chmod a-w "$WORK/read-only"
run "an unwritable receipt directory is SKIPPED" 3 env -C "$EV" scripts/agent-tools/receipt --receipts "$WORK/read-only/receipts" --name unwritable -- touch "$MARKER"
has "names the receipt directory" "cannot create its receipt directory: $WORK/read-only/receipts: Permission denied"
not_run "the command did not run without a receipt directory"
run "verify with an unwritable receipt directory is SKIPPED" 3 "$EVTOOLS/verify" plan-format --plan "$EVPLAN" --receipts "$WORK/read-only/receipts"
run "the doctor with an unwritable receipt directory fails" 1 "$EVTOOLS/doctor" --receipts "$WORK/read-only/receipts"
has "the doctor says its receipt was not written" "doctor: FAIL. Receipt not written"
run "a receipt directory that becomes unwritable during the run gives no PASS" 3 env -C "$EV" scripts/agent-tools/receipt --name locked-out -- bash -c 'chmod a-w "$CLEARCASE_RECEIPTS_DIR"/*'
has "names the receipt that was not written" "locked-out has no receipt:"
no_receipt "no receipt was written for the locked-out run"
chmod -R u+w "$RECEIPTS"
run "output that cannot be captured whole is not PASS" 3 env -C "$EV" bash -c 'ulimit -f 16 && exec scripts/agent-tools/receipt --name capture -- python3 -c "print(\"x\" * 100000)" >/dev/null'
receipt_is "the capture receipt is SKIPPED" SKIPPED 3
reason_has "names the capture file and the error" "stdout.txt: File too large; the command exited 0"
# Python exits 120 when it cannot flush stdout, so this case checks the receipt and the timeout instead of the exit.
n=$((n + 1)) RECEIPTS="$WORK/receipts-$n"
timeout 20 env -C "$EV" CLEARCASE_RECEIPTS_DIR="$RECEIPTS" scripts/agent-tools/receipt --name full-console -- python3 -c 'print("x" * 200000)' >/dev/full 2>/dev/null
if [[ $? != 124 ]]; then ok "a console that stops accepting output does not stall the command"; else bad "a console that stops accepting output does not stall the command"; fi
receipt_is "the receipt of a run whose console failed is PASS" PASS 0
if [[ $(cat "$RECEIPTS"/*/stdout.txt 2>/dev/null | wc -c) == 200001 ]]; then ok "the capture holds all the output the console missed"; else bad "the capture holds all the output the console missed"; fi

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
run "doctor fails on an empty --base" 1 "$TOOLS/doctor" --base ""
has "doctor names the empty base" "FAIL     revision       base '' does not resolve to a commit"
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

echo "# the doctor requires Bun at the app's minimum version"
# fake_bun NAME TEXT : $WORK/bun-NAME/bun prints TEXT for --version
fake_bun() { mkdir -p "$WORK/bun-$1" && printf '#!/bin/sh\necho %s\n' "'$2'" >"$WORK/bun-$1/bun" && chmod +x "$WORK/bun-$1/bun"; }
NOBUN="$WORK/bin-without-bun"
mkdir -p "$NOBUN"
for tool in python3 git node; do ln -s "$(command -v "$tool")" "$NOBUN/$tool"; done
run "doctor fails without bun" 1 env -u CLEARCASE_BUN PATH="$NOBUN" "$TOOLS/doctor"
has "doctor names the missing bun" "FAIL     bun            not found on PATH ($NOBUN)"
has "doctor gives the Bun install fix" "fix: install Bun >= 1.4.2 (pacman -S bun"
has "the missing bun is the only failure" "required checks passed, 1 failed."
receipt_is "no-bun doctor receipt is FAIL" FAIL 1
reason_has "the no-bun receipt names bun" "bun: not found on PATH"
fake_bun old 1.3.9
run "doctor fails on bun 1.3.9 on PATH" 1 env -u CLEARCASE_BUN PATH="$WORK/bun-old:$PATH" "$TOOLS/doctor"
has "doctor names the old bun and the minimum" "FAIL     bun            1.3.9 at $WORK/bun-old/bun is older than 1.4.2, the minimum from MIN_BUN"
has "doctor gives the upgrade fix" "fix: run bun upgrade --stable"
has "the old bun is the only failure" "required checks passed, 1 failed."
receipt_check "the old-bun receipt lists the bun it checked" 'any(t["name"] == "bun" and t["path"].endswith("/bun-old/bun") and t["version"] == "1.3.9" for t in r["tools"])'
fake_bun canary 1.4.2-canary.1+0a1b2c3
run "doctor fails on a prerelease of the minimum" 1 env -u CLEARCASE_BUN PATH="$WORK/bun-canary:$PATH" "$TOOLS/doctor"
has "names the prerelease" "1.4.2-canary.1+0a1b2c3 at $WORK/bun-canary/bun is older than 1.4.2"
fake_bun garbage "bun, version unknown"
run "doctor fails on a bun whose version cannot be parsed" 1 env -u CLEARCASE_BUN PATH="$WORK/bun-garbage:$PATH" "$TOOLS/doctor"
has "doctor names what bun printed" "\`$WORK/bun-garbage/bun --version\` printed 'bun, version unknown', not a version MAJOR.MINOR.PATCH"
fake_bun wrapped "9.9.9 from a wrapper"
run "doctor fails on a version line with other text" 1 env -u CLEARCASE_BUN PATH="$WORK/bun-wrapped:$PATH" "$TOOLS/doctor"
has "doctor does not read a version out of other text" "printed '9.9.9 from a wrapper', not a version MAJOR.MINOR.PATCH"
mkdir -p "$WORK/bun-failing"
printf '#!/bin/sh\necho "synthetic failure of bun --version" >&2\nexit 1\n' >"$WORK/bun-failing/bun" && chmod +x "$WORK/bun-failing/bun"
run "a bun whose --version fails fails the doctor" 1 env -u CLEARCASE_BUN PATH="$WORK/bun-failing:$PATH" "$TOOLS/doctor"
has "the doctor names the failed bun probe" "FAIL     bun            \`$WORK/bun-failing/bun --version\` exited 1: synthetic failure of bun --version"
fake_bun ok 1.4.2
run "doctor passes with bun 1.4.2 on PATH" 0 env -u CLEARCASE_BUN PATH="$WORK/bun-ok:$PATH" "$TOOLS/doctor"
has "the bun row passes at the minimum" "PASS     bun            1.4.2 at $WORK/bun-ok/bun; the app needs >= 1.4.2 (MIN_BUN"
receipt_is "the passing doctor receipt is PASS" PASS 0
fake_bun newer 1.10.0
run "doctor compares Bun versions as numbers" 0 env -u CLEARCASE_BUN PATH="$WORK/bun-newer:$PATH" "$TOOLS/doctor"
run "CLEARCASE_BUN finds a bun that is not on PATH" 0 env CLEARCASE_BUN="$WORK/bun-ok/bun" PATH="$NOBUN" "$TOOLS/doctor"
has "the doctor checks the bun CLEARCASE_BUN names" "PASS     bun            1.4.2 at $WORK/bun-ok/bun"
run "CLEARCASE_BUN wins over the bun on PATH" 1 env CLEARCASE_BUN="$WORK/bun-old/bun" PATH="$WORK/bun-ok:$PATH" "$TOOLS/doctor"
has "the doctor names the overriding bun" "1.3.9 at $WORK/bun-old/bun is older than 1.4.2"
run "a CLEARCASE_BUN that is not executable fails" 1 env CLEARCASE_BUN="$WORK/no-such-bun" "$TOOLS/doctor"
has "the doctor names the override" "FAIL     bun            CLEARCASE_BUN=$WORK/no-such-bun is not an executable file"
# In the disposable copy: packageManager in package.json replaces MIN_BUN, and a pin that cannot be read fails.
echo '{"packageManager": "bun@1.5.0"}' >"$EV/package.json"
run "package.json's packageManager raises the minimum" 1 env -u CLEARCASE_BUN PATH="$WORK/bun-ok:$PATH" "$EVTOOLS/doctor"
has "names the minimum package.json pins" "1.4.2 at $WORK/bun-ok/bun is older than 1.5.0, the minimum from packageManager in package.json"
has "the pinned minimum is the only failure" "required checks passed, 1 failed."
receipt_check "the doctor receipt fingerprints package.json" 'any(i["path"].endswith("/package.json") and i["sha256"] for i in r["inputs"])'
echo '{"packageManager": "bun@1.3.0+sha512.0a1b2c"}' >"$EV/package.json"
run "package.json's packageManager replaces MIN_BUN" 0 env -u CLEARCASE_BUN PATH="$WORK/bun-old:$PATH" "$EVTOOLS/doctor"
has "names package.json as the source" "PASS     bun            1.3.9 at $WORK/bun-old/bun; the app needs >= 1.3.0 (packageManager in package.json)"
echo '{"packageManager": "npm@10.9.0"}' >"$EV/package.json"
run "a packageManager that is not bun fails" 1 "$EVTOOLS/doctor"
has "names the packageManager" "FAIL     bun            package.json packageManager is 'npm@10.9.0', not bun@MAJOR.MINOR.PATCH"
has "gives the pin fix" 'fix: pin "packageManager": "bun@1.4.2" in package.json'
echo '{"name": "clearcase"}' >"$EV/package.json"
run "a package.json without packageManager fails" 1 "$EVTOOLS/doctor"
has "names the missing pin" "FAIL     bun            package.json packageManager is None"
echo '{' >"$EV/package.json"
run "a package.json that is not JSON fails" 1 "$EVTOOLS/doctor"
has "names the JSON error" "FAIL     bun            package.json is not JSON:"
rm "$EV/package.json" && ln -s "$WORK/no-such-package.json" "$EV/package.json"
run "a package.json that cannot be read fails" 1 "$EVTOOLS/doctor"
has "names the unreadable package.json" "FAIL     bun            cannot read $EV/package.json: No such file or directory"
rm "$EV/package.json"

echo "# the doctor flags a changed or missing pinned skill"
SKILLS=${CLEARCASE_SKILLS_DIR:-$HOME/.agents/skills}
PLANTED="$WORK/planted-skills"
mapfile -t pinned < <(python3 -c 'import json,sys; print("\n".join(sorted(json.load(open(sys.argv[1]))["skills"])))' "$TOOLS/skills.lock.json")
for name in "${pinned[@]}"; do mkdir -p "$PLANTED/$name" && cp -a "$SKILLS/$name/." "$PLANTED/$name/"; done
run "doctor passes on a copy of the pinned skills" 0 "$TOOLS/doctor" --skills-dir "$PLANTED"
changed=${pinned[0]} missing=${pinned[-1]}
mkdir "$PLANTED/$changed/unreadable" && chmod 000 "$PLANTED/$changed/unreadable"
run "doctor fails on a pinned skill with a directory it cannot read" 1 "$TOOLS/doctor" --skills-dir "$PLANTED"
has "doctor names the unreadable directory" "$changed cannot be hashed: $PLANTED/$changed/unreadable: Permission denied"
receipt_is "unreadable-skill doctor receipt is FAIL" FAIL 1
lacks "doctor reports no matching pin when a skill cannot be read" "skills match skills.lock.json"
chmod 755 "$PLANTED/$changed/unreadable" && rmdir "$PLANTED/$changed/unreadable"
mkfifo "$PLANTED/$changed/pipe"
run "doctor fails on a pinned skill holding a FIFO" 1 "$TOOLS/doctor" --skills-dir "$PLANTED"
has "doctor names the FIFO" "$changed cannot be hashed: $PLANTED/$changed/pipe: not a regular file"
rm "$PLANTED/$changed/pipe"
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
alpha_blob=$(git -C "$UP" rev-parse "$pinned_rev:skills/alpha/SKILL.md")
mv "$UP/.git/objects/${alpha_blob:0:2}/${alpha_blob:2}" "$WORK/alpha-blob.saved"
run "an unreadable object of the pinned revision fails" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the file whose object is missing" "cannot read skills/alpha/SKILL.md ($alpha_blob) from its Git objects: $alpha_blob missing"
mv "$WORK/alpha-blob.saved" "$UP/.git/objects/${alpha_blob:0:2}/${alpha_blob:2}"
git -C "$UP" replace "$pinned_rev" HEAD
cp "$UP/skills/alpha/SKILL.md" "$INSTALLED/alpha/SKILL.md"
run "plain relock pins the changed install" 0 "$PIN/bootstrap" --relock --skills-dir "$INSTALLED"
cp "$PIN/skills.lock.json" "$WORK/pin.saved"
chmod 000 "$INSTALLED/alpha/SKILL.md"
run "relock refuses an installed file it cannot read" 1 "$PIN/bootstrap" --relock --skills-dir "$INSTALLED"
has "refusal names the unreadable file" "bootstrap: FAIL. $INSTALLED/alpha/SKILL.md: Permission denied"
if cmp -s "$PIN/skills.lock.json" "$WORK/pin.saved"; then ok "a refused relock leaves the lock unchanged"; else bad "a refused relock leaves the lock unchanged"; fi
run "pstack-upstream fails on an installed file it cannot read" 1 "$PIN/verify" pstack-upstream --checkout "$UP" --skills-dir "$INSTALLED"
has "names the unreadable installed file" "alpha: installed files cannot be read: $INSTALLED/alpha/SKILL.md: Permission denied"
chmod 644 "$INSTALLED/alpha/SKILL.md"
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
has "keeps Git's error about the missing revision" "exited 128: fatal: Not a valid object name 0000000000000000000000000000000000000000^{commit}"
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
