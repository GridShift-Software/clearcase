#!/bin/bash
# GRS-155: replays the CI job's `test guard` step, as written in .github/workflows/ci.yml (or --workflow FILE), the way
# the runner runs a step, in disposable synthetic repositories. Their base branch carries the real guard
# (scripts/agent-tools at --guard REV, default HEAD), and each pull request tries to steer the judge: its Bun config,
# .env, dependencies, install scripts or its own guard, or a base that leaves nothing trusted to judge with. Prints one
# line per scenario, then exits 0 when every scenario holds, 1 when one does not, 2 when one could not run.
# The synthetic installs use a private Bun cache, never the operator's shared one, which a worker's node_modules can
# alter through hardlinks, and a private HOME, so no operator Bun or Git configuration applies. Needs Bun, Git,
# Python 3, util-linux (setsid, unshare -rn), pgrep and the npm registry.
set -u
export GIT_OPTIONAL_LOCKS=0
hold() { echo "ci-guard: HOLD, $*" >&2; exit 2; }
here=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel) || hold "$here is not in a Git checkout"
workflow=$repo/.github/workflows/ci.yml
guard_rev=HEAD
while [ $# -gt 0 ]; do
	case $1 in
		--workflow) workflow=$(realpath -e "$2") || hold "no workflow $2"; shift 2 ;;
		--guard) guard_rev=$2; shift 2 ;;
		*) hold "usage: tests/ci-guard/run.sh [--workflow FILE] [--guard REV]" ;;
	esac
done
for tool in bun git python3 setsid unshare pgrep; do command -v "$tool" >/dev/null || hold "$tool is not on PATH"; done

T=$(mktemp -d "${TMPDIR:-/tmp}/ci-guard.XXXXXX") || hold "cannot create a temporary directory"
trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/tmp" "$T/marks" "$T/bun-cache" "$T/home"
export BUN_INSTALL_CACHE_DIR=$T/bun-cache HOME=$T/home
: > "$T/empty.toml"
plain_bun() { bun --no-env-file --config="$T/empty.toml" "$@"; }
mark=$T/marks

cat > "$T/workflow.mjs" <<'JS'
const [file, command, name] = process.argv.slice(2);
const steps = Bun.YAML.parse(await Bun.file(file).text()).jobs.check.steps;
const at = (n) => steps.findIndex((s) => s.name === n);
if (command === 'outcome-readers') {
	const g = steps.find((s) => s.name === 'test guard') ?? {};
	console.log(steps.filter((s) => s !== g && JSON.stringify([s.if, s.env]).includes(`steps.${g.id}.outcome`)).length);
} else if (command === 'run') {
	const step = steps[at(name)];
	if (!step) process.exit(3);
	process.stdout.write(String(step.run));
} else {
	const guard = at('test guard'), verdict = at('test guard verdict'), g = steps[guard] ?? {}, v = steps[verdict];
	const prCode = steps.findIndex((s, i) => i !== guard && /\bscripts\/|\bbun (install|run)\b/.test(String(s.run ?? '')));
	const install = steps.findIndex((s) => String(s.run ?? '').trim() === 'bun install --frozen-lockfile');
	const key = Object.entries(v?.env ?? {}).find(([, x]) => g.id && String(x).includes(`steps.${g.id}.outcome`))?.[0];
	console.log(guard, prCode, install, verdict, key ?? '-', String(v?.if) === String(g.if) ? 'same-if' : 'other-if',
		g['continue-on-error'] === true ? 'continues' : 'stops');
}
JS
wf() { plain_bun "$T/workflow.mjs" "$workflow" "$@"; }
wf run 'test guard' > "$T/guard-step.sh" || hold "$workflow has no step named test guard"
read -r guard_at pr_code_at install_at verdict_at verdict_key verdict_if guard_continues <<<"$(wf order)"

