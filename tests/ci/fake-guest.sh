#!/bin/bash
# SSH, account switching, services and CI check stand-ins. Never invokes SSH, sudo or a real runner service.
# The transported guest scripts, git bundle/clone, receipt wrapper and summary still run locally.
set -euo pipefail
tool=${0##*/}
if [[ $tool == fake-guest.sh ]]; then
  root=${FAKE_GUEST_ROOT:?test must supply an isolated guest directory}
else
  root=$(cd "${0%/*}/.." && pwd)
fi
event() { printf '%s\n' "$*" >>"$root/events"; }
assert_locked() {
  if flock -n "$root/verify.lock" -c true; then
    event lock-missing
    [[ ! -f $root/provision.sh ]] || return 0
    echo 'verification lock was released before restoration completed' >&2
    exit 97
  fi
}
scenario=$(cat "$root/scenario")
case $tool in
sudo)
  if [[ ${1:-} == bash && ${2:-} == -s ]]; then printf '%s\n' "$$" >"$root/guest-shell.pid"; fi
  [[ ${1:-} != -u ]] || shift 2
  [[ ${1:-} != -H ]] || shift
  export HOME=$root/home/runner
  exec "$@"
  ;;
systemctl)
  if [[ ${*: -1} == nftables ]]; then event "nftables $1"; exit; fi
  if [[ $1 == show ]]; then
    [[ $scenario != state-unreadable ]] || exit 1
    cat "$root/service-state"
    exit
  fi
  assert_locked
  event "$1"
  [[ $scenario != "$1-fail" ]] || exit 1
  case $1 in
  stop)
    if [[ $scenario == job-during-stop ]]; then
      # Dispatch after the idle observation, immediately before the service stop takes effect.
      printf 'new job\n' >>"$root/home/runner/actions-runner/_diag/Worker_fixture.log"
    fi
    if [[ $scenario == transient-during-stop ]]; then
      touch "$root/home/runner/actions-runner/_diag/Worker_transient.log"
      rm "$root/home/runner/actions-runner/_diag/Worker_transient.log"
    fi
    printf 'inactive\n' >"$root/service-state"
    ;;
  start) printf 'active\n' >"$root/service-state" ;;
  *) exit 2 ;;
  esac
  ;;
pgrep)
  [[ $* == '-u runner Runner.Worker' ]] || exit 2
  event pgrep
  if [[ $scenario == worker-after-observation || $scenario == drain-timeout ]]; then
    probes=0
    while read -r action; do [[ $action != pgrep ]] || probes=$((probes + 1)); done <"$root/events"
    if (( probes > 1 )); then
      [[ $scenario != drain-timeout ]] || exec sleep 2
      exit 0
    fi
  fi
  if [[ $scenario == job-after-observation ]]; then
    printf 'new job\n' >>"$root/home/runner/actions-runner/_diag/Worker_fixture.log"
  elif [[ $scenario == transient-after-observation ]]; then
    touch "$root/home/runner/actions-runner/_diag/Worker_transient.log"
    rm "$root/home/runner/actions-runner/_diag/Worker_transient.log"
  fi
  case $scenario in
  busy) exit 0 ;;
  busy-after-stop) while read -r action; do [[ $action != stop ]] || exit 0; done <"$root/events"; exit 1 ;;
  pgrep-error) exit 2 ;;
  *) exit 1 ;;
  esac
  ;;
install)
  # Account ownership is the only install behavior that needs privilege on the real guest.
  args=()
  while (( $# )); do
    case $1 in -o | -g) shift 2 ;; *) args+=("$1"); shift ;; esac
  done
  exec /usr/bin/install "${args[@]}"
  ;;
apt-get | sysctl | chown)
  event "$tool"
  ;;
id) [[ $* == runner ]] ;;
runuser)
  [[ $1 == -u && $2 == runner && $3 == -- ]] || exit 2
  shift 3
  exec "$@"
  ;;
curl)
  [[ $1 == -fsSLo && $3 == https://github.com/actions/runner/releases/download/* ]] || exit 2
  printf 'synthetic archive\n' >"$2"
  ;;
sha256sum) [[ $* == '-c -' ]]; cat >/dev/null ;;
tar)
  event extract
  [[ $scenario != tar-fail ]] || exit 1
  if [[ $scenario == provision-term ]]; then kill -TERM "$(cat "$root/guest-shell.pid")"; fi
  ;;
