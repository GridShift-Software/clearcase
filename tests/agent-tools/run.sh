#!/usr/bin/env bash
# Behavior tests for scripts/agent-tools. Needs bash, coreutils, git, python3, node and, for the cases where the
# doctor passes in this environment, Bun >= 1.4.2 on PATH or in CLEARCASE_BUN.
# Usage: bash tests/agent-tools/run.sh   (exit 0 only when every case passes)
set -u
# No inherited GIT_* variable (a Git hook exports GIT_DIR) may send the scratch repositories below to another repository.
# shellcheck disable=SC2046
unset $(compgen -e GIT_)

HERE=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
TOOLS="$REPO/scripts/agent-tools"
cd "$REPO" || exit 1
FIXTURES="$HERE/fixtures"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cc27-agent-tools.XXXXXX")
trap 'chmod -R u+rwx "$WORK"; rm -rf "$WORK"' EXIT
MARKER="$WORK/command-ran"
unset CLEARCASE_BASE_REF
# The doctor reports browser admission. An executable stub keeps every other case independent of the host's workspace;
# the cases that test admission unset or replace it.
BROWSER_LOCK_STUB="$WORK/browser-lock-stub"
printf '#!/bin/sh\nexec "$@"\n' >"$BROWSER_LOCK_STUB" && chmod +x "$BROWSER_LOCK_STUB"
export CLEARCASE_BROWSER_LOCK="$BROWSER_LOCK_STUB"
unset BROWSER_LOCK
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

# lacks NAME TEXT : $OUT, which must be readable, does not contain TEXT
lacks() {
	grep -qF -- "$2" "$OUT"
	case $? in 1) ok "$1" ;; 0) bad "$1" "output has: $2" ;; *) bad "$1" "cannot read $OUT" ;; esac
}

# receipt_is NAME RESULT EXIT : every receipt in $RECEIPTS has this result and exit code and every field.
# A PASS receipt must also list git and name the head, base and merge-base commits. The check's exit status is the
# verdict, so a receipt it cannot read fails with Python's error.
receipt_is() {
	local verdict
	if verdict=$(python3 - "$RECEIPTS" "$2" "$3" 2>&1 <<'EOF'
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
sys.exit("; ".join(problems) or None)
EOF
	); then ok "$1"; else bad "$1" "${verdict:-the receipt check exited nonzero}" "$RECEIPTS"; fi
}