O=$T/origin
o() { git -C "$O" "$@"; }
commit() { o add -A && o -c user.name=ci-guard -c user.email=ci-guard@example.invalid commit -q -m "$1" && o rev-parse HEAD; }
mkdir -p "$O"
o init -q -b dev
git -C "$repo" archive "$guard_rev" scripts/agent-tools | tar -x -C "$O" || hold "cannot read scripts/agent-tools at $guard_rev"
read -r ts_version svelte_version <<<"$(git -C "$repo" show "$guard_rev:package.json" | python3 -I -c 'import json, sys; d = json.load(sys.stdin)["devDependencies"]; print(d["typescript"], d["svelte"])')"
pin=$(git -C "$repo" show "$guard_rev:package.json" | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["packageManager"])')
printf '{"name":"ci-guard-fixture","private":true,"packageManager":"%s","devDependencies":{"typescript":"%s","svelte":"%s"}}\n' \
	"$pin" "$ts_version" "$svelte_version" > "$O/package.json"
printf 'node_modules\n' > "$O/.gitignore"
(cd "$O" && plain_bun install --ignore-scripts) > "$T/setup.log" 2>&1 || { tail -5 "$T/setup.log" >&2; hold "the synthetic base's install failed (registry unreachable?)"; }
commit base > /dev/null

test_file="import { test, expect } from 'bun:test';
test('refuses a stale lease', () => {
  expect(lease('old')).toEqual(false);
  expect(lease('new')).toEqual(true);
});
"
fix_round() {   # fix_round BRANCH FROM: the red test and its manifest, then the fix
	o switch -q -c "$1" "$2"
	mkdir -p "$O/tests" "$O/docs/acceptance/fix-rounds"
	printf '%s' "$test_file" > "$O/tests/lease.test.ts"
	local red; red=$(commit red)
	printf '{"schema":"clearcase-fix-round/1","unit":"GRS-900/implementation","fixBase":"%s","tests":[{"file":"tests/lease.test.ts","name":"refuses a stale lease"}]}\n' \
		"$red" > "$O/docs/acceptance/fix-rounds/GRS-900-1.json"
	echo fixed > "$O/app.txt"
	commit fix > /dev/null
}
weaken() { printf '%s' "${test_file/toEqual(false)/toBeDefined()}" > "$O/tests/lease.test.ts"; }
payload_js() {   # payload_js FILE SCENARIO WHAT: an ES module that records it ran, claims a pass and exits 0
	mkdir -p "$(dirname "$1")"
	printf 'import { appendFileSync } from "node:fs";\nappendFileSync(%s, %s);\nconsole.log("test-guard: PASS (%s)");\nprocess.exit(0);\nexport default {};\n' \
		"'$mark/$2'" "'$3\\n'" "$3" > "$1"
}
payload_sh() {   # payload_sh FILE SCENARIO WHAT: the same as an executable
	mkdir -p "$(dirname "$1")"
	printf '#!/bin/sh\necho %s >> %s\necho "test-guard: PASS (%s)"\nexit 0\n' "$3" "$mark/$2" "$3" > "$1"
	chmod +x "$1"
}
candidate() { o switch -q -c "$1" "$2"; weaken; }

fix_round valid dev
candidate weak valid; commit weak > /dev/null
candidate preload valid
printf 'preload = ["./preload.mjs"]\n' > "$O/bunfig.toml"
payload_js "$O/preload.mjs" preload "candidate bunfig preload"
commit preload > /dev/null
for id in dependency dependency-installed; do
	candidate "$id" valid
	payload_js "$O/vendor/typescript/index.js" "$id" "candidate typescript"
	printf '{"name":"typescript","version":"%s","type":"module","main":"index.js"}\n' "$ts_version" > "$O/vendor/typescript/package.json"
	sed -i "s#\"typescript\":\"$ts_version\"#\"typescript\":\"file:./vendor/typescript\"#" "$O/package.json"
	(cd "$O" && plain_bun install --ignore-scripts) >> "$T/setup.log" 2>&1 || hold "cannot lock the candidate typescript"
	commit "$id" > /dev/null