fake-ci-deps) event dependencies ;;
fake-ci-svc)
  # The runner's generated svc.sh, run from the runner directory.
  unit=actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm
  case $1 in
  stop | start) exec systemctl "$1" "$unit" ;;
  uninstall)
    assert_locked
    event uninstall
    # The real uninstall stops the unit before removing it.
    printf 'inactive\n' >"$root/service-state"
    rm -f .service
    ;;
  install)
    [[ ${2:-} == runner ]] || exit 2
    assert_locked
    event svc-install
    printf '%s\n' "$unit" >.service
    ;;
  *) exit 2 ;;
  esac
  ;;
fake-ci-config)
  assert_locked
  event config
  # The token arrives only in the environment, and config.sh refuses a runner that is still configured.
  [[ ${ACTIONS_RUNNER_INPUT_TOKEN:-} == synthetic-registration-token && $* != *synthetic-registration-token* ]] || exit 2
  [[ ! -e .runner && ! -e .credentials ]] || exit 2
  if [[ $scenario == config-term ]]; then kill -TERM "$(cat "$root/guest-shell.pid")"; exit 1; fi
  [[ $scenario != config-fail ]] || exit 1
  printf 'new registration\n' >.runner
  printf 'new credential\n' >.credentials
  ;;
fake-ci-chrome)
  assert_locked
  event chrome
  if [[ $scenario == guest-term ]]; then kill -TERM "$(cat "$root/guest-shell.pid")"; fi
  # Holds the checks open until the test interrupts the workstation.
  if [[ $scenario == chrome-hang ]]; then sleep 10; fi
  [[ $scenario != chrome-fail ]]
  ;;
bun)
  real_bun=$(cat "$root/real-bun")
  case ${1:-} in
  --version) exec "$real_bun" --version ;;
  install)
    [[ $* == 'install --frozen-lockfile' ]] || exit 2
    event install
    [[ $scenario != install-fail ]]
    ;;
  run)
    case ${3:-} in
    check)
      [[ $* == 'run --bun check' ]] || exit 2
      event check
      [[ $scenario != check-fail ]]
      ;;
    test)
      [[ $* == 'run --bun test --maxWorkers=6 --reporter=default --reporter=json --outputFile.json='* ]] || exit 2
      [[ $TMPDIR == "$CLEARCASE_TEST_TMP" && $TMPDIR == /dev/shm/clearcase-ci-test.* ]] || exit 2
      event test
      python3 - "${7#--outputFile.json=}" "$scenario" <<'PY'
import json, pathlib, sys
failed = sys.argv[2] == "test-fail"
status = "failed" if failed else "passed"
report = {"numTotalTests": 1, "numFailedTests": int(failed), "numPendingTests": 0, "numTodoTests": 0,
          "testResults": [{"name": str(pathlib.Path.cwd() / "tests/example.test.ts"), "status": status,
                           "message": "", "assertionResults": [{"fullName": "synthetic check", "status": status,
                           "failureMessages": ["synthetic failure"] if failed else []}]}]}
pathlib.Path(sys.argv[1]).write_text(json.dumps(report))
PY
      [[ $scenario != test-fail ]]
      ;;
    *) echo "unexpected fake bun command: $*" >&2; exit 2 ;;
    esac
    ;;
  scripts/ci/summary.ts)
    event summary
    exec "$real_bun" "$@"
    ;;
  *) echo "unexpected fake bun command: $*" >&2; exit 2 ;;
  esac
  ;;