# receipt_revision NAME HEAD BASE_REF BASE MERGE_BASE : every receipt in $RECEIPTS records exactly this revision
receipt_revision() {
	local verdict
	if verdict=$(python3 - "$RECEIPTS" "${@:2}" 2>&1 <<'EOF'
import glob, json, os, sys
files = sorted(glob.glob(os.path.join(sys.argv[1], "*", "receipt.json")))
problems = [] if files else ["no receipt"]
for file in files:
    revision = json.load(open(file))["revision"]
    for key, value in zip(["head", "baseRef", "base", "mergeBase"], sys.argv[2:]):
        if revision.get(key) != value: problems.append(f"{key} is {revision.get(key)!r}, expected {value!r}")
sys.exit("; ".join(problems) or None)
EOF
	); then ok "$1"; else bad "$1" "${verdict:-the receipt check exited nonzero}"; fi
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

# lacks_in_receipt NAME TEXT : the receipts in $RECEIPTS, of which there must be one, do not contain TEXT
lacks_in_receipt() {
	grep -qF -- "$2" "$RECEIPTS"/*/receipt.json
	case $? in 1) ok "$1" ;; 0) bad "$1" "receipt has: $2" ;; *) bad "$1" "no receipt to read in $RECEIPTS" ;; esac
}

# not_run NAME : the wrapped command, which creates $MARKER, did not run
not_run() {
	if [[ -e $MARKER ]]; then bad "$1" "the command ran"; rm -f "$MARKER"; else ok "$1"; fi
}

# fails_on NAME TEXT WANT HELPER ARGS... : HELPER ARGS, run in a subshell with $RECEIPTS holding one receipt.json
# whose content is TEXT, or none for -, counts exactly one failure and shows WANT. So a receipt an assertion cannot
# read fails it, and the failure keeps the reason.
fails_on() {
	local saved=$RECEIPTS verdict
	RECEIPTS="$WORK/helper-check-$((++n))"
	mkdir -p "$RECEIPTS/only"
	[[ $2 == - ]] || printf '%s\n' "$2" >"$RECEIPTS/only/receipt.json"
	verdict=$("${@:4}" 2>&1; echo "failed=$failed")
	RECEIPTS=$saved
	if [[ $verdict == *"failed=$((failed + 1))" && $verdict == *"$3"* ]]; then ok "$1"; else bad "$1" "$verdict"; fi
}

echo "# the receipt assertions fail on receipts they cannot read"
RECEIPTS= OUT=/dev/null
fails_on "receipt_is fails on a receipt that is not JSON" '{' JSONDecodeError receipt_is malformed PASS 0
fails_on "receipt_is fails on a receipt without its fields" '{}' "KeyError: 'result'" receipt_is incomplete PASS 0
fails_on "receipt_revision fails on a receipt that is not JSON" '{' JSONDecodeError receipt_revision malformed a b c d
fails_on "receipt_revision fails on a receipt without a revision" '{}' "KeyError: 'revision'" receipt_revision incomplete a b c d
fails_on "receipt_check fails on a receipt that is not JSON" '{' JSONDecodeError receipt_check malformed True
fails_on "lacks_in_receipt fails without a receipt to read" - "no receipt to read" lacks_in_receipt absent anything
OUT="$WORK/no-such-output" fails_on "lacks fails on output it cannot read" - "cannot read" lacks unreadable anything

echo "# pstack check-plan.mjs fixtures through verify pstack-plan-format"
repo_base_ref=
for ref in origin/dev dev; do
	repo_base=$(git -C "$REPO" rev-parse --verify -q "$ref^{commit}") && repo_base_ref=$ref && break
done
repo_head=$(git -C "$REPO" rev-parse HEAD)
repo_fork=$(git -C "$REPO" merge-base HEAD "$repo_base")
run "valid plan passes" 0 "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
has "valid plan reports zero problems" "1 PR sections, 0 problems"
receipt_is "valid plan receipt is PASS" PASS 0
receipt_check "valid plan receipt records each input's identity" 'all(re.fullmatch("[0-9a-f]{64}", i["sha256"]) and all(type(i[key]) is int for key in ("size", "mtimeNs", "device", "inode")) for i in r["inputs"])'
receipt_revision "valid plan receipt records this checkout's head and default base" "$repo_head" "$repo_base_ref" "$repo_base" "$repo_fork"
short_base=$(git -C "$REPO" rev-parse --short "$repo_base")
run "valid plan passes with an explicit short --base" 0 "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md" --base "$short_base"
receipt_revision "explicit --base is recorded as given and resolved to its full commit" "$repo_head" "$short_base" "$repo_base" "$repo_fork"
run "invalid plan fails with the checker's own exit code" 1 "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/invalid.md"
for message in "long dash" 'How to read this lacks "One box is one unit of work"' "lanes are [1,2,3,4,5,6,7,8,9,11]" "perf boxes are [Metric., Probe., Baseline.]"; do
	has "invalid plan diagnoses: $message" "$message"
done
receipt_is "invalid plan receipt is FAIL" FAIL 1
if grep -qF "long dash" "$(compgen -G "$RECEIPTS/*/stderr.txt")"; then ok "checker stderr preserved in receipt"; else bad "checker stderr preserved in receipt"; fi
run "pstack-plan-format without --plan fails instead of judging the delivery plan" 1 "$TOOLS/verify" pstack-plan-format
reason_has "the missing plan names the option and the project check" "--plan PATH (docs/delivery-plan.md is checked by plan-format)"

echo "# planning fixtures through verify plan-graph / plan-format / linear-relations"
# fixture_list FIXTURE KEY : the strings in the fixture's expect.KEY, one per line
fixture_list() { python3 -c 'import json,sys; [print(m) for m in json.load(open(sys.argv[1]))["expect"].get(sys.argv[2], [])]' "$1" "$2"; }
for fixture in "$FIXTURES"/graph/*.json; do
	name=$(basename "$fixture" .json)
	tree="$WORK/tree-$name"
	python3 "$HERE/make_tree.py" "$REPO" "$tree" "$fixture" && git_fixture "$tree" || { bad "$name: build fixture tree"; continue; }
	read -r capability expected < <(python3 -c 'import json,sys; f=json.load(open(sys.argv[1])); print(f["capability"], f["expect"]["exit"])' "$fixture")
	args=("$TOOLS/verify" "$capability" --root "$tree")
	[[ $capability == linear-relations ]] && args+=(--readback "$tree/readback.json")
	run "graph $name" "$expected" "${args[@]}"
	while IFS= read -r message; do has "graph $name diagnoses: $message" "$message"; done < <(fixture_list "$fixture" output)
	while IFS= read -r message; do lacks "graph $name omits: $message" "$message"; done < <(fixture_list "$fixture" absent)
	[[ $expected == 0 ]] || lacks "graph $name does not print PASS" "PASS"
	# a negative fixture must fail for its own cause: every finding line is one the fixture names
	unexpected=$(grep -vF -e "receipt: " -e "spend: " -e "Compared the Linear readback" -e "HOLD: " "$OUT" | grep -vE '^$|^plan-format: FAIL\. [0-9]+ findings? in ' | grep -vFf <(fixture_list "$fixture" output))
	if [[ -z $unexpected ]]; then ok "graph $name reports only the expected findings"; else bad "graph $name reports a finding the fixture does not name" "$unexpected"; fi
	receipt_is "graph $name receipt" "$([[ $expected == 0 ]] && echo PASS || echo FAIL)" "$expected"
done

echo "# verify app and the app/browser doctor rows, in a clean checkout without node_modules"
# A git archive of HEAD with this checkout's agent tools and verify-clearcase skill over it, committed in a scratch
# repository: no install, no build.
APPC="$WORK/app-clean"
mkdir -p "$APPC" && git -C "$REPO" archive --format=tar HEAD | tar -x -C "$APPC"
RUNNER=.agents/skills/verify-clearcase/bin/verify-clearcase
rm -rf "$APPC/.agents/skills/verify-clearcase" && mkdir -p "$APPC/.agents/skills" && cp -a "$REPO/.agents/skills/verify-clearcase" "$APPC/.agents/skills/"
cp -a "$TOOLS/." "$APPC/scripts/agent-tools/"
git_fixture "$APPC"
run "the doctor passes before install and build" 0 "$APPC/scripts/agent-tools/doctor"
for row in "PASS     app-unshare    unshare from util-linux" "PASS     app-ip         ip utility" "PASS     app-chromium" "PASS     app-runner     $RUNNER is executable"; do
	has "the doctor checks ${row:9:12}" "$row"
done
lacks "the doctor defers nothing" "DEFERRED"
run "verify app without node_modules stops at the runner's preflight" 3 env CLEARCASE_REPORT_DIR="$WORK/app-clean-report" "$APPC/scripts/agent-tools/verify" app
has "names the missing node_modules and the install command" "node_modules is missing (a clean checkout has no installed dependencies); fix: cd $APPC && bun install --frozen-lockfile"
has "says nothing was built, started or contacted" "Nothing was built, started or contacted"
receipt_check "the receipt keeps the runner's exit 3 and lists bun" 'r["result"] == "FAIL" and r["exitCode"] == 3 and any(t["name"] == "bun" and t["path"] for t in r["tools"])'
if python3 -c 'import glob,json,sys; [f] = glob.glob(sys.argv[1] + "/skill/*/summary.json"); s = json.load(open(f)); sys.exit(not (s["result"] == "SKIPPED" and [x["status"] for x in s["steps"]] == ["SKIPPED", "NOT RUN", "NOT RUN", "NOT RUN"]))' "$WORK/app-clean-report" && [[ ! -e $APPC/.local/verify-clearcase-scratch && ! -e $APPC/node_modules ]]; then
	ok "the runner's evidence shows only its preflight ran, and it left no scratch"
else
	bad "the runner's evidence shows only its preflight ran, and it left no scratch"
fi
chmod -x "$APPC/$RUNNER"
run "verify app with a runner that is not executable is SKIPPED" 3 "$APPC/scripts/agent-tools/verify" app
reason_has "names the runner" "$RUNNER is missing or not executable"
receipt_is "the no-runner receipt is SKIPPED" SKIPPED 3
run "the doctor fails on a runner that is not executable" 1 "$APPC/scripts/agent-tools/doctor"
has "names the runner and the fix" "FAIL     app-runner     $RUNNER is missing or not executable"
has "the runner is the only failure" "required checks passed, 1 failed."
chmod +x "$APPC/$RUNNER"
run "the doctor fails without Chromium" 1 env CLEARCASE_CHROMIUM="$WORK/no-such-chromium" "$APPC/scripts/agent-tools/doctor"
has "names the Chromium it looked for" "FAIL     app-chromium   $WORK/no-such-chromium is not an executable file"
has "gives the Chromium fix" "fix: run scripts/ci/install-chrome.sh, which installs CI's checksum-pinned Chrome for Testing at ~/.cache/ms-playwright/chromium-1223, or set CLEARCASE_CHROMIUM to a Chromium binary"
has "the missing Chromium is the only failure" "required checks passed, 1 failed."
mkdir -p "$WORK/bin-no-userns"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "unshare from util-linux 2.42.4"; exit 0; }\necho "unshare: unshare failed: Operation not permitted" >&2\nexit 1\n' >"$WORK/bin-no-userns/unshare"
chmod +x "$WORK/bin-no-userns/unshare"
run "the doctor fails when user and network namespaces are unavailable" 1 env PATH="$WORK/bin-no-userns:$PATH" "$APPC/scripts/agent-tools/doctor"
has "names the failed unshare -rn" "unprivileged user and network namespaces are unavailable"
has "the namespaces are the only failure" "required checks passed, 1 failed."
run "the verify-clearcase self-test passes" 0 env CLEARCASE_REPORT_DIR="$WORK/self-test-report" VERIFY_CLEARCASE_SCRATCH="$WORK/self-test-scratch" "$REPO/$RUNNER" self-test
has "the self-test covers the clean checkout" "PASS     clean checkout: preflight stops with the install command (exit 3), no build, no browser, no bun install"
has "the self-test covers a wrong-build instance" "PASS     live doctor, another build (buildId): FAIL on build.buildId"
has "the self-test covers another data directory" "PASS     live doctor, another data directory: FAIL on dataDir"

echo "# required failures are never suppressed"
run "required Linear comparison without a readback fails" 3 "$TOOLS/check-plan" --require-linear-relations
has "check-plan reports the skipped comparison" "linear-relations=SKIPPED"
has "check-plan overall verdict is FAIL" "check-plan: FAIL"
run "missing command is SKIPPED, not PASS" 3 "$TOOLS/receipt" --name missing -- definitely-not-a-command-cc27
receipt_is "missing command receipt" SKIPPED 3

echo "# receipts record the exact revision and never PASS without it"
NOGIT="$WORK/bin-without-git"
mkdir -p "$NOGIT"
for tool in python3 node; do ln -s "$(command -v "$tool")" "$NOGIT/$tool"; done
run "pstack-plan-format without git is FAIL" 1 env PATH="$NOGIT" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md" --base "$repo_base"
has "missing git is named with the fix" "required tool not found: git; install it or put it on PATH"
receipt_is "no-git pstack-plan-format receipt is FAIL" FAIL 1
valid_tree="$WORK/tree-readback-valid"
run "check-plan without git fails with no PASS" 3 env PATH="$NOGIT" "$TOOLS/check-plan" --root "$valid_tree" --require-linear-relations --linear-relations "$valid_tree/readback.json"
has "no-git check-plan names each unavailable or failed step" "check-plan: FAIL. plan-graph=SKIPPED, plan-format=FAIL, linear-relations=SKIPPED."
receipt_check "no-git required format fails; other unavailable checks remain SKIPPED" 'r["result"] == ("FAIL" if r["name"] == "plan-format" else "SKIPPED") and r["exitCode"] == (1 if r["name"] == "plan-format" else 3)'
run "receipt without git does not run the command" 3 env PATH="$NOGIT" "$TOOLS/receipt" --name no-git -- python3 -c "open('$MARKER', 'w')"
not_run "the command did not run without git"
run "an unresolvable --base is FAIL" 1 "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md" --base no-such-base-cc27
has "the bad base is named with the fix" "base 'no-such-base-cc27' does not resolve to a commit"
receipt_is "bad-base receipt is FAIL" FAIL 1
run "an unresolvable CLEARCASE_BASE_REF is not replaced by a default" 3 env CLEARCASE_BASE_REF=no-such-base-cc27 "$TOOLS/receipt" --name bad-env-base -- touch "$MARKER"
not_run "the command did not run with a bad base"
run "an empty --base is SKIPPED, not replaced by a default" 3 "$TOOLS/receipt" --name empty-base --base "" -- touch "$MARKER"
has "the empty base is named" "base '' does not resolve to a commit"
not_run "the command did not run with an empty --base"
run "an empty --base is not replaced by CLEARCASE_BASE_REF" 3 env CLEARCASE_BASE_REF="$repo_base" "$TOOLS/receipt" --name empty-over-env --base "" -- true
run "an empty CLEARCASE_BASE_REF is SKIPPED, not replaced by a default" 3 env CLEARCASE_BASE_REF= "$TOOLS/receipt" --name empty-env-base -- touch "$MARKER"
not_run "the command did not run with an empty CLEARCASE_BASE_REF"
run "an inherited GIT_DIR does not change the recorded revision" 0 env GIT_DIR="$WORK/tree-valid/.git" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
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
cp -a "$REPO/.agents" "$EV/"
git_fixture "$EV"
EVPLAN="$EV/tests/agent-tools/fixtures/plans/valid.md"
READBACK="$WORK/tree-readback-valid/readback.json"
loose() { local id; id=$(git -C "$EV" rev-parse "$1") && echo "$EV/.git/objects/${id:0:2}/${id:2}"; }
run "the doctor passes in the copy" 0 "$EVTOOLS/doctor"
run "check-plan passes the real generated delivery plan in the copy" 0 "$EVTOOLS/check-plan" --require-linear-relations --linear-relations "$READBACK"
has "the composite verdict is PASS with every step PASS" "check-plan: PASS. plan-graph=PASS, plan-format=PASS, linear-relations=PASS."
has "the format step names the project contract it checked" "follows the generated delivery-plan contract"
lacks "check-plan does not run pstack's generic plan format" "verify-perf="
# A plan in pstack's generic multi-phase format is not this project's plan, however valid it is there.
run "check-plan rejects a plan in pstack's generic format" 1 "$EVTOOLS/check-plan" --plan "$EVTOOLS/../../tests/agent-tools/fixtures/plans/valid.md" --require-linear-relations --linear-relations "$READBACK"
has "the generic plan fails only the format step" "check-plan: FAIL. plan-graph=PASS, plan-format=FAIL, linear-relations=PASS."
has "the generic plan is named for its missing sections" "sections after the intro are"
echo "untracked synthetic input" >"$EV/untracked.txt"
run "an intact index records the untracked file" 0 "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
receipt_check "the intact-index receipt is dirty with a fingerprint" 'r["revision"]["dirty"] is True and re.fullmatch("[0-9a-f]{64}", r["revision"]["diffSha256"] or "")'
cp "$EV/.git/index" "$WORK/index.saved"
printf 'broken index\n' >"$EV/.git/index"
status_failed='`git status --porcelain` exited 128: fatal: .git/index: index file smaller than expected'
run "a corrupt index is FAIL by verify" 1 "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
receipt_is "corrupt-index verify receipt is FAIL" FAIL 1
reason_has "the verify receipt names the failed git status and its error" "working tree state unknown: $status_failed"
receipt_check "the corrupt-index receipt records no working-tree state" 'r["revision"]["dirty"] is None and r["revision"]["diffSha256"] is None'
run "a corrupt index fails the doctor" 1 "$EVTOOLS/doctor"
has "the doctor's revision row names the failed git status" "FAIL     revision       working tree state unknown: $status_failed"
receipt_is "corrupt-index doctor receipt is FAIL" FAIL 1
reason_has "the doctor receipt names the failed git status" "$status_failed"
run "a corrupt index is SKIPPED by receipt" 3 env -C "$EV" scripts/agent-tools/receipt --name corrupt-index -- touch "$MARKER"
reason_has "the receipt names the failed git status" "$status_failed"
not_run "the command did not run with a corrupt index"
run "a corrupt index fails check-plan with no PASS" 3 "$EVTOOLS/check-plan" --require-linear-relations --linear-relations "$READBACK"
has "check-plan names each unavailable or failed step" "check-plan: FAIL. plan-graph=SKIPPED, plan-format=FAIL, linear-relations=SKIPPED."
receipt_check "corrupt-index required format fails; no receipt is PASS" 'r["result"] == ("FAIL" if r["name"] == "plan-format" else "SKIPPED") and r["exitCode"] == (1 if r["name"] == "plan-format" else 3)'
reason_has "every check-plan receipt names the failed git status" "$status_failed"
cp "$WORK/index.saved" "$EV/.git/index"
tree=$(loose "HEAD^{tree}") && mv "$tree" "$WORK/tree.saved"
run "an unreadable HEAD tree object is FAIL" 1 "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
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
run "an unreadable tracked file is FAIL" 1 "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
reason_has "names the file git diff cannot hash" "cannot hash $changed_file"
chmod 644 "$EV/$changed_file"
head_object=$(loose HEAD) && mv "$head_object" "$WORK/commit.saved"
run "a HEAD whose commit object is unreadable is FAIL" 1 "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
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
run "a changed file marked skip-worktree is FAIL" 1 "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
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
run "a git status that fails is FAIL" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=status "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
reason_has "names the failed git status" '`git status --porcelain` exited 2: synthetic failure of status'
run "a git status that fails fails the doctor" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=status "$EVTOOLS/doctor"
has "the doctor names the failed git status" 'FAIL     revision       working tree state unknown: `git status'
run "a git diff that fails is SKIPPED" 3 env -C "$EV" PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=diff scripts/agent-tools/receipt --name failing-diff -- touch "$MARKER"
reason_has "names the failed git diff" '`git diff --binary --no-ext-diff --no-textconv --no-color HEAD` exited 2: synthetic failure of diff'
not_run "the command did not run when git diff failed"
run "a git ls-files that fails fails check-plan" 3 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=ls-files "$EVTOOLS/check-plan" --require-linear-relations --linear-relations "$READBACK"
receipt_check "failing ls-files required format fails; other steps are unavailable" 'r["result"] == ("FAIL" if r["name"] == "plan-format" else "SKIPPED") and r["exitCode"] == (1 if r["name"] == "plan-format" else 3)'
reason_has "every step names the failed git ls-files" '`git ls-files -z --others --exclude-standard` exited 2: synthetic failure of ls-files'
run "a branch that cannot be read is FAIL" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=--abbrev-ref "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
reason_has "names the failed branch query" 'branch unknown: `git rev-parse --abbrev-ref HEAD` exited 2'
run "a head query that fails keeps git's error" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL='HEAD^{commit}' "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
reason_has "names the failed head query" 'no head revision: `git rev-parse --verify -q HEAD^{commit}` exited 2: synthetic failure of HEAD^{commit}'
run "a head that is not a commit ID is FAIL" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_LIE='HEAD^{commit}' "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
reason_has "names what git printed for HEAD" "git printed 'lie' for HEAD, not a commit ID"
run "a merge base that is not a commit ID is FAIL" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_LIE=merge-base "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
reason_has "names what git printed for the merge base" "no merge base: git printed 'lie', not a commit ID"
run "a git whose --version fails is FAIL" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=--version "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
reason_has "names the failed version probe" 'tool version unknown: `'"$FAKEGIT"'/git --version` exited 2: synthetic failure of --version'
run "a git whose --version fails fails the doctor" 1 env PATH="$FAKEGIT:$PATH" CC27_GIT_FAIL=--version "$EVTOOLS/doctor"
has "the doctor names the git version probe" "git --version\` exited 2"
run "an untracked file that disappears after listing is SKIPPED" 3 env -C "$EV" PATH="$FAKEGIT:$PATH" CC27_GIT_VANISH="$EV/untracked.txt" scripts/agent-tools/receipt --name vanished -- touch "$MARKER"
reason_has "names the file that disappeared" "untracked $EV/untracked.txt: No such file or directory (listed by \`git ls-files --others\`, then not read)"
not_run "the command did not run without the untracked file's content"
echo "untracked synthetic input" >"$EV/untracked.txt" && chmod 000 "$EV/untracked.txt"
run "an unreadable untracked file is FAIL" 1 "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
reason_has "names the unreadable untracked file" "untracked $EV/untracked.txt: Permission denied"
chmod 644 "$EV/untracked.txt"
mkdir "$EV/locked" && echo hidden >"$EV/locked/file.txt" && chmod 000 "$EV/locked"
run "an untracked directory git cannot open is FAIL, though git exits 0" 1 "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
reason_has "names git's warning" "\`git status --porcelain\` exited 0: warning: could not open directory 'locked/': Permission denied"
chmod 755 "$EV/locked" && rm -r "$EV/locked"
BADNODE="$WORK/node-without-version"
printf '#!/bin/bash\n[[ $1 == --version ]] && { echo "synthetic failure of node --version" >&2; exit 1; }\nexec %q "$@"\n' "$(command -v node)" >"$BADNODE"
chmod +x "$BADNODE"
run "a node whose --version fails is FAIL" 1 env CLEARCASE_NODE="$BADNODE" "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN"
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
run "an unreadable plan is FAIL before the checker runs" 1 "$EVTOOLS/verify" pstack-plan-format --plan "$WORK/unreadable-plan.md"
reason_has "names the unreadable plan" "input not fingerprinted: $WORK/unreadable-plan.md: Permission denied"
run "an input that changes while it is read is SKIPPED" 3 env -C "$EV" scripts/agent-tools/receipt --name changing-input --input /proc/self/status -- touch "$MARKER"
reason_has "names the changed input" "input not fingerprinted: /proc/self/status: changed while it was read"
not_run "the command did not run with a changing input"
# A test node renames a valid plan over the invalid one it is given, then checks it, so the checker passes bytes
# other than those fingerprinted before the run, as when the review replaced the plan atomically during hashing.
cp "$FIXTURES/plans/invalid.md" "$WORK/replaced-plan.md" && cp "$FIXTURES/plans/valid.md" "$WORK/replacement-plan.md"
SWAPNODE="$WORK/node-replacing-the-plan"
printf '#!/bin/bash\n[[ $1 == --version ]] || mv %q "$2"\nexec %q "$@"\n' "$WORK/replacement-plan.md" "$(command -v node)" >"$SWAPNODE"
chmod +x "$SWAPNODE"
invalid_sha=$(sha256sum <"$WORK/replaced-plan.md") && invalid_sha=${invalid_sha%% *}
run "a plan replaced while the checker runs is not PASS" 1 env CLEARCASE_NODE="$SWAPNODE" "$EVTOOLS/verify" pstack-plan-format --plan "$WORK/replaced-plan.md"
has "the checker passed the replacement" "1 PR sections, 0 problems"
receipt_is "the replaced-plan receipt is FAIL" FAIL 1
reason_has "names the replaced plan and how it changed" "input changed during the run: $WORK/replaced-plan.md: sha256 ${invalid_sha:0:12} -> "
receipt_check "the receipt keeps the plan's identity from before the run" "any(i['path'].endswith('/replaced-plan.md') and i['sha256'] == '$invalid_sha' for i in r['inputs'])"
echo input >"$WORK/changed-input.txt"
run "an input changed in place during the run is not PASS" 5 env -C "$EV" scripts/agent-tools/receipt --name changed-input --input "$WORK/changed-input.txt" -- bash -c 'echo more >>"$1"; exit 5' _ "$WORK/changed-input.txt"
receipt_is "a failing command whose input changed keeps its FAIL and exit code" FAIL 5
reason_has "names the changed input" "input changed during the run: $WORK/changed-input.txt: sha256 "
echo input >"$WORK/relinked-input.txt"
run "an input replaced by a copy of its bytes during the run is not PASS" 1 env -C "$EV" scripts/agent-tools/receipt --name relinked-input --input "$WORK/relinked-input.txt" -- bash -c 'cp -p "$1" "$1.new" && mv "$1.new" "$1"' _ "$WORK/relinked-input.txt"
receipt_check "names the new inode of the same bytes" '"relinked-input.txt: " in r["reason"] and "inode " in r["reason"] and "sha256 " not in r["reason"]'
echo input >"$WORK/removed-input.txt"
run "an input removed during the run is not PASS" 1 env -C "$EV" scripts/agent-tools/receipt --name removed-input --input "$WORK/removed-input.txt" -- rm "$WORK/removed-input.txt"
reason_has "names the removed input" "input changed during the run: $WORK/removed-input.txt: No such file or directory"
run "a tracked file changed during the run is not PASS" 1 env -C "$EV" scripts/agent-tools/receipt --name edits-checkout -- bash -c 'echo changed >>docs/delivery-plan.md'
reason_has "names the working tree that changed" "the checkout changed during the run: diffSha256 "
git -C "$EV" checkout -q -- docs/delivery-plan.md
run "a commit during the run is not PASS" 1 env -C "$EV" scripts/agent-tools/receipt --name commits -- git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m during
reason_has "names the head that moved" "the checkout changed during the run: head $(git -C "$EV" rev-parse HEAD~1) -> $(git -C "$EV" rev-parse HEAD)"
git -C "$EV" reset -q --soft HEAD~1
cp "$EV/.git/index" "$WORK/index.saved"
run "a revision that cannot be read after the run is not PASS" 1 env -C "$EV" scripts/agent-tools/receipt --name breaks-index -- bash -c 'printf "broken index\n" >.git/index'
reason_has "names the git status that failed after the run" "the revision cannot be read after the run: working tree state unknown: $status_failed"
cp "$WORK/index.saved" "$EV/.git/index"
# The test tmux runs the shell command CC27_TMUX_DOES. The doctor probes tmux after its first look at the revision and
# its skill checks, and before it looks at the revision again, so the change lands between the two looks every time.
mkdir -p "$WORK/bin-tmux-does"
printf '#!/bin/bash\neval "$CC27_TMUX_DOES"\necho "tmux 3.7"\n' >"$WORK/bin-tmux-does/tmux" && chmod +x "$WORK/bin-tmux-does/tmux"
run "a tracked file changed during the doctor's run fails the doctor" 1 env PATH="$WORK/bin-tmux-does:$PATH" CC27_TMUX_DOES="echo changed >>'$EV/docs/delivery-plan.md'" "$EVTOOLS/doctor"
has "the doctor names the working tree that changed" "FAIL     revision       the checkout changed during the run: diffSha256 "
has "the doctor gives the rerun fix" "fix: rerun the doctor while nothing else changes the checkout or its Git data"
has "the changed checkout is the doctor's only failure" "required checks passed, 1 failed."
receipt_is "the changed-checkout doctor receipt is FAIL" FAIL 1
reason_has "the doctor receipt names the change" "revision: the checkout changed during the run: diffSha256 "
git -C "$EV" checkout -q -- docs/delivery-plan.md && cp "$EV/.git/index" "$WORK/index.saved"
run "an index broken during the doctor's run fails the doctor" 1 env PATH="$WORK/bin-tmux-does:$PATH" CC27_TMUX_DOES="printf 'broken index\n' >'$EV/.git/index'" "$EVTOOLS/doctor"
has "the doctor names the git status that failed after its checks" "FAIL     revision       the revision cannot be read after the run: working tree state unknown: $status_failed"
has "the broken index is the doctor's only failure" "required checks passed, 1 failed."
receipt_is "the broken-index doctor receipt is FAIL" FAIL 1
reason_has "the doctor receipt names the failed git status" "revision: the revision cannot be read after the run: working tree state unknown: $status_failed"
cp "$WORK/index.saved" "$EV/.git/index"
run "the doctor passes when the test tmux changes nothing" 0 env PATH="$WORK/bin-tmux-does:$PATH" CC27_TMUX_DOES=: "$EVTOOLS/doctor"
printf '#!/bin/sh\ntouch "$1"\n' >"$EV/not-executable.sh"
run "a command that cannot start is SKIPPED" 3 env -C "$EV" scripts/agent-tools/receipt --name no-exec -- ./not-executable.sh "$MARKER"
reason_has "names the command and the error" "the command did not start: ./not-executable.sh: Permission denied"
not_run "the command that cannot start did not run"
rm "$EV/not-executable.sh"
mkdir -p "$WORK/read-only" && chmod a-w "$WORK/read-only"
run "an unwritable receipt directory is SKIPPED" 3 env -C "$EV" scripts/agent-tools/receipt --receipts "$WORK/read-only/receipts" --name unwritable -- touch "$MARKER"
has "names the receipt directory" "cannot create its receipt directory: $WORK/read-only/receipts: Permission denied"
not_run "the command did not run without a receipt directory"
run "verify with an unwritable receipt directory is FAIL" 1 "$EVTOOLS/verify" pstack-plan-format --plan "$EVPLAN" --receipts "$WORK/read-only/receipts"
run "the doctor with an unwritable receipt directory fails" 1 "$EVTOOLS/doctor" --receipts "$WORK/read-only/receipts"
has "the doctor says its receipt was not written" "doctor: FAIL. Receipt not written"
run "a receipt directory that becomes unwritable during the run gives no PASS" 3 env -C "$EV" scripts/agent-tools/receipt --name locked-out -- bash -c 'chmod a-w "$CLEARCASE_RECEIPTS_DIR"/*'
has "names the receipt that was not written" "locked-out has no receipt:"
no_receipt "no receipt was written for the locked-out run"
chmod -R u+w "$RECEIPTS"
# Refresh the copy's index first: a racily clean entry makes the first git status rewrite it, and under a 16-block limit that
# write is killed (SIGXFSZ) before the capture is ever tested, which gave SKIPPED instead of the FAIL asserted here.
git -C "$EV" status --porcelain >/dev/null 2>&1
run "output that cannot be captured whole is not PASS" 1 env -C "$EV" bash -c 'ulimit -f 16 && exec scripts/agent-tools/receipt --name capture -- python3 -c "print(\"x\" * 100000)" >/dev/null'
receipt_is "the capture receipt is FAIL" FAIL 1
reason_has "names the capture file and the error" "stdout.txt: File too large; the command exited 0"
# Python exits 120 when it cannot flush stdout, so this case checks the receipt and the timeout instead of the exit.
n=$((n + 1)) RECEIPTS="$WORK/receipts-$n"
timeout 20 env -C "$EV" CLEARCASE_RECEIPTS_DIR="$RECEIPTS" scripts/agent-tools/receipt --name full-console -- python3 -c 'print("x" * 200000)' >/dev/full 2>/dev/null
if [[ $? != 124 ]]; then ok "a console that stops accepting output does not stall the command"; else bad "a console that stops accepting output does not stall the command"; fi
receipt_is "the receipt of a run whose console failed is PASS" PASS 0
if [[ $(cat "$RECEIPTS"/*/stdout.txt 2>/dev/null | wc -c) == 200001 ]]; then ok "the capture holds all the output the console missed"; else bad "the capture holds all the output the console missed"; fi
# capture_case NAME EXPECTED PYTHON : receipt runs python3 -c PYTHON, in which f names the run's own stdout.txt
capture_case() {
	run "$1" "$2" env -C "$EV" scripts/agent-tools/receipt --name capture -- python3 -c "import glob, os; [f] = glob.glob(os.environ['CLEARCASE_RECEIPTS_DIR'] + '/*/stdout.txt'); $3"
}
capture_case "a capture removed during the run is not PASS" 1 'os.unlink(f); print("output whose capture is gone")'
reason_has "names the removed capture" "stdout.txt: removed during the run; the command exited 0"
capture_case "a capture moved during the run is not PASS" 1 'os.rename(f, f + ".moved"); print("output")'
reason_has "names the moved capture" "stdout.txt: No such file or directory; it was moved during the run"
capture_case "a capture replaced during the run is not PASS" 1 'os.link(f, f + ".kept"); open(f + ".new", "w").close(); os.rename(f + ".new", f); print("output")'
reason_has "names the replaced capture" "stdout.txt: replaced during the run"
capture_case "a capture another process writes to is not PASS" 1 'open(f, "a").write("planted\n")'
reason_has "names the bytes the capture holds and those written" "stdout.txt: holds 8 bytes, 0 were written"
# The review's rewrite: the command waits until its line is captured, then overwrites it in place, same size and inode.
capture_case "a capture rewritten with other bytes of the same size is not PASS" 1 'import time; print("honest synthetic output", flush=True)
for _ in range(10000):
    if os.path.getsize(f) >= 24: break
    time.sleep(0.001)
else: raise SystemExit("the capture did not arrive")
open(f, "r+b").write(b"X" * 23 + b"\n")'
reason_has "names the capture that holds other bytes" "stdout.txt: holds other bytes than were written (sha256 "
reason_has "the rewritten capture's reason keeps the exit code" "; the command exited 0"
run "a capture larger than one read-back block is PASS" 0 env -C "$EV" scripts/agent-tools/receipt --name large-capture -- python3 -c 'import sys; sys.stdout.write("x" * 3000000)'
receipt_is "the large capture's receipt is PASS" PASS 0
if [[ $(cat "$RECEIPTS"/*/stdout.txt 2>/dev/null | wc -c) == 3000000 ]]; then ok "the large capture holds all the output"; else bad "the large capture holds all the output"; fi
capture_case "a failing command whose capture is removed keeps its exit code" 4 'os.unlink(f); raise SystemExit(4)'
receipt_check "the removed-capture receipt of a failing command is FAIL" 'r["result"] == "FAIL" and r["exitCode"] == 4 and "removed during the run" in r["reason"]'

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
run "pstack-plan-format without node is FAIL" 1 env PATH="$NONODE" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
receipt_is "no-node receipt is FAIL" FAIL 1
run "the project plan-format needs no node" 0 env PATH="$NONODE" "$TOOLS/verify" plan-format
run "doctor without python3 explains the PATH" 2 env PATH=/nonexistent "$TOOLS/doctor"
has "no-python message is actionable" "fix: install Python >= 3.12"
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
has "doctor names the old bun and the minimum" "FAIL     bun            1.3.9 at $WORK/bun-old/bun is older than 1.4.2, the minimum from packageManager in package.json"
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
mkdir -p "$WORK/bun-junk" && printf '#!/bin/sh\nprintf "1.4.2\\nthis is not version output\\n"\n' >"$WORK/bun-junk/bun"
chmod +x "$WORK/bun-junk/bun"
run "doctor fails on a bun that prints its version and then other lines" 1 env -u CLEARCASE_BUN PATH="$WORK/bun-junk:$PATH" "$TOOLS/doctor"
has "doctor names all that bun printed" "printed '1.4.2\\nthis is not version output', not a version MAJOR.MINOR.PATCH"
has "the multiline bun is the only failure" "required checks passed, 1 failed."
mkdir -p "$WORK/bun-stderr" && printf '#!/bin/sh\necho 1.4.2\necho "synthetic warning" >&2\n' >"$WORK/bun-stderr/bun"
chmod +x "$WORK/bun-stderr/bun"
run "doctor fails on a bun that writes to stderr" 1 env -u CLEARCASE_BUN PATH="$WORK/bun-stderr:$PATH" "$TOOLS/doctor"
has "doctor names bun's stderr" "FAIL     bun            \`$WORK/bun-stderr/bun --version\` wrote to stderr: synthetic warning"
mkdir -p "$WORK/bun-padded" && printf '#!/bin/sh\nprintf "\\n 1.4.2 \\n\\n"\n' >"$WORK/bun-padded/bun" && chmod +x "$WORK/bun-padded/bun"
run "doctor accepts one version line with white space around it" 0 env -u CLEARCASE_BUN PATH="$WORK/bun-padded:$PATH" "$TOOLS/doctor"
mkdir -p "$WORK/bun-failing"
printf '#!/bin/sh\necho "synthetic failure of bun --version" >&2\nexit 1\n' >"$WORK/bun-failing/bun" && chmod +x "$WORK/bun-failing/bun"
run "a bun whose --version fails fails the doctor" 1 env -u CLEARCASE_BUN PATH="$WORK/bun-failing:$PATH" "$TOOLS/doctor"
has "the doctor names the failed bun probe" "FAIL     bun            \`$WORK/bun-failing/bun --version\` exited 1: synthetic failure of bun --version"
fake_bun ok 1.4.2
run "doctor passes with bun 1.4.2 on PATH" 0 env -u CLEARCASE_BUN PATH="$WORK/bun-ok:$PATH" "$TOOLS/doctor"
has "the bun row passes at the minimum" "PASS     bun            1.4.2 at $WORK/bun-ok/bun; the app needs >= 1.4.2 (packageManager in package.json)"
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
# The test tmux, which the doctor probes after it has read package.json, appends a line to it.
rm "$EV/package.json" && echo '{"packageManager": "bun@1.4.2"}' >"$EV/package.json"
mkdir -p "$WORK/bin-tmux-writes-input"
printf '#!/bin/sh\necho >>%q\necho "tmux 3.7"\n' "$EV/package.json" >"$WORK/bin-tmux-writes-input/tmux"
chmod +x "$WORK/bin-tmux-writes-input/tmux"
run "a doctor input that changes during the run fails the doctor" 1 env PATH="$WORK/bin-tmux-writes-input:$PATH" "$EVTOOLS/doctor"
has "names the changed input" "FAIL     receipt-input  changed during the run: $EV/package.json: sha256 "
# package.json is a file of the checkout, so the doctor's second look at the revision sees the change too.
has "names the checkout the changed input belongs to" "FAIL     revision       the checkout changed during the run: diffSha256 "
has "the changed input and checkout are the only failures" "required checks passed, 2 failed."
rm "$EV/package.json"

echo "# the doctor flags a changed or missing pinned skill"
SKILLS=${CLEARCASE_SKILLS_DIR:-$HOME/.agents/skills}
PLANTED="$WORK/planted-skills"
mapfile -t pinned < <(python3 -c 'import json,sys; print("\n".join(sorted(json.load(open(sys.argv[1]))["skills"])))' "$TOOLS/skills.lock.json")
for name in "${pinned[@]}"; do mkdir -p "$PLANTED/$name" && cp -a "$SKILLS/$name/." "$PLANTED/$name/"; done
run "doctor passes on a copy of the pinned skills" 0 "$TOOLS/doctor" --skills-dir "$PLANTED"
receipt_check "doctor names the install version and SHA" 'r["pstack"]["kind"] == "plugin" and r["pstack"]["version"] and re.fullmatch("[0-9a-f]{40}|[0-9a-f]{64}", r["pstack"]["gitCommitSha"])'
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
rm "$PLANTED/$changed/PLANTED.md"

echo "# canonical plugin discovery, identity and fail-closed fallback"
# Self-contained: a synthetic plugin under a throwaway HOME, generated skill text, the unchanged canonical checker
# from fixtures/pstack/, and no inherited T3_PSTACK_ROOT or CLEARCASE_SKILLS_DIR. Nothing in this section discovers
# or copies from the real HOME; PSTACK_ENV strips the variables that would redirect discovery or name a harness.
PSTACK_ENV=(env -u T3_PSTACK_ROOT -u T3_PSTACK_HARNESS -u CLAUDECODE -u CODEX_THREAD_ID -u CODEX_HOME -u CLEARCASE_SKILLS_DIR -u CLEARCASE_CHROMIUM)
CHECKER_FIXTURE="$FIXTURES/pstack/check-plan.mjs"
CHECKER_SHA=f4bb71a390d7a49fc7d6e7dd178d2c2c0d9575c13194dc94a7df324107b87882
if [[ $(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$CHECKER_FIXTURE") == "$CHECKER_SHA" ]] \
	&& grep -qF "$CHECKER_SHA" "$FIXTURES/pstack/README.md" && [[ -s $FIXTURES/pstack/LICENSE ]]; then
	ok "the committed checker is the unchanged canonical copy, with its license and provenance"
else
	bad "the committed checker is the unchanged canonical copy, with its license and provenance" "$CHECKER_FIXTURE differs from sha256 $CHECKER_SHA or lacks its LICENSE or README"
fi
PLUGIN_HOME="$WORK/plugin-home"
python3 "$HERE/make_plugin.py" "$PLUGIN_HOME" 2.0.0-rc.5 2.0.0-rc.9 2.0.0-rc.10
PLUGIN_LATEST="$PLUGIN_HOME/.claude/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.10"
PLUGIN_REGISTRY="$PLUGIN_HOME/.claude/plugins/installed_plugins.json"
PLUGIN_OLD="$PLUGIN_HOME/.claude/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.5"
cp "$PLUGIN_REGISTRY" "$WORK/plugin-registry.saved"
run "newest plugin uses semantic version order" 0 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack
has "rc.10 sorts after rc.9" "version 2.0.0-rc.10"
receipt_check "plugin receipt records install identity and file fingerprints" 'r["pstack"]["version"] == "2.0.0-rc.10" and r["pstack"]["gitCommitSha"] == "a" * 40 and any(i["path"].endswith("installed_plugins.json") and i["sha256"] for i in r["inputs"])'
run "an inherited T3_PSTACK_ROOT would redirect discovery" 1 env T3_PSTACK_ROOT="$WORK/hostile-root" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack
run "the fixture environment ignores an inherited T3_PSTACK_ROOT and skills dir" 0 env T3_PSTACK_ROOT="$WORK/hostile-root" CLEARCASE_SKILLS_DIR="$WORK/hostile-skills" "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack
run "explicit plugin root wins over the newest version" 0 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" T3_PSTACK_ROOT="$PLUGIN_OLD" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
receipt_check "explicit root is recorded" 'r["pstack"]["selection"] == "T3_PSTACK_ROOT" and r["pstack"]["version"] == "2.0.0-rc.5"'
run "the canonical checker rejects the invalid plan through the fixture plugin" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/invalid.md"
has "the checker's own verdict is shown" "long dash"
# A HOME written with a trailing slash still locates the plugin, and receipts show ~ in place of it.
run "a HOME with a trailing slash locates the plugin and checker" 0 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME/" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
lacks_in_receipt "receipts redact a HOME with a trailing slash" "$PLUGIN_HOME"
receipt_check "internal paths stay raw while the receipt shows ~" 'r["pstack"]["root"].startswith("~/.claude/plugins/cache/")'
run "doctor rows locate the plugin files under a HOME with a trailing slash" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME/" "$TOOLS/doctor"
has "doctor passes the pstack source row" "PASS     pstack-source"
has "doctor finds the required plugin files" "PASS     skill-file"
lacks "doctor finds no required plugin file missing" "FAIL     skill-file"
receipt_check "doctor receipt names the fixture plugin" 'r["pstack"]["kind"] == "plugin" and r["pstack"]["version"] == "2.0.0-rc.10" and r["pstack"]["gitCommitSha"] == "a" * 40'
# The retired upstream comparison must not PASS under its old name, whatever the registry or checkout says.
run "retired pstack-upstream FAILs instead of passing as an alias" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack-upstream --checkout "$WORK/no-checkout"
has "the retired capability names its replacement" "use scripts/agent-tools/verify pstack"
lacks "the retired capability never prints a PASS" "PASS"
receipt_is "retired pstack-upstream has a FAIL receipt" FAIL 1
receipt_check "the FAIL receipt keeps the retired capability's name" 'r["name"] == "pstack-upstream"'
reason_has "the retired receipt carries the migration message" "retired"
run "retired pstack-upstream without --checkout FAILs too" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack-upstream
receipt_is "retired pstack-upstream without --checkout has a FAIL receipt" FAIL 1
run "the internal compare-upstream entry point FAILs" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" python3 -I -B "$TOOLS/agent_tools.py" compare-upstream --checkout "$WORK/no-checkout"
has "compare-upstream names its replacement" "use scripts/agent-tools/verify pstack"
lacks "compare-upstream never prints a PASS" "PASS"
run "missing explicit plugin fails without a legacy fallback" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" T3_PSTACK_ROOT="$WORK/no-plugin" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
receipt_is "missing explicit plugin has a FAIL receipt" FAIL 1
reason_has "missing plugin reason names discovery" "pstack discovery failed"
run "empty plugin override fails instead of falling back" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" T3_PSTACK_ROOT= "$TOOLS/verify" pstack
reason_has "empty override is actionable" "T3_PSTACK_ROOT is empty"
# A wrong version cannot use an older valid plugin or the legacy directory.
python3 - "$PLUGIN_REGISTRY" <<'EOF'
import json, sys
p=sys.argv[1]; data=json.load(open(p)); data['plugins']['t3-pstack@t3-pstack'][-1]['version']='1.0.0'
open(p,'w').write(json.dumps(data))
EOF
run "registry version mismatch fails without falling back" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack
receipt_is "wrong plugin version has a FAIL receipt" FAIL 1
reason_has "version mismatch names both records" "installed_plugins.json version '1.0.0' differs from manifest version '2.0.0-rc.10'"
cp "$WORK/plugin-registry.saved" "$PLUGIN_REGISTRY"
python3 - "$PLUGIN_LATEST/.claude-plugin/plugin.json" <<'EOF'
import json, sys
p=sys.argv[1]; data=json.load(open(p)); data['version']='1.0.0'; open(p,'w').write(json.dumps(data))
EOF
run "unsupported plugin major version fails" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack
reason_has "unsupported version is explicit" "unsupported t3-pstack version '1.0.0'"
printf '{"name":"t3-pstack","version":"2.0.0-rc.10"}\n' >"$PLUGIN_LATEST/.claude-plugin/plugin.json"
python3 - "$PLUGIN_REGISTRY" <<'EOF'
import json, sys
p=sys.argv[1]; data=json.load(open(p)); data['plugins']['t3-pstack@t3-pstack'][-1]['gitCommitSha']='HEAD'
open(p,'w').write(json.dumps(data))
EOF
run "nonexact plugin install SHA fails" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack
reason_has "bad install SHA is explicit" "gitCommitSha must be an exact Git SHA"
cp "$WORK/plugin-registry.saved" "$PLUGIN_REGISTRY"
mv "$PLUGIN_LATEST/skills/poteto-mode/scripts/check-plan.mjs" "$WORK/check-plan.saved"
run "missing canonical checker fails before running" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
receipt_is "missing checker is FAIL, never SKIPPED" FAIL 1
reason_has "missing checker is named" "required pstack file missing or unreadable"
mv "$WORK/check-plan.saved" "$PLUGIN_LATEST/skills/poteto-mode/scripts/check-plan.mjs"
LEGACY_HOME="$WORK/legacy-home"
mkdir -p "$LEGACY_HOME/.agents/skills"
cp -a "$PLUGIN_LATEST/skills/." "$LEGACY_HOME/.agents/skills/"
run "legacy bundle is accepted only when the plugin is absent" 0 "${PSTACK_ENV[@]}" HOME="$LEGACY_HOME" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
receipt_check "fallback identity is honest about unavailable provenance" 'r["pstack"]["kind"] == "legacy" and r["pstack"]["version"] is None and r["pstack"]["gitCommitSha"] is None'
mkdir -p "$LEGACY_HOME/.claude/plugins"
printf '{"version":2,"plugins":{"other-plugin@market":[{"installPath":"/x","version":"1.0.0"}],"t3-pstack@t3-pstack":[]}}\n' >"$LEGACY_HOME/.claude/plugins/installed_plugins.json"
run "a registry without a t3-pstack record still allows the legacy bundle" 0 "${PSTACK_ENV[@]}" HOME="$LEGACY_HOME" "$TOOLS/verify" pstack
receipt_check "that fallback is recorded as legacy" 'r["pstack"]["kind"] == "legacy"'
rm "$LEGACY_HOME/.claude/plugins/installed_plugins.json"
run "an explicit broken plugin cannot fall back to working legacy skills" 1 "${PSTACK_ENV[@]}" HOME="$LEGACY_HOME" T3_PSTACK_ROOT="$WORK/no-plugin" "$TOOLS/verify" pstack
receipt_is "broken plugin cannot be hidden by legacy skills" FAIL 1
run "no plugin or legacy bundle fails clearly" 1 "${PSTACK_ENV[@]}" HOME="$WORK/no-plugin-home" "$TOOLS/verify" pstack
receipt_is "missing all sources writes a FAIL receipt" FAIL 1
reason_has "fix names canonical installation" "canonical t3-pstack plugin and legacy pstack bundle not found"
# A registered plugin is present, whatever the cache holds: working legacy skills must never stand in for it.
registered_home() {
	local home="$WORK/registered-$1"
	python3 "$HERE/make_plugin.py" "$home" 2.0.0-rc.5 &&
		mkdir -p "$home/.agents/skills" && cp -a "$PLUGIN_LATEST/skills/." "$home/.agents/skills/" &&
		echo "$home"
}
GONE_HOME=$(registered_home gone) && rm -rf "$GONE_HOME/.claude/plugins/cache"
run "a registered plugin whose cache directory is gone fails despite working legacy skills" 1 "${PSTACK_ENV[@]}" HOME="$GONE_HOME" "$TOOLS/verify" pstack
lacks "the missing cache is never a legacy PASS" "legacy fallback"
receipt_is "missing registered cache has a FAIL receipt" FAIL 1
reason_has "the receipt says the registered plugin is missing" "registered in installed_plugins.json"
run "pstack-plan-format also FAILs for a registered plugin with no cache" 1 "${PSTACK_ENV[@]}" HOME="$GONE_HOME" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
receipt_is "pstack-plan-format with no registered cache has a FAIL receipt" FAIL 1
EMPTY_HOME=$(registered_home empty) && rm -rf "$EMPTY_HOME/.claude/plugins/cache" && mkdir -p "$EMPTY_HOME/.claude/plugins/cache/t3-pstack/t3-pstack"
run "a registered plugin with an empty cache fails despite working legacy skills" 1 "${PSTACK_ENV[@]}" HOME="$EMPTY_HOME" "$TOOLS/verify" pstack
receipt_is "empty registered cache has a FAIL receipt" FAIL 1
reason_has "the empty cache is named" "registered in installed_plugins.json"
BADREG_HOME=$(registered_home badreg) && rm -rf "$BADREG_HOME/.claude/plugins/cache"
printf '{ not json' >"$BADREG_HOME/.claude/plugins/installed_plugins.json"
run "a malformed registry without a cache fails; absence cannot be proved" 1 "${PSTACK_ENV[@]}" HOME="$BADREG_HOME" "$TOOLS/verify" pstack
receipt_is "malformed registry has a FAIL receipt" FAIL 1
reason_has "malformed registry is named" "installed_plugins.json"
printf '{"version":2,"plugins":[]}\n' >"$BADREG_HOME/.claude/plugins/installed_plugins.json"
run "a registry of the wrong shape without a cache fails" 1 "${PSTACK_ENV[@]}" HOME="$BADREG_HOME" "$TOOLS/verify" pstack
receipt_is "wrong-shape registry has a FAIL receipt" FAIL 1
printf '{"version":2,"plugins":{}}\n' >"$BADREG_HOME/.claude/plugins/installed_plugins.json"
chmod 000 "$BADREG_HOME/.claude/plugins/installed_plugins.json"
run "an unreadable registry without a cache fails; absence cannot be proved" 1 "${PSTACK_ENV[@]}" HOME="$BADREG_HOME" "$TOOLS/verify" pstack
receipt_is "unreadable registry has a FAIL receipt" FAIL 1
reason_has "unreadable registry is named" "cannot read"
chmod 644 "$BADREG_HOME/.claude/plugins/installed_plugins.json"
run "a readable registry with no t3-pstack key still allows legacy" 0 "${PSTACK_ENV[@]}" HOME="$BADREG_HOME" "$TOOLS/verify" pstack
# Without a usable HOME the tools fail clearly; they never resolve global paths against the working directory.
for bad_home in "" "relative/home"; do
	run "HOME='$bad_home' fails verify pstack naming HOME" 1 "${PSTACK_ENV[@]}" HOME="$bad_home" "$TOOLS/verify" pstack
	reason_has "HOME='$bad_home' is named in the receipt" "HOME"
	run "HOME='$bad_home' fails the doctor without a traceback" 1 "${PSTACK_ENV[@]}" HOME="$bad_home" "$TOOLS/doctor"
	lacks "doctor with HOME='$bad_home' prints no traceback" "Traceback"
	has "doctor with HOME='$bad_home' names HOME" "HOME"
	run "HOME='$bad_home' fails bootstrap --relock naming HOME" 1 "${PSTACK_ENV[@]}" HOME="$bad_home" "$TOOLS/bootstrap" --relock
	has "relock with HOME='$bad_home' names HOME" "HOME"
done
run "retired upstream relock is refused" 1 "$TOOLS/bootstrap" --relock --checkout "$WORK/no-checkout"
has "relock explains retained leaf-only workflow" "independent leaf skills only"
run "leaf-only relock still works" 0 "${PSTACK_ENV[@]}" "$EVTOOLS/bootstrap" --relock --skills-dir "$PLANTED"
no_receipt "leaf relock writes no receipt unless wrapped"
# The leaf relock's refusals stay tested (they went with the retired upstream section in a47c288).
cp "$EVTOOLS/skills.lock.json" "$WORK/relock.saved"
chmod 000 "$PLANTED/${pinned[0]}/SKILL.md"
run "relock refuses an installed file it cannot read" 1 "${PSTACK_ENV[@]}" "$EVTOOLS/bootstrap" --relock --skills-dir "$PLANTED"
has "refusal names the unreadable file" "bootstrap: FAIL. $PLANTED/${pinned[0]}/SKILL.md: Permission denied"
if cmp -s "$EVTOOLS/skills.lock.json" "$WORK/relock.saved"; then ok "a refused relock leaves the lock unchanged"; else bad "a refused relock leaves the lock unchanged"; fi
chmod 644 "$PLANTED/${pinned[0]}/SKILL.md"
# A plugin identity edited during a successful checker run is stale evidence, not PASS.
MUTATING_NODE="$WORK/node-mutates-plugin"
printf '#!/bin/bash\n[[ $1 == --version ]] || echo " " >>%q\nexec %q "$@"\n' "$PLUGIN_REGISTRY" "$(command -v node)" >"$MUTATING_NODE"
chmod +x "$MUTATING_NODE"
run "plugin registry changed during the run is FAIL" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" CLEARCASE_NODE="$MUTATING_NODE" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
receipt_is "stale plugin provenance has a FAIL receipt" FAIL 1
reason_has "changed provenance is named" "input changed during the run:"
cp "$WORK/plugin-registry.saved" "$PLUGIN_REGISTRY"
# The receipt's pstack identity is the discovery that was fingerprinted, not a second look after the run: a newer
# cache version that appears while the checker runs changes neither the inputs nor the recorded identity.
NEWER="$PLUGIN_HOME/.claude/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.11"
NEWER_NODE="$WORK/node-adds-newer-plugin"
printf '#!/bin/bash\nif [[ $1 != --version && ! -e %q ]]; then cp -a %q %q && printf %s %q >%q; fi\nexec %q "$@"\n' \
	"$NEWER" "$PLUGIN_LATEST" "$NEWER" '%s' '{"name":"t3-pstack","version":"2.0.0-rc.11"}' "$NEWER/.claude-plugin/plugin.json" "$(command -v node)" >"$NEWER_NODE"
chmod +x "$NEWER_NODE"
run "a newer plugin appearing during the run does not change the checked identity" 0 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" CLEARCASE_NODE="$NEWER_NODE" "$TOOLS/verify" pstack-plan-format --plan "$FIXTURES/plans/valid.md"
receipt_check "the receipt records the fingerprinted install, not a later rediscovery" 'r["pstack"]["version"] == "2.0.0-rc.10" and r["pstack"]["root"].endswith("/2.0.0-rc.10")'
rm -rf "$NEWER"
# One discovery per capability run: the fingerprinted paths and the receipt's identity come from the same call.
if verdict=$("${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" python3 -I -B "$HERE/count_discovery.py" "$WORK/receipts-discovery" 2>&1 >/dev/null | grep -v '^receipt:\|^spend:'); [[ -z $verdict ]]; then
	ok "a capability run discovers the plugin once and reuses it for its receipt"
else
	bad "a capability run discovers the plugin once and reuses it for its receipt" "$verdict"
fi

echo "# cross-harness discovery: Claude and Codex installs, each judged by its own provenance"
# One throwaway HOME holds a Claude install (rc.5) and a Codex install (rc.15) laid out as Codex 0.163 records it.
XHOME="$WORK/harness-home"
python3 "$HERE/make_plugin.py" "$XHOME" 2.0.0-rc.5 && python3 "$HERE/make_plugin.py" "$XHOME" --codex 2.0.0-rc.15
HENV=("${PSTACK_ENV[@]}" HOME="$XHOME")
CODEX_ROOT="$XHOME/.codex/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.15"
CLAUDE_ROOT="$XHOME/.claude/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.5"
CODEX_CLONE="$XHOME/.codex/.tmp/marketplaces/t3-pstack"
for file in "$XHOME/.codex/config.toml" "$CODEX_CLONE/.codex-marketplace-install.json" "$CODEX_CLONE/.claude-plugin/marketplace.json"; do
	cp "$file" "$file.saved"
done
restore_codex() { for file in "$XHOME/.codex/config.toml" "$CODEX_CLONE/.codex-marketplace-install.json" "$CODEX_CLONE/.claude-plugin/marketplace.json"; do cp "$file.saved" "$file"; done; }
# set_json FILE EXPR : apply a Python expression to the JSON object d in FILE
set_json() { python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); exec(sys.argv[2]); json.dump(d, open(p, "w"))' "$1" "$2"; }
run "an explicit Codex root validates against Codex's own install records" 0 "${HENV[@]}" T3_PSTACK_ROOT="$CODEX_ROOT" "$TOOLS/verify" pstack
receipt_check "the explicit Codex root records Codex provenance" 'r["pstack"]["harness"] == "codex" and r["pstack"]["selection"] == "T3_PSTACK_ROOT" and r["pstack"]["version"] == "2.0.0-rc.15" and r["pstack"]["gitCommitSha"] == "b" * 40'
receipt_check "the Codex receipt fingerprints its config, install record, listing and manifest" 'len([i for i in r["inputs"] if i["sha256"] and i["path"].endswith(("/config.toml", "/.codex-marketplace-install.json", "/marketplace.json", "/.codex-plugin/plugin.json"))]) == 4'
run "an active Codex session selects the Codex install" 0 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
has "the summary names the Codex harness" "harness codex"
receipt_check "the Codex session's receipt records the harness and why" 'r["pstack"]["harness"] == "codex" and "CODEX_THREAD_ID" in r["pstack"]["harnessSelection"] and r["pstack"]["version"] == "2.0.0-rc.15"'
run "an active Claude session selects the Claude install" 0 "${HENV[@]}" CLAUDECODE=1 "$TOOLS/verify" pstack
receipt_check "the Claude session's receipt records the harness and why" 'r["pstack"]["harness"] == "claude" and "CLAUDECODE" in r["pstack"]["harnessSelection"] and r["pstack"]["version"] == "2.0.0-rc.5"'
run "with no active harness the Claude install is the default" 0 "${HENV[@]}" "$TOOLS/verify" pstack
receipt_check "the default is recorded as a default" 'r["pstack"]["harness"] == "claude" and r["pstack"]["harnessSelection"].startswith("default")'
run "T3_PSTACK_HARNESS overrides the active harness" 0 "${HENV[@]}" CLAUDECODE=1 T3_PSTACK_HARNESS=codex "$TOOLS/verify" pstack
receipt_check "the explicit harness is recorded" 'r["pstack"]["harness"] == "codex" and r["pstack"]["harnessSelection"] == "T3_PSTACK_HARNESS"'
run "an explicit Claude root wins over an active Codex session" 0 "${HENV[@]}" CODEX_THREAD_ID=synthetic T3_PSTACK_ROOT="$CLAUDE_ROOT" "$TOOLS/verify" pstack
receipt_check "the explicit Claude root keeps Claude provenance" 'r["pstack"]["harness"] == "claude" and r["pstack"]["version"] == "2.0.0-rc.5" and r["pstack"]["gitCommitSha"] == "a" * 40'
run "doctor in a Codex session checks the Codex install" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/doctor"
has "doctor passes the Codex source row" "PASS     pstack-source"
has "doctor names the Codex harness" "harness codex"
receipt_check "the doctor receipt names the Codex install" 'r["pstack"]["harness"] == "codex" and r["pstack"]["version"] == "2.0.0-rc.15"'
run "an unknown T3_PSTACK_HARNESS fails" 1 "${HENV[@]}" T3_PSTACK_HARNESS=cursor "$TOOLS/verify" pstack
reason_has "the unknown harness is named" "T3_PSTACK_HARNESS"
run "two active harnesses are ambiguous and fail" 1 "${HENV[@]}" CLAUDECODE=1 CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the ambiguity is named" "ambiguous"
run "a relative CODEX_HOME fails" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic CODEX_HOME=relative/codex "$TOOLS/verify" pstack
reason_has "the relative CODEX_HOME is named" "CODEX_HOME"
set_json "$CODEX_CLONE/.claude-plugin/marketplace.json" 'd["plugins"][0]["version"] = "2.0.0-rc.16"'
run "a stale active Codex install fails instead of validating Claude" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the stale Codex record is named" "2.0.0-rc.16"
lacks_in_receipt "the stale Codex session never records the Claude install" "2.0.0-rc.5"
run "the stale Codex install leaves a Claude session valid" 0 "${HENV[@]}" CLAUDECODE=1 "$TOOLS/verify" pstack
restore_codex
cp -a "$CODEX_ROOT" "${CODEX_ROOT%/*}/2.0.0-rc.16" && printf '{"name":"t3-pstack","version":"2.0.0-rc.16"}' >"${CODEX_ROOT%/*}/2.0.0-rc.16/.codex-plugin/plugin.json"
run "a newer Codex cache version with no marketplace record fails" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the orphan Codex version is named" "2.0.0-rc.16"
rm -rf "${CODEX_ROOT%/*}/2.0.0-rc.16"
cp -a "$CODEX_ROOT" "${CODEX_ROOT%/*}/2.0.0-rc.9" && printf '{"name":"t3-pstack","version":"2.0.0-rc.9"}' >"${CODEX_ROOT%/*}/2.0.0-rc.9/.codex-plugin/plugin.json"
run "an explicit Codex root other than the recorded version fails" 1 "${HENV[@]}" T3_PSTACK_ROOT="${CODEX_ROOT%/*}/2.0.0-rc.9" "$TOOLS/verify" pstack
reason_has "the recorded version is named" "2.0.0-rc.15"
rm -rf "${CODEX_ROOT%/*}/2.0.0-rc.9"
sed -i 's/^enabled = true$/enabled = false/' "$XHOME/.codex/config.toml"
run "a disabled Codex plugin fails when Codex is active" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the disabled plugin is named" "not enabled"
printf 'not [valid toml\n' >"$XHOME/.codex/config.toml"
run "a malformed Codex config.toml fails" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the malformed config is named" "/.codex/config.toml is not valid TOML"
lacks "the malformed config fails without a traceback" "Traceback"
restore_codex
set_json "$CODEX_CLONE/.codex-marketplace-install.json" 'd["revision"] = "HEAD"'
run "a Codex install record without an exact revision fails" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the inexact revision is named" "/.codex-marketplace-install.json revision must be an exact Git SHA"
restore_codex
set_json "$CODEX_CLONE/.codex-marketplace-install.json" 'd["source"] = "https://agent:source-canary-159@example.invalid/other.git"'
run "a Codex install record from another source fails" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the mismatch is named" "records another source than the t3-pstack marketplace"
lacks "the output never prints a source URL, which can carry credentials" "source-canary-159"
lacks_in_receipt "the receipt never records a source URL" "source-canary-159"
restore_codex
rm "$CODEX_CLONE/.codex-marketplace-install.json"
run "a Codex install with no marketplace install record fails" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the missing record is named" "cannot read ~/.codex/.tmp/marketplaces/t3-pstack/.codex-marketplace-install.json: No such file or directory"
restore_codex
mv "$CODEX_ROOT" "${CODEX_ROOT%/*}/3.0.0" && printf '{"name":"t3-pstack","version":"3.0.0"}' >"${CODEX_ROOT%/*}/3.0.0/.codex-plugin/plugin.json"
set_json "$CODEX_CLONE/.claude-plugin/marketplace.json" 'd["plugins"][0]["version"] = "3.0.0"'
run "an unsupported Codex major version fails" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the unsupported version is named" "unsupported t3-pstack version '3.0.0'"
rm -rf "${CODEX_ROOT%/*}/3.0.0" && restore_codex && python3 "$HERE/make_plugin.py" "$WORK/codex-rebuild" --codex 2.0.0-rc.15 && mv "$WORK/codex-rebuild/.codex/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.15" "$CODEX_ROOT"
run "the restored Codex install validates again" 0 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
run "an active Codex session with no Codex install fails rather than validating Claude" 1 "${PSTACK_ENV[@]}" HOME="$PLUGIN_HOME" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the other harness is never validated in its place" "never validated in its place"
CODEX_ONLY="$WORK/codex-only-home"
python3 "$HERE/make_plugin.py" "$CODEX_ONLY" --codex 2.0.0-rc.15
run "an active Claude session with only a Codex install fails" 1 "${PSTACK_ENV[@]}" HOME="$CODEX_ONLY" CLAUDECODE=1 "$TOOLS/verify" pstack
reason_has "the Claude session names its missing install" "never validated in its place"
run "with no active harness and only a Codex install, Codex is used" 0 "${PSTACK_ENV[@]}" HOME="$CODEX_ONLY" "$TOOLS/verify" pstack
receipt_check "the Codex-only default is recorded" 'r["pstack"]["harness"] == "codex" and r["pstack"]["harnessSelection"].startswith("default")'

echo "# GRS-159 fix round 1: Claude enablement, error style, root precedence, both source canaries"
# Claude loads an installed plugin unless enabledPlugins turns it off (defaultEnabled is true), so an explicit false in
# the settings that govern the install means the plugin is not loaded. A field that cannot be read as a boolean, or a
# settings file that cannot be read, proves nothing and fails. An absent file or key keeps Claude's default (enabled).
CL_HOME="$WORK/claude-settings-home"
python3 "$HERE/make_plugin.py" "$CL_HOME" 2.0.0-rc.5
CL_SETTINGS="$CL_HOME/.claude/settings.json"
CLENV=("${PSTACK_ENV[@]}" HOME="$CL_HOME")
printf '{"enabledPlugins":{"t3-pstack@t3-pstack":true},"model":"synthetic-canary-model"}\n' >"$CL_SETTINGS"
run "a Claude install enabled in settings.json passes" 0 "${CLENV[@]}" "$TOOLS/verify" pstack
receipt_check "the receipt fingerprints the settings that govern the install" 'any(i["path"].endswith("/.claude/settings.json") and i["sha256"] for i in r["inputs"])'
printf '{"enabledPlugins":{"t3-pstack@t3-pstack":false}}\n' >"$CL_SETTINGS"
run "a Claude install disabled in settings.json fails" 1 "${CLENV[@]}" "$TOOLS/verify" pstack
receipt_is "the disabled Claude install has a FAIL receipt" FAIL 1
reason_has "the disabled Claude plugin is named with its setting" "t3-pstack@t3-pstack is disabled by enabledPlugins in ~/.claude/settings.json"
lacks "the disabled install is not reported as a pass" "pstack: PASS"
run "doctor fails on a disabled Claude install" 1 "${CLENV[@]}" "$TOOLS/doctor"
has "doctor names the failing pstack source" "FAIL     pstack-source"
printf '{"enabledPlugins":{"other@market":false}}\n' >"$CL_SETTINGS"
run "another plugin's disabled entry leaves t3-pstack enabled by default" 0 "${CLENV[@]}" "$TOOLS/verify" pstack
printf '{}\n' >"$CL_SETTINGS"
run "settings with no enabledPlugins keep Claude's default" 0 "${CLENV[@]}" "$TOOLS/verify" pstack
for body in '{"enabledPlugins":{"t3-pstack@t3-pstack":"false"}}' '{"enabledPlugins":{"t3-pstack@t3-pstack":null}}' '{"enabledPlugins":{"t3-pstack@t3-pstack":0}}' \
	'{"enabledPlugins":[]}' '{"enabledPlugins":"t3-pstack@t3-pstack"}' '[]' '{ not json'; do
	printf '%s\n' "$body" >"$CL_SETTINGS"
	run "Claude settings that cannot be read as an enablement fail: $body" 1 "${CLENV[@]}" "$TOOLS/verify" pstack
	reason_has "the unreadable settings are named: $body" "~/.claude/settings.json"
	lacks "the unreadable settings fail without a traceback: $body" "Traceback"
done
printf '{"enabledPlugins":{"t3-pstack@t3-pstack":false}}\n' >"$CL_SETTINGS"
mkdir -p "$XHOME/.claude" && cp "$CL_SETTINGS" "$XHOME/.claude/settings.json"
run "a disabled Claude install is not replaced by the valid Codex install" 1 "${HENV[@]}" "$TOOLS/verify" pstack
reason_has "the Claude install is the one named" "disabled by enabledPlugins"
lacks_in_receipt "the Codex install is never recorded in its place" "2.0.0-rc.15"
run "a disabled Claude install leaves an active Codex session valid" 0 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
rm "$XHOME/.claude/settings.json"
# An install with scope local or project is governed by that project's settings, with local over project over user.
python3 - "$CL_HOME/.claude/plugins/installed_plugins.json" "$CL_HOME/project" <<'PY'
import json, sys
path, project = sys.argv[1:]
data = json.load(open(path))
data["plugins"]["t3-pstack@t3-pstack"][0].update(scope="local", projectPath=project)
json.dump(data, open(path, "w"))
PY
mkdir -p "$CL_HOME/project/.claude"
printf '{"enabledPlugins":{"t3-pstack@t3-pstack":true}}\n' >"$CL_SETTINGS"
printf '{"enabledPlugins":{"t3-pstack@t3-pstack":false}}\n' >"$CL_HOME/project/.claude/settings.local.json"
run "a local-scope install disabled in the project's local settings fails" 1 "${CLENV[@]}" "$TOOLS/verify" pstack
reason_has "the project's local settings are named" "settings.local.json"
printf '{"enabledPlugins":{"t3-pstack@t3-pstack":true}}\n' >"$CL_HOME/project/.claude/settings.local.json"
printf '{"enabledPlugins":{"t3-pstack@t3-pstack":false}}\n' >"$CL_HOME/project/.claude/settings.json"
run "the project's local settings win over its shared settings" 0 "${CLENV[@]}" "$TOOLS/verify" pstack
receipt_check "both project files and the user file are fingerprinted" 'len([i for i in r["inputs"] if i["sha256"] and i["path"].endswith(("/settings.json", "/settings.local.json"))]) == 3'
python3 - "$CL_HOME/.claude/plugins/installed_plugins.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
data["plugins"]["t3-pstack@t3-pstack"][0].update(scope="local", projectPath="relative/project")
json.dump(data, open(sys.argv[1], "w"))
PY
run "a project-scoped install with a relative projectPath fails" 1 "${CLENV[@]}" "$TOOLS/verify" pstack
reason_has "the relative projectPath is named" "projectPath"
python3 "$HERE/make_plugin.py" "$WORK/claude-errors-home" 2.0.0-rc.5
ERR_HOME="$WORK/claude-errors-home"
ERR_REGISTRY="$ERR_HOME/.claude/plugins/installed_plugins.json"
cp "$ERR_REGISTRY" "$WORK/claude-errors-registry.saved"
# Claude failures read like the Codex ones: they name the file, say what is wrong and show ~ for HOME.
ERRENV=("${PSTACK_ENV[@]}" HOME="$ERR_HOME")
python3 - "$ERR_REGISTRY" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
data["plugins"]["t3-pstack@t3-pstack"][0]["installPath"] = "/elsewhere/not-this-root"
json.dump(data, open(sys.argv[1], "w"))
PY
run "a Claude record for another root fails" 1 "${ERRENV[@]}" "$TOOLS/verify" pstack
reason_has "the orphan error names the registry and the root with ~ for HOME" "~/.claude/plugins/installed_plugins.json must contain exactly one t3-pstack install record for ~/.claude/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.5"
lacks "the orphan error never prints the raw HOME" "$ERR_HOME"
printf '{"version":2,"plugins":{"t3-pstack@t3-pstack":["not-a-record"]}}\n' >"$ERR_REGISTRY"
run "a Claude record that is not an object fails" 1 "${ERRENV[@]}" "$TOOLS/verify" pstack
reason_has "the non-object record names the registry" "~/.claude/plugins/installed_plugins.json"
lacks "the non-object record fails without a traceback" "Traceback"
printf '{"version":2,"plugins":{"t3-pstack@t3-pstack":[{"version":"2.0.0-rc.5","gitCommitSha":"%s"}]}}\n' "$(printf 'a%.0s' {1..40})" >"$ERR_REGISTRY"
run "a Claude record without installPath fails" 1 "${ERRENV[@]}" "$TOOLS/verify" pstack
reason_has "the missing installPath is named" "installPath"
reason_has "and so is the registry" "~/.claude/plugins/installed_plugins.json"
cp "$WORK/claude-errors-registry.saved" "$ERR_REGISTRY"
python3 - "$ERR_REGISTRY" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
data["plugins"]["t3-pstack@t3-pstack"][0]["version"] = 5
json.dump(data, open(sys.argv[1], "w"))
PY
run "a Claude record with a retyped version fails" 1 "${ERRENV[@]}" "$TOOLS/verify" pstack
reason_has "the retyped version names the registry" "~/.claude/plugins/installed_plugins.json version"
printf '{ "version": 2, "plugins": { "t3-pstack@t3-pstack": [ ' >"$ERR_REGISTRY"
run "a Claude registry that is not JSON fails" 1 "${ERRENV[@]}" "$TOOLS/verify" pstack
reason_has "the truncated registry is named" "~/.claude/plugins/installed_plugins.json"
lacks "the truncated registry never prints the parser's bare message" "Expecting"
cp "$WORK/claude-errors-registry.saved" "$ERR_REGISTRY"
# An explicit root names the harness, so a second session variable cannot make it ambiguous.
run "an explicit Codex root wins when both session variables are set" 0 "${HENV[@]}" CLAUDECODE=1 CODEX_THREAD_ID=synthetic T3_PSTACK_ROOT="$CODEX_ROOT" "$TOOLS/verify" pstack
receipt_check "the explicit Codex root keeps Codex provenance" 'r["pstack"]["harness"] == "codex" and r["pstack"]["harnessSelection"] == "T3_PSTACK_ROOT in the Codex cache"'
run "an explicit Claude root wins when both session variables are set" 0 "${HENV[@]}" CLAUDECODE=1 CODEX_THREAD_ID=synthetic T3_PSTACK_ROOT="$CLAUDE_ROOT" "$TOOLS/verify" pstack
receipt_check "the explicit Claude root keeps Claude provenance" 'r["pstack"]["harness"] == "claude" and r["pstack"]["harnessSelection"] == "T3_PSTACK_ROOT outside the Codex cache"'
run "both session variables with no root stay ambiguous" 1 "${HENV[@]}" CLAUDECODE=1 CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the ambiguity still names both variables" "CLAUDECODE and CODEX_THREAD_ID are both set"
run "T3_PSTACK_HARNESS beats both session variables, as before" 0 "${HENV[@]}" CLAUDECODE=1 CODEX_THREAD_ID=synthetic T3_PSTACK_HARNESS=claude "$TOOLS/verify" pstack
# A source URL can carry credentials in either record, so neither record's URL is ever printed or stored.
set_json "$CODEX_CLONE/.codex-marketplace-install.json" 'd["source"] = "https://agent:install-canary-159@example.invalid/other.git"'
run "an install record from another source fails" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
lacks "the install record's source URL is never printed" "install-canary-159"
lacks_in_receipt "the install record's source URL is never stored" "install-canary-159"
restore_codex
python3 - "$XHOME/.codex/config.toml" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
open(path, "w").write(text.replace("https://github.com/chhoumann/t3-pstack.git", "https://agent:config-canary-159@example.invalid/other.git"))
PY
run "a config.toml marketplace from another source fails" 1 "${HENV[@]}" CODEX_THREAD_ID=synthetic "$TOOLS/verify" pstack
reason_has "the config.toml source mismatch is named" "records another source than the t3-pstack marketplace in config.toml"
lacks "the config.toml source URL is never printed" "config-canary-159"
lacks_in_receipt "the config.toml source URL is never stored" "config-canary-159"
restore_codex

echo "# GRS-159 fix round 1: the Python floor and the browser-lock row"
# agent_tools.py needs Python 3.12 (nested quotes inside an f-string expression), so the wrapper refuses an older python3
# with its own message, before any receipt, instead of a SyntaxError.
OLDPY="$WORK/python-3-10"
printf '#!/bin/bash\n[[ $1 == -c ]] && exit 1\nexec %q "$@"\n' "$(command -v python3)" >"$OLDPY"
chmod +x "$OLDPY"
run "an older python3 is refused by the wrapper" 2 env CLEARCASE_PYTHON="$OLDPY" "$TOOLS/doctor"
has "the refusal names the real floor" "Python >= 3.12"
lacks "the refusal is not a SyntaxError" "SyntaxError"
no_receipt "an older python3 writes no receipt"
run "the verify entry point refuses an older python3 too" 2 env CLEARCASE_PYTHON="$OLDPY" "$TOOLS/verify" plan-graph
has "verify names the real floor" "Python >= 3.12"

# Browser admission, as the doctor reports it. A checkout with the resolver (GRS-154) judges CLEARCASE_BROWSER_LOCK the
# way scripts/browser-lock.mjs does; one without it has no discovery, so only an explicit executable admits a gate.
BL_DOCTOR="$APPC/scripts/agent-tools/doctor"
BL_RESOLVER="$APPC/scripts/browser-lock.mjs"
BL_ENV=(env -u CLEARCASE_BROWSER_LOCK -u BROWSER_LOCK)
rm -rf "$WORK/orch-bin"
run "with the resolver and no lock to discover, the doctor fails" 1 "${BL_ENV[@]}" "$BL_DOCTOR"
has "the row fails and names the missing workspace lock" "FAIL     browser-lock"
has "it says what to export" "set CLEARCASE_BROWSER_LOCK to the absolute path of the workspace's orch-bin/browser-lock"
mkdir -p "$WORK/orch-bin" && cp "$BROWSER_LOCK_STUB" "$WORK/orch-bin/browser-lock"
run "with the resolver and a discoverable lock, no export is needed" 0 "${BL_ENV[@]}" "$BL_DOCTOR"
has "the row names the discovered lock" "PASS     browser-lock   $WORK/orch-bin/browser-lock (discovered from git-common-dir)"
run "an explicit absolute executable is reported as explicit" 0 env CLEARCASE_BROWSER_LOCK="$BROWSER_LOCK_STUB" "$BL_DOCTOR"
has "the row names the explicit lock" "PASS     browser-lock   $BROWSER_LOCK_STUB (CLEARCASE_BROWSER_LOCK)"
# The doctor's verdict on each environment is the resolver's own: exit 0 admits, exit 2 refuses; none is the one case
# the resolver admits and a local preflight does not, because a gate run without a slot is not local evidence.
for setting in "relative/path" "" "$WORK/not-executable" "/etc/hostname"; do
	if (cd "$APPC" && env CLEARCASE_BROWSER_LOCK="$setting" bun "$BL_RESOLVER" >/dev/null 2>&1); then resolver=0; else resolver=$?; fi
	run "the doctor refuses CLEARCASE_BROWSER_LOCK='$setting' as the resolver does (resolver exit $resolver)" "$([[ $resolver == 0 ]] && echo 0 || echo 1)" env CLEARCASE_BROWSER_LOCK="$setting" "$BL_DOCTOR"
	[[ $resolver == 2 ]] && has "the refusal for '$setting' reaches the doctor row" "FAIL     browser-lock"
done
run "the retired BROWSER_LOCK fails the doctor" 1 env BROWSER_LOCK=anything "$BL_DOCTOR"
has "the retired spelling is named" "BROWSER_LOCK is the retired spelling"
run "CLEARCASE_BROWSER_LOCK=none fails the local preflight" 1 env CLEARCASE_BROWSER_LOCK=none "$BL_DOCTOR"
has "none is explained as not local evidence" "none runs browser jobs without a slot; a local gate run without one does not count"
mv "$BL_RESOLVER" "$WORK/browser-lock.mjs.aside"
run "a checkout without the resolver and without an export fails the doctor" 1 "${BL_ENV[@]}" "$BL_DOCTOR"
has "the row says this checkout does not discover a lock" "FAIL     browser-lock   this checkout has no scripts/browser-lock.mjs"
has "the row tells the worker to export the workspace lock" "export CLEARCASE_BROWSER_LOCK=<absolute path to the workspace's orch-bin/browser-lock>"
has "the row says a gate run without it does not count" "a gate run without it takes no slot and does not count as evidence"
run "a checkout without the resolver passes with an explicit executable" 0 env CLEARCASE_BROWSER_LOCK="$BROWSER_LOCK_STUB" "$BL_DOCTOR"
has "the row reports the explicit lock" "PASS     browser-lock   $BROWSER_LOCK_STUB (CLEARCASE_BROWSER_LOCK; this checkout has no resolver)"
run "a checkout without the resolver fails on a relative export" 1 env CLEARCASE_BROWSER_LOCK="relative/path" "$BL_DOCTOR"
mv "$WORK/browser-lock.mjs.aside" "$BL_RESOLVER"

echo "# local bounded escalation records and spend reporting"
ESC="$WORK/escalation"
mkdir -p "$ESC" && echo synthetic >"$ESC/input.txt" && git_fixture "$ESC"
esc_sha=$(git -C "$ESC" rev-parse HEAD)
ESC_ARGS=(--root "$ESC" --issue GRS-999 --issue-url https://linear.app/vaper/issue/GRS-999/synthetic --source-issue GRS-104 --sha "$esc_sha" --question "Which boundary rejects a stale receipt?" --model gpt-6-astra)
run "escalation records a bounded single-model request locally" 0 "$TOOLS/escalate" "${ESC_ARGS[@]}"
receipt_is "escalation request receipt is PASS for recording only" PASS 0
receipt_check "request records linkage, exact SHA and no dispatch" 'r["escalation"]["sourceIssue"] == "GRS-104" and r["escalation"]["sha"] == r["revision"]["head"] and r["escalation"]["attemptLimit"] == 1 and r["escalation"]["dispatchPerformed"] is False'
run "escalation without required fields refuses to write" 2 "$TOOLS/escalate" --issue GRS-999
no_receipt "incomplete escalation writes no record"
run "an unlinked escalation refuses to write" 1 "$TOOLS/escalate" "${ESC_ARGS[@]}" --issue-url https://linear.app/vaper/issue/GRS-998/wrong
no_receipt "mismatched escalation link writes no record"
run "source issue must be distinct from escalation" 1 "$TOOLS/escalate" "${ESC_ARGS[@]}" --source-issue GRS-999
no_receipt "self-linked escalation writes no record"
run "a symbolic SHA is refused" 1 "$TOOLS/escalate" "${ESC_ARGS[@]}" --sha HEAD
no_receipt "symbolic SHA writes no record"
run "an exact stale SHA is refused" 1 "$TOOLS/escalate" "${ESC_ARGS[@]}" --sha "$(printf '%040d' 0)"
no_receipt "stale escalation SHA writes no record"
run "empty escalation question is refused" 1 "$TOOLS/escalate" "${ESC_ARGS[@]}" --question '   '
run "unbounded escalation question is refused" 1 "$TOOLS/escalate" "${ESC_ARGS[@]}" --question "$(python3 -c 'print("q" * 1001)')"
no_receipt "unbounded question writes no record"
run "outcome needs task ID, findings, outcome and checks" 1 "$TOOLS/escalate" "${ESC_ARGS[@]}" --phase outcome
no_receipt "incomplete outcome writes no record"
run "outcome records task and findings without launching" 0 "$TOOLS/escalate" "${ESC_ARGS[@]}" --phase outcome --task-id synthetic-task --findings 'No finding' --outcome 'Question answered' --checks 'synthetic receipt self-test'
receipt_check "outcome retains all follow-up fields" 'r["escalation"]["taskId"] == "synthetic-task" and r["escalation"]["phase"] == "outcome" and r["escalation"]["checks"] and r["escalation"]["dispatchPerformed"] is False'
echo changed >>"$ESC/input.txt"
run "dirty escalation source is refused" 1 "$TOOLS/escalate" "${ESC_ARGS[@]}"
no_receipt "dirty source writes no escalation record"
run "unavailable spend is distinct from zero" 0 "$TOOLS/receipt" --name spend-unavailable -- true
receipt_check "no provider cost means null actual and null cap" 'r["spend"] == {"actualUsd": None, "actualSource": None, "targetUsd": None, "capUsd": None, "capEnforced": False}'
has "spend readout says actual unavailable" "actual=unavailable"
run "reported zero spend retains source and target" 0 "$TOOLS/receipt" --name spend-zero --actual-usd 0 --actual-source synthetic-provider-export --target-usd 12 -- true
receipt_check "actual, target and cap have distinct fields" 'r["spend"]["actualUsd"] == 0 and r["spend"]["actualSource"] == "synthetic-provider-export" and r["spend"]["targetUsd"] == 12 and r["spend"]["capUsd"] is None and not r["spend"]["capEnforced"]'
has "target is explicitly reporting only" "target=USD 12 (reporting only)"
run "exceeding a target does not pause the command" 0 "$TOOLS/receipt" --name spend-target --actual-usd 21 --actual-source synthetic-provider-export --target-usd 12 -- true
receipt_is "overspend target is not an enforcement cap" PASS 0
run "actual spend without a source is refused" 2 "$TOOLS/receipt" --name no-cost-source --actual-usd 1 -- true
no_receipt "unsourced spend is not recorded as actual"
run "nonfinite spend is refused" 2 "$TOOLS/receipt" --name invalid-cost --actual-usd nan --actual-source synthetic -- true
run "negative spend target is refused" 2 "$TOOLS/receipt" --name invalid-target --target-usd -1 -- true

echo "# bootstrap is idempotent and removable in a fresh checkout"
FRESH="$WORK/fresh"
mkdir -p "$FRESH/scripts" "$FRESH/docs"
cp -r "$REPO/scripts/agent-tools" "$REPO/scripts/planning" "$FRESH/scripts/"
cp -r "$REPO/docs/plan" "$FRESH/docs/"
cp "$REPO/docs/delivery-plan.md" "$FRESH/docs/"
cp "$REPO/.gitignore" "$FRESH/"
cp -a "$REPO/.agents" "$FRESH/"
git_fixture "$FRESH"
run "first bootstrap links" 0 "$FRESH/scripts/agent-tools/bootstrap"
has "first bootstrap reports linked" "linked ->"
receipt_is "bootstrap writes the receipt of its doctor run" PASS 0
run "verify list prints the capabilities" 0 "$FRESH/scripts/agent-tools/verify" list
has "verify list shows app as available" "app               available verify-clearcase run"
lacks "verify list defers nothing" "deferred"
has "verify list marks the upstream alias retired" "retired; FAILs with a migration message to verify pstack"
no_receipt "verify list writes no receipt"
run "second bootstrap is a no-op" 0 "$FRESH/scripts/agent-tools/bootstrap"
has "second bootstrap reports unchanged" "unchanged ->"
mkdir -p "$WORK/other-skills"
ln -s "$(readlink "$FRESH/.local/agent-tools/skills")/poteto-mode" "$WORK/other-skills/poteto-mode"
rm "$FRESH/.local/agent-tools/skills" && ln -s "$WORK/other-skills" "$FRESH/.local/agent-tools/skills"
run "conflicting bootstrap is refused" 1 "$FRESH/scripts/agent-tools/bootstrap"
has "conflict explains the fix" "bootstrap --remove first"
no_receipt "a refused bootstrap writes no receipt"
if [[ -z $(git -C "$FRESH" status --porcelain) ]]; then ok "bootstrap leaves tracked files untouched"; else bad "bootstrap leaves tracked files untouched" "$(git -C "$FRESH" status --porcelain)"; fi
run "remove deletes only local state" 0 "$FRESH/scripts/agent-tools/bootstrap" --remove
no_receipt "bootstrap --remove writes no receipt"
if [[ ! -e $FRESH/.local/agent-tools ]]; then ok "local bootstrap state removed"; else bad "local bootstrap state removed"; fi

echo "# rerun.sh stops or fails when a step's evidence is not recorded whole"
# The real rerun.sh runs in a copy of this checkout whose suite is a stub, so each run takes seconds and cannot rerun
# these cases. Faults are planted from the background once the run has written the line they wait for.
RR="$WORK/rerun-copy"
# rerun.sh requires installed dependencies, so the copy links this checkout's node_modules (ignored by Git); its
# v5-app-deferred step names a missing Chromium and exits 3 at the runner's preflight instead of a full run.
mkdir -p "$RR" && tar -C "$REPO" --exclude=./.git --exclude=./.local --exclude=./node_modules -cf - . | tar -C "$RR" -xf -
ln -s "$REPO/node_modules" "$RR/node_modules"
printf '#!/bin/bash\necho "stub suite of a rerun.sh test: 0 failed"\n' >"$RR/tests/agent-tools/run.sh"
# The committed script runs unchanged: its inventory already expects the current exit codes.
git_fixture "$RR"
rr_head=$(git -C "$RR" rev-parse HEAD)
RERUN=(env CC27_BUN="${CLEARCASE_BUN:-$(command -v bun)}" bash "$RR/docs/acceptance/CC-27/rerun.sh")
# after FILE PATTERN COMMAND : in the background, once a line of FILE matches PATTERN, run COMMAND; give up after 120 s
after() {
	(for ((t = 0; t < 12000; t++)); do grep -q -- "$2" "$1" 2>/dev/null && { eval "$3"; exit; }; sleep 0.01; done) &
}
# read_only_output NAME FILE : rerun.sh with FILE already in its new CC27_OUT and read-only must stop, exit 2
read_only_output() {
	out="$WORK/rerun-$1"
	mkdir -p "$out" && echo "synthetic read-only output" >"$out/$2" && chmod 444 "$out/$2"
	run "rerun.sh stops when it cannot write $2" 2 env CC27_OUT="$out" "${RERUN[@]}"
	has "names the $2 it cannot write" "rerun.sh: cannot write $out/$2"
}
read_only_output summary summary.tsv
if compgen -G "$out/transcripts/*" >/dev/null; then bad "no step runs without a summary"; else ok "no step runs without a summary"; fi
read_only_output revision revision.txt
read_only_output audit identity-audit.txt
has "the audit is not written after every step ran" "MATCH    v6-plan-format-bad-base"
out="$WORK/rerun-unredacted"
mkdir -p "$out/locked" && echo "synthetic output under $HOME" >"$out/locked/note.txt" && chmod 555 "$out/locked"
run "rerun.sh stops when it cannot replace the home directory in its outputs" 2 env CC27_OUT="$out" "${RERUN[@]}"
has "names the files it cannot redact" "rerun.sh: cannot replace the home directory in the files under $out"
chmod 755 "$out/locked"
run "rerun.sh stops without a temporary directory" 2 env CC27_OUT="$WORK/rerun-no-tmp" TMPDIR="$WORK/no-such-tmp" "${RERUN[@]}"
has "names the temporary directory" "rerun.sh: cannot create a temporary directory"
rm -rf "$RR/.git/worktrees" && echo "synthetic block" >"$RR/.git/worktrees"
run "rerun.sh stops when it cannot add its throwaway worktree" 2 env CC27_OUT="$WORK/rerun-no-worktree" "${RERUN[@]}"
has "names the worktree it cannot add" "rerun.sh: cannot add the throwaway worktree"
rm "$RR/.git/worktrees"
out="$WORK/rerun-summary-locked"
after "$out/summary.tsv" $'^step\t' 'chmod 444 "$out/summary.tsv"'
run "rerun.sh stops when summary.tsv becomes unwritable during the run" 2 env CC27_OUT="$out" "${RERUN[@]}"
wait
has "names the summary it cannot append to" "rerun.sh: cannot write $out/summary.tsv"
out="$WORK/rerun-blocked-transcript"
after "$out/summary.tsv" $'^step\t' 'echo planted >"$out/transcripts/v1-doctor.txt" && chmod 444 "$out/transcripts/v1-doctor.txt"'
run "rerun.sh stops when it cannot write a step's transcript" 2 env CC27_OUT="$out" "${RERUN[@]}"
wait
has "names the transcript it cannot write" "rerun.sh: cannot write $out/transcripts/v1-doctor.txt"
if grep -q $'^v1-doctor\t' "$out/summary.tsv"; then bad "the blocked step has no result" "$(cat "$out/summary.tsv")"; else ok "the blocked step has no result"; fi
if [[ $(git -C "$RR" worktree list | wc -l) == 1 ]]; then ok "the stopped run removes its throwaway worktree"; else bad "the stopped run removes its throwaway worktree" "$(git -C "$RR" worktree list)"; fi
# Eight faults in one run: every step still matches, and the audit must name each fault.
out="$WORK/rerun-tampered"
after "$out/summary.tsv" $'^v1-doctor\t' 'rm "$out"/receipts/v1-doctor/*/receipt.json; printf "v1-doctor\t0\t0\tMATCH\tplanted\nstray\t0\t0\tMATCH\tplanted\n" >>"$out/summary.tsv"; mkdir -p "$out/receipts/stray/planted" && cp "$out"/receipts/v1-bootstrap-first/*-bootstrap-first/receipt.json "$out/receipts/stray/planted/"'
after "$out/summary.tsv" $'^v1-bootstrap-remove\t' 'rm "$out"/receipts/v1-bootstrap-remove/*/stdout.txt'
after "$out/summary.tsv" $'^v2-check-plan\t' ': >"$out/transcripts/v2-check-plan.txt"; sed -i "s/$rr_head/$(printf "%040d" 0)/" "$out"/receipts/v2-check-plan/*-plan-graph/receipt.json'
after "$out/summary.tsv" $'^v5-app-deferred\t' 'sed -i "s/\"head\": \"$rr_head\"/\"head\": null/" "$out"/receipts/v5-app-deferred/*-app/receipt.json'
run "rerun.sh fails when evidence is deleted or planted during the run" 1 env CC27_OUT="$out" "${RERUN[@]}"
wait
has "every step of the copy matched its expected exit code" "summary: $out/summary.tsv (0 mismatches)"
has "the audit finds exactly the eight faults" "; 8 problems"
for fault in "v1-doctor: summary.tsv does not hold exactly one MATCH row with exit 0" \
	"stray: summary.tsv row of a step that is not in the inventory" \
	"v1-doctor: receipts [], but the inventory requires ['doctor']" \
	"-bootstrap-remove: its stdout artifact " \
	"v2-check-plan: transcripts/v2-check-plan.txt is missing or empty" \
	"-plan-graph: head $(printf "%040d" 0) is not the tested head" \
	"-app: head None is not the tested head" \
	"receipts/stray/planted/receipt.json: receipt outside the inventoried steps"; do
	OUT="$out/identity-audit.txt" has "the audit names: $fault" "$fault"
done

run "unattended controls synthetic CLI suite" 0 python3 -I "$HERE/test_controls.py"

echo "# summary"
echo "$passed passed, $failed failed"
((failed == 0))