done
candidate env-file valid
printf 'XDG_CONFIG_HOME=.cfg\n' > "$O/.env"
cp "$O/.env" "$O/.env.local"
mkdir -p "$O/.cfg/git"
printf '[core]\n\tfsmonitor = ./.cfg/fsmonitor\n' > "$O/.cfg/git/config"
payload_sh "$O/.cfg/fsmonitor" env-file "candidate .env git fsmonitor"
commit env-file > /dev/null
candidate install-script valid
payload_sh "$O/python" install-script "candidate python from GITHUB_ENV"
python3 -I - "$O/package.json" "$mark/install-script" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p["scripts"] = {"postinstall": f'echo "CLEARCASE_PYTHON=$PWD/python" >> "$GITHUB_ENV"; echo postinstall >> {sys.argv[2]}'}
json.dump(p, open(sys.argv[1], "w"))
PY
commit install-script > /dev/null
candidate own-guard valid
for f in fix-round-guard _common.sh agent_tools.py test_guard.mjs; do payload_sh "$O/scripts/agent-tools/$f" own-guard "candidate $f"; done
commit own-guard > /dev/null
candidate missing-base valid
payload_sh "$O/scripts/agent-tools/fix-round-guard" missing-base "candidate guard"
commit missing-base > /dev/null

o switch -q -c dev-noguard dev; o rm -rq scripts; commit dev-noguard > /dev/null
fix_round no-guard-valid dev-noguard
candidate no-guard no-guard-valid
payload_sh "$O/scripts/agent-tools/fix-round-guard" no-guard "candidate guard"
commit no-guard > /dev/null
o switch -q -c dev-nolock dev; o rm -q bun.lock; commit dev-nolock > /dev/null
fix_round no-lock dev-nolock
o show dev:bun.lock > "$O/bun.lock"; commit "candidate lock" > /dev/null
o switch -q -c dev-skew dev
sed -i 's#"devDependencies":{#"devDependencies":{"left-pad":"1.3.0",#' "$O/package.json"
commit dev-skew > /dev/null
fix_round install-fails dev-skew
(cd "$O" && plain_bun install --ignore-scripts) >> "$T/setup.log" 2>&1 || hold "cannot lock the skewed base"
commit "candidate lock" > /dev/null
o switch -q -c dev-scripts dev
mkdir -p "$O/localdep"
printf '{"name":"localdep","version":"1.0.0","scripts":{"install":"pwd >> %s","postinstall":"pwd >> %s"}}\n' "$mark/lifecycle" "$mark/lifecycle" > "$O/localdep/package.json"
python3 -I - "$O/package.json" "$mark/lifecycle" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p["devDependencies"]["localdep"] = "file:./localdep"
p["trustedDependencies"] = ["localdep"]
p["scripts"] = {k: f"pwd >> {sys.argv[2]}" for k in ("preinstall", "install", "postinstall", "prepare")}
json.dump(p, open(sys.argv[1], "w"))
PY
(cd "$O" && plain_bun install --ignore-scripts) >> "$T/setup.log" 2>&1 || hold "cannot lock the lifecycle base"
commit dev-scripts > /dev/null
fix_round lifecycle dev-scripts
o switch -q dev
control=$T/control
mkdir -p "$control"
o archive dev-scripts | tar -x -C "$control"
(cd "$control" && plain_bun install --frozen-lockfile) >> "$T/setup.log" 2>&1
lifecycle_control=$(grep -c . "$mark/lifecycle" 2>/dev/null)
rm -rf "$control" "$mark/lifecycle"