gh)
  # GitHub's runner API for clearcase-pc1-vm. Each call records how many guest events preceded it, so tests can order
  # the pause and resume against the service stop and start. The state file holds "id status busy labelled".
  printf '%s %s\n' "$(wc -l <"$root/events")" "$*" >>"$root/github-calls"
  github=$(cat "$root/github-scenario")
  [[ $github != unreachable ]] || { echo 'error connecting to api.github.com' >&2; exit 1; }
  read -r id status busy labelled <"$root/github"
  runners=repos/GridShift-Software/clearcase/actions/runners
  case $* in
  "api $runners --jq "*)
    [[ $github != missing ]] || exit 0
    [[ $github != busy-after-pause || $labelled == true ]] || busy=true
    printf '%s\t%s\t%s\t%s\n' "$id" "$status" "$busy" "$labelled"
    ;;
  "api -X DELETE $runners/$id/labels/clearcase-pc1 --silent")
    [[ $github != pause-fail ]] || { echo 'HTTP 403: Must have admin rights to Repository.' >&2; exit 1; }
    printf '%s %s %s false\n' "$id" "$status" "$busy" >"$root/github"
    ;;
  "api -X POST $runners/$id/labels -f labels[]=clearcase-pc1 --silent")
    [[ $github != resume-fail ]] || { echo 'error connecting to api.github.com' >&2; exit 1; }
    printf '%s %s %s true\n' "$id" "$status" "$busy" >"$root/github"
    ;;
  *)
    event 'forbidden gh'
    echo "unexpected gh call: $*" >&2
    exit 99
    ;;
  esac
  ;;
ssh)
  event "forbidden $tool"
  echo "test attempted forbidden $tool call" >&2
  exit 99
  ;;
fake-guest.sh)
  if [[ ${1:-} == provision || ${1:-} == register ]]; then
    export PATH="$root/bin:$PATH" HOME="$root/home/runner"
    # Path-map the actual guest script. Every privileged/network operation is a fake tool.
    python3 - "$root" "$2" <<'PY' >"$root/provision.sh"
import pathlib, sys
root = sys.argv[1]
script = pathlib.Path(sys.argv[2]).read_text()
for source, target in [("/home/runner", root + "/home/runner"),
                       ("/etc/sysctl.d", root + "/etc/sysctl.d"),
                       ("/etc/nftables.conf", root + "/etc/nftables.conf"),
                       ("/etc/os-release", root + "/os-release"),
                       ("/usr/local/bin/bun", root + "/bin/bun"),
                       ("/run/clearcase-ci-verify.lock", root + "/verify.lock")]:
    script = script.replace(source, target)
sys.stdout.write(script)
PY
    printf '%s\n' "$$" >"$root/guest-shell.pid"
    # register reads the registration token from this process's stdin.
    [[ $1 != register ]] || exec bash "$root/provision.sh" register
    exec bash "$root/provision.sh" provision 99.0.0 "$(printf 'a%.0s' {1..64})"
  fi
  # pc1-vm passes the normal SSH options and management target to its transport override.
  while [[ ${1:-} != ciadmin@127.0.0.57 ]]; do
    (( $# )) || { echo 'missing management SSH target' >&2; exit 2; }
    shift
  done
  shift
  [[ $# == 1 ]] || { echo 'expected one remote shell command' >&2; exit 2; }
  command=$1
  export PATH="$root/bin:$PATH" HOME="$root/home/runner"
  case $command in
  'set -eu; umask 077; work='*)
    uploaded=$(bash -c "$command")
    printf '%s\n' "$uploaded" >>"$root/uploads"
    printf '%s\n' "$uploaded"
    ;;
  'sudo bash -s -- '* | 'sudo -u runner -H python3 - '*)
    script=$(mktemp "$root/transport.XXXXXX")
    trap 'rm -f "$script"' EXIT
    # Redirect only guest filesystem locations and PATH; execute the actual transported script, including its traps.
    python3 -c 'import sys
root = sys.argv[1]
script = sys.stdin.read().replace("/home/runner", root + "/home/runner")
script = script.replace("/run/clearcase-ci-verify.lock", root + "/verify.lock")
script = script.replace("PATH=/usr/local/bin:/usr/bin:/bin", "PATH=" + root + "/bin:/usr/local/bin:/usr/bin:/bin")
sys.stdout.write(script)' "$root" >"$script"
    bash -c "$command" <"$script"
    ;;
  *) echo "unexpected remote command: $command" >&2; exit 2 ;;
  esac
  ;;
*) echo "unexpected fake tool: $tool" >&2; exit 2 ;;
esac