failed=0 could_not=0
report() {   # report STATUS ID DETAIL
	printf '%-5s %-22s %s\n' "$1" "$2" "$3"
	case $1 in FAIL) failed=$((failed + 1)) ;; HOLD) could_not=$((could_not + 1)) ;; esac
}
prepare() {   # prepare ID CANDIDATE INSTALL: a fresh CI workspace at the candidate, as the job has it before the guard
	local id=$1 cand=$2 install=$3
	s=$T/s/$id; ws=$s/workspace; rt=$s/runner-temp
	mkdir -p "$rt/receipts"
	: > "$s/github_env"
	: > "$s/github_path"
	git clone -q "$O" "$ws"
	git -C "$ws" checkout -q --detach "$(o rev-parse "$cand")"
	[ "$install" = order ] && { [ "$install_at" -ge 0 ] && [ "$install_at" -lt "$guard_at" ] && install=yes || install=no; }
	if [ "$install" = yes ]; then
		(cd "$ws" && env -i HOME="$HOME" PATH="$PATH" BUN_INSTALL_CACHE_DIR="$BUN_INSTALL_CACHE_DIR" TMPDIR="$T/tmp" \
			GITHUB_ENV="$s/github_env" GITHUB_PATH="$s/github_path" bun install --frozen-lockfile) > "$s/install.out" 2>&1
	fi
	step_env=(HOME="$HOME" BUN_INSTALL_CACHE_DIR="${step_cache:-$BUN_INSTALL_CACHE_DIR}" TMPDIR="$T/tmp" RUNNER_TEMP="$rt"
		GITHUB_ENV="$s/github_env" GITHUB_PATH="$s/github_path" PR_HEAD_SHA="$(o rev-parse "$cand")" BASE_REF="$base_ref"
		HEAD_REF="$cand" FIX_ROUND_LABEL=true)
	local line path=$PATH
	while IFS= read -r line; do [ -n "$line" ] && path=$line:$path; done < "$s/github_path"
	step_env+=(PATH="$path")
	while IFS= read -r line; do [[ $line == ?*=* ]] && step_env+=("$line"); done < "$s/github_env"
}
leftovers() {
	local registered dirs
	registered=$(git -C "$ws" worktree list --porcelain | grep -c "^worktree $rt/")
	dirs=$(find "$rt" -mindepth 1 -maxdepth 1 ! -name receipts | wc -l)
	echo "$registered registered worktrees and $dirs directories left in RUNNER_TEMP"
	[ "$registered" = 0 ] && [ "$dirs" = 0 ]
}
judge() {   # judge ID EXPECT RC MS: pass, fail or hold, with no candidate code run and nothing left behind
	local id=$1 expect=$2 rc=$3 ms=$4 out=$s/out ran="" problem="" left
	[ -s "$mark/$id" ] && ran=$(tr '\n' ',' < "$mark/$id")
	left=$(leftovers) || problem="$left"
	case $expect in
		pass) [ "$rc" = 0 ] && grep -q '^test-guard: PASS (1 named tests' "$out" || problem="expected the guard's PASS, got exit $rc" ;;
		fail) [ "$rc" != 0 ] && grep -q '^test-guard: FAIL' "$out" && ! grep -q 'test-guard: PASS' "$out" || problem="expected the guard's FAIL, got exit $rc" ;;
		hold) [ "$rc" != 0 ] && grep -q 'HOLD' "$out" && ! grep -q 'test-guard: PASS' "$out" || problem="expected a HOLD that judges nothing, got exit $rc" ;;
	esac
	[ -n "$ran" ] && problem="candidate code ran: $ran${problem:+; $problem}"
	local said
	said=$(grep -E 'test-guard: (PASS|FAIL)|HOLD|error:' "$out" | head -2 | cut -c1-110 | tr '\n' '|')
	if [ -z "$problem" ]; then report ok "$id" "exit $rc in ${ms}ms: $said $left"
	else report FAIL "$id" "$problem. ${ms}ms: $said $left"; fi
}
replay() {   # replay ID EXPECT CANDIDATE INSTALL [PREFIX...]: run the step in the workspace, then judge it
	local id=$1 expect=$2 cand=$3 install=$4 start rc
	shift 4
	prepare "$id" "$cand" "$install"
	start=$(date +%s%N)
	(cd "$ws" && "$@" env -i "${step_env[@]}" bash --noprofile --norc -eo pipefail "$T/guard-step.sh") > "$s/out" 2>&1
	rc=$?
	judge "$id" "$expect" "$rc" $(( ($(date +%s%N) - start) / 1000000 ))
}

if [ "$guard_at" -ge 0 ] && [ "$guard_at" -lt "$pr_code_at" ]; then
	report ok order "the guard is step $guard_at, before step $pr_code_at, the first that runs the pull request's code"
else
	report FAIL order "the guard is step $guard_at, after step $pr_code_at, which runs the pull request's code first (install scripts, tests, GITHUB_ENV)"
fi
# H1 (review-r1): the guard's failure must be the job's own. A later step that turned the guard's outcome into the job's
# ran after the pull request's code, which could clear it through BASH_ENV in GITHUB_ENV or a `bash` shim on GITHUB_PATH.
# So the guard step must stop the job when it fails (no continue-on-error), and no step may read its outcome. The
# scenarios below show that it exits 1 on a FAIL and a HOLD, and 0 on a PASS; tests/ci/guard-enforcement.test.ts replays
# the job's conclusion against those routes.
settled_by_outcome=$(wf outcome-readers)
if [ "$guard_at" -ge 0 ] && [ "$guard_continues" = stops ] && [ "$settled_by_outcome" = 0 ]; then
	report ok verdict "the guard step fails the job itself (no continue-on-error) and no step reads its outcome ($settled_by_outcome), so nothing the pull request's code adds to GITHUB_ENV or GITHUB_PATH can clear it"
else
	report FAIL verdict "the guard's failure must be the job's own: guard $guard_continues, $settled_by_outcome step(s) read its outcome (step $verdict_at, env $verdict_key)"
fi

base_ref=dev
replay valid pass valid order
replay weak fail weak order
replay preload fail preload order
replay dependency fail dependency order
replay dependency-installed fail dependency-installed yes
replay env-file fail env-file order
replay install-script fail install-script order
replay own-guard fail own-guard order
replay no-candidate-deps pass valid no
base_ref=dev-scripts replay lifecycle pass lifecycle order
outside=$(grep -cv "^$T/s/lifecycle/workspace" "$mark/lifecycle" 2>/dev/null)
if [ "${lifecycle_control:-0}" -ge 6 ] && [ "${outside:-0}" = 0 ]; then
	report ok lifecycle-scripts "the base's lifecycle scripts never ran in the step; a plain frozen install of that base ran $lifecycle_control"
else
	report FAIL lifecycle-scripts "the step ran ${outside:-0} lifecycle scripts outside the workspace (a plain frozen install ran ${lifecycle_control:-0})"
fi
rm -f "$mark/lifecycle"
base_ref=gone replay missing-base hold missing-base order
base_ref=dev-noguard replay no-guard hold no-guard order
base_ref=dev-nolock replay no-lock hold no-lock order
base_ref=dev-skew replay install-fails hold install-fails order
mkdir -p "$T/cold"
base_ref=dev step_cache=$T/cold replay offline hold valid order unshare -rn

base_ref=dev step_cache=$T/cold-term
mkdir -p "$step_cache"
prepare interrupted valid order
start=$(date +%s%N)
(cd "$ws" && exec setsid env -i "${step_env[@]}" bash --noprofile --norc -eo pipefail "$T/guard-step.sh") > "$s/out" 2>&1 &
pid=$!
seen=0
for _ in $(seq 600); do
	pgrep -g "$pid" -f 'install --frozen-lockfile' > /dev/null && { seen=1; break; }
	kill -0 "$pid" 2> /dev/null || break
	sleep 0.02
done
kill -TERM -- "-$pid" 2> /dev/null
wait "$pid"
rc=$?
ms=$(( ($(date +%s%N) - start) / 1000000 ))
sleep 0.2
if [ "$seen" = 0 ]; then report HOLD interrupted "the step ended (exit $rc in ${ms}ms) before its base install could be interrupted"
elif left=$(leftovers) && [ "$rc" != 0 ]; then report ok interrupted "TERM to the step during its base install: exit $rc in ${ms}ms, $left"
else report FAIL interrupted "TERM to the step during its base install: exit $rc in ${ms}ms, $left"; fi
unset step_cache

stray=$(find "$HOME" -mindepth 1 ! -path "$HOME/.bun" ! -path "$HOME/.bun/install" ! -path "$HOME/.bun/install/cache" ! -path "$HOME/.bun/install/cache/@t@*" | head -3 | tr '\n' ' ')
[ -n "$(ls -A "$BUN_INSTALL_CACHE_DIR")" ] && [ -z "$stray" ] \
	&& report ok isolation "every install used the run's private Bun cache ($(du -sh "$BUN_INSTALL_CACHE_DIR" | cut -f1)); its HOME holds only Bun's transpiler cache" \
	|| report FAIL isolation "an install bypassed the run's private Bun cache: $stray"

if [ "$failed" -gt 0 ]; then echo "ci-guard: FAIL, $failed scenarios did not hold ($workflow, guard $guard_rev)"; exit 1; fi
if [ "$could_not" -gt 0 ]; then echo "ci-guard: HOLD, $could_not scenarios could not run ($workflow, guard $guard_rev)"; exit 2; fi
echo "ci-guard: PASS, every scenario held ($workflow, guard $guard_rev)"
