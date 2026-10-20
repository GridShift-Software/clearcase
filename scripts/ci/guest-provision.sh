#!/bin/bash
# Runs as root inside the CI VM, installed as /usr/local/sbin/clearcase-ci-guest by scripts/ci/pc1-vm
# (docs/ci-runner.md). Both modes are safe to rerun.
#   provision VERSION SHA256  packages, Bun, user namespaces, the egress filter and actions/runner VERSION
#   register                  register the runner with the registration token on stdin and start its service; a
#                             failure before config.sh succeeds restores the previous registration and service state
# Both also own the runner's admission hook (GRS-158): provision installs it and the systemd drop-in that turns it on,
# register refuses to run, and refuses to start the service, without it. The files, the variable and why a denial
# stops the worker are in docs/ci-runner.md ("Public repository").
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
runner_dir=/home/runner/actions-runner
hook_dir=/usr/local/lib/clearcase-ci
hook=$hook_dir/job-started-hook.sh
policy=$hook_dir/job-started-policy.py
dropin_dir=/etc/systemd/system/actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm.service.d
dropin=$dropin_dir/10-clearcase-admission.conf

# The runner runs the script ACTIONS_RUNNER_HOOK_JOB_STARTED names as the first step of every job, as the runner user,
# before checkout and before any of the job's own steps. It is a step like the others: a non-zero exit fails the job,
# but the worker goes on to run the job's `if: always()` steps (actions/runner 2.338.0, StepsRunner.cs), which is where
# a fork's code would run. So a denial ends the Runner.Worker process above the hook; the job then completes as failed
# and no step runs. Any way out of this script other than the policy's explicit success is a denial.
admission_hook() {
  cat <<'HOOK'
#!/bin/bash
# Job-started hook of the ClearCase CI runner (GRS-158, docs/ci-runner.md). Installed root-owned by clearcase-ci-guest.
set -u
log=/home/runner/clearcase-admission.log

# The Runner.Worker above this script, which runs the job's steps after it.
find_worker() {
  local pid=$$ stat comm rest ppid
  while (( pid > 1 )); do
    read -r stat <"/proc/$pid/stat" || return 1
    comm=${stat#*(}
    comm=${comm%)*}
    if [[ $comm == Runner.Worker ]]; then echo "$pid"; return 0; fi
    rest=${stat##*) }
    read -r _ ppid _ <<<"$rest"
    pid=$ppid
  done
  return 1
}

clean() { local text=${1:-}; text=${text//[^A-Za-z0-9_.\/: ()-]/?}; printf '%s' "${text:0:240}"; }

deny() {
  local worker
  trap - EXIT HUP INT TERM
  ( umask 077; printf '%s denied event=%s repository=%s reason=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$(clean "${GITHUB_EVENT_NAME:-}")" "$(clean "${GITHUB_REPOSITORY:-}")" "$(clean "${reason:-no reason: the policy did not run}")" >>"$log" ) 2>/dev/null || true
  echo 'clearcase-ci admission: denied; ending the runner worker so that no later step of this job runs' >&2
  if worker=$(find_worker) && kill -KILL "$worker" 2>/dev/null; then
    exit 1
  fi
  echo 'clearcase-ci admission: found no Runner.Worker to end; the job fails, but its always() steps may still run' >&2
  exit 1
}
trap deny EXIT
trap 'exit 1' HUP INT TERM

reason= status=0
reason=$(/usr/bin/python3 -I /usr/local/lib/clearcase-ci/job-started-policy.py 2>&1) || status=$?
echo "$reason"
(( status == 0 )) || exit 1
trap - EXIT
exit 0
HOOK
}

# What the hook decides from. The runner writes the event payload it received from GitHub to its own temp directory just
# before it runs the hook, and sets GITHUB_REPOSITORY, GITHUB_EVENT_NAME and GITHUB_REF from the job it was given; a
# workflow's `env:` is not passed to the hook, and the hook reads no other environment variable.
admission_policy() {
  cat <<'POLICY'
# Policy of the ClearCase CI runner's job-started hook (GRS-158, docs/ci-runner.md). Exit 0 admits the job, anything else
# denies it. Runs as `python3 -I`, so the environment cannot add modules to it.
import json
import os
import sys
import time

REPO = "GridShift-Software/clearcase"
EVENT_PATH = "/home/runner/actions-runner/_work/_temp/_github_workflow/event.json"
EVENTS = ("pull_request", "push", "workflow_dispatch")
MAX_BYTES = 8 * 1024 * 1024
MAX_AGE_SECONDS = 300


class Denied(Exception):
    pass


def refuse(why):
    raise Denied(why)


def unique(items):
    out = {}
    for key, value in items:
        if key in out:
            refuse("the event payload repeats the key " + repr(key))
        out[key] = value
    return out


def constant(name):
    refuse("the event payload holds " + name)


def read_payload():
    path = os.environ.get("GITHUB_EVENT_PATH", "")
    if path != EVENT_PATH:
        refuse("GITHUB_EVENT_PATH is not the runner's event file")
    if os.path.realpath(path) != path:
        refuse("the event file is reached through a link")
    info = os.lstat(path)
    if (info.st_mode & 0o170000) != 0o100000:
        refuse("the event file is not a regular file")
    if info.st_size > MAX_BYTES:
        refuse("the event file is too large")
    age = time.time() - info.st_mtime
    if age > MAX_AGE_SECONDS or age < -60:
        refuse("the event file was not written for this job")
    with open(path, "rb") as handle:
        data = handle.read(MAX_BYTES + 1)
    payload = json.loads(data.decode("utf-8"), object_pairs_hook=unique, parse_constant=constant)
    if not isinstance(payload, dict):
        refuse("the event payload is not an object")
    return payload


def child(node, *keys):
    for key in keys:
        node = node.get(key) if isinstance(node, dict) else None
    return node


def own(node, where):
    if not isinstance(node, dict) or node.get("full_name") != REPO:
        refuse(where + " is not " + REPO)


def decide(event, payload):
    ref = os.environ.get("GITHUB_REF")
    if event not in EVENTS:
        refuse("a " + repr(event) + " event does not run on this runner")
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        refuse("GITHUB_REPOSITORY is not " + REPO)
    own(payload.get("repository"), "the repository the event happened in")
    if event == "pull_request":
        own(child(payload, "pull_request", "head", "repo"), "the pull request's head repository")
        own(child(payload, "pull_request", "base", "repo"), "the pull request's base repository")
    # A push or a manual run whose payload also holds a pull request is not what GitHub sends for either.
    if event == "push" and not (payload.get("ref") == "refs/heads/dev" and ref == "refs/heads/dev" and "pull_request" not in payload):
        refuse("only a push to refs/heads/dev runs here")
    if event == "workflow_dispatch" and not (isinstance(ref, str) and ref and payload.get("ref") == ref and "pull_request" not in payload):
        refuse("the manual run's ref does not match its event")


def main():
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    try:
        decide(event, read_payload())
    except Denied as why:
        print("clearcase-ci admission: denied: " + str(why), file=sys.stderr)
        return 1
    except BaseException as error:  # a payload that cannot be read or understood is a denial too
        print("clearcase-ci admission: denied: cannot decide (" + type(error).__name__ + ")", file=sys.stderr)
        return 1
    print("clearcase-ci admission: admitted a " + event + " event of " + REPO)
    return 0


sys.exit(main())
POLICY
}

admission_dropin() {
  cat <<DROPIN
# Written by clearcase-ci-guest (GRS-158); provision rewrites it. Makes the runner run the job-started hook.
[Service]
Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook
DROPIN
}
# Whether systemd has loaded the drop-in's variable for the runner service (its unit file exists), which is what
# the next start of the service gives its processes.
admission_loaded() {
  local loaded
  loaded=$(systemctl show --property=Environment --value "$1") || return 1
  [[ " $loaded " == *" ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook "* ]]
}

case ${1:-} in
provision)
  version=${2:?runner version} sha=${3:?runner sha256}
  unit=actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm
  entry_state= work= restore_active=0 reload_pending=0 hold=0
  finish_provision() {
    local status=$? restored_state
    trap - EXIT HUP INT TERM
    # The runner never starts on a configuration systemd has not read, or without the admission hook loaded.
    if (( reload_pending )); then
      systemctl daemon-reload || { echo 'provision: systemd could not reload; leaving the runner stopped' >&2; hold=1; status=1; }
    fi
    if (( hold )); then
      status=1
    else
      if (( restore_active )); then
        systemctl start "$unit" || { echo 'provision: runner restart failed' >&2; status=1; }
      fi
      case $entry_state in
        active | inactive | failed)
          restored_state=$(systemctl show --property=ActiveState --value "$unit") || restored_state=unreadable
          if [[ $restored_state != "$entry_state" ]]; then
            echo "provision: runner service state was not restored to $entry_state" >&2
            status=1
          fi
          ;;
      esac
    fi
    [[ -z $work ]] || rm -rf "$work" || status=1
    exit "$status"
  }
  trap finish_provision EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # Share verify's lock through all mutations, restoration and cleanup.
  exec 9>/run/clearcase-ci-verify.lock
  flock -n 9 || { echo 'provision: another verification or provision is running' >&2; exit 1; }
  if [[ -f $runner_dir/.service ]]; then
    entry_state=$(systemctl show --property=ActiveState --value "$unit") ||
      { echo 'provision: could not read runner service state; refusing provision' >&2; exit 1; }
    case $entry_state in
      active | inactive | failed) ;;
      *) echo 'provision: could not read a stable runner service state; refusing provision' >&2; exit 1 ;;
    esac
  fi
  apt-get update -q
  apt-get -y -q full-upgrade
  # Chrome for Testing's linux64 deb.deps, plus what the checks and the runner need.
  apt-get -y -q install --no-install-recommends ca-certificates curl git unzip python3 iproute2 nftables \
    fonts-liberation libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
    libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0t64 libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libudev1 \
    libvulkan1 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils

  # The browser tests run Chromium in its own network namespace (unshare -rn), which Ubuntu 24.04's AppArmor policy
  # refuses to unprivileged users by default.
  echo 'kernel.apparmor_restrict_unprivileged_userns = 0' >/etc/sysctl.d/60-clearcase-ci-userns.conf
  sysctl -q -p /etc/sysctl.d/60-clearcase-ci-userns.conf

  id runner &>/dev/null || useradd --create-home --shell /bin/bash runner
  runuser -u runner -- mkdir -p -m 0700 /home/runner/ci-results

  # Jobs run as runner and reach only the internet: not the host behind 10.0.2.2, the LAN or the tailnet. The VM's
  # service unit on pc1 enforces the same for every uid; this is a second layer.
  cat >/etc/nftables.conf <<'NFT'
#!/usr/sbin/nft -f
table inet clearcase_ci
delete table inet clearcase_ci
table inet clearcase_ci {
  chain output {
    type filter hook output priority filter; policy accept;
    ct state established,related accept
    meta skuid != "runner" accept
    ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } reject
    ip6 daddr { fc00::/7, fe80::/10, fec0::/10 } reject
  }
}
NFT
  systemctl enable -q nftables
  systemctl restart nftables

  work=$(mktemp -d)
  if [[ $(/usr/local/bin/bun --version 2>/dev/null) != 1.4.2 ]]; then
    curl -fsSLo "$work/bun.zip" https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip
    echo "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913  $work/bun.zip" | sha256sum -c -
    unzip -q "$work/bun.zip" -d "$work"
    install -m 0755 "$work/bun-linux-x64/bun" /usr/local/bin/bun
  fi

  if [[ $(cat "$runner_dir/.clearcase-version" 2>/dev/null) != "$version" ]]; then
    curl -fsSLo "$work/runner.tar.gz" \
      "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz"
    echo "$sha  $work/runner.tar.gz" | sha256sum -c -
    # Unpacking over a running service, or one that has updated itself, would mix two versions.
    if [[ $entry_state == active ]]; then
      restore_active=1
      systemctl stop "$unit"
    fi
    install -d -o runner -g runner "$runner_dir"
    tar -xzf "$work/runner.tar.gz" -C "$runner_dir"
    chown -R runner:runner "$runner_dir"
    echo "$version" >"$runner_dir/.clearcase-version"
  fi

  # The admission hook (GRS-158): root-owned files outside the runner's directory, which the runner user can read and run
  # but not change, and a drop-in that gives the runner service the variable the runner reads at its start. A runner that
  # is running has to restart to read it, so a change stops it first (the same restore as for a new runner version, under
  # the same lock), and systemd reloads before it starts again.
  staged=$work/admission
  mkdir "$staged"
  admission_hook >"$staged/hook"
  admission_policy >"$staged/policy"
  admission_dropin >"$staged/dropin"
  changed=0
  cmp -s "$staged/hook" "$hook" && cmp -s "$staged/policy" "$policy" && cmp -s "$staged/dropin" "$dropin" || changed=1
  if (( changed )) && [[ $entry_state == active ]] && (( ! restore_active )); then
    restore_active=1
    systemctl stop "$unit"
  fi
  reload_pending=1
  install -d -o root -g root -m 0755 "$hook_dir"
  install -d -o root -g root -m 0755 "$dropin_dir"
  install -o root -g root -m 0755 "$staged/hook" "$hook"
  install -o root -g root -m 0644 "$staged/policy" "$policy"
  install -o root -g root -m 0644 "$staged/dropin" "$dropin"
  systemctl daemon-reload
  reload_pending=0
  if [[ -f $runner_dir/.service ]] && ! admission_loaded "$unit"; then
    # Not started, and not left running if it was: a runner without the hook admits whatever GitHub sends it.
    hold=1
    [[ $entry_state != active ]] || (( restore_active )) || systemctl stop "$unit"
    echo 'provision: the admission hook is not loaded by systemd for the runner service; leaving the runner stopped' >&2
    exit 1
  fi
  "$runner_dir/bin/installdependencies.sh" >/dev/null
  # Recorded in docs/ci-runner.md and the handoff: the image, kernel and tools are not pinned.
  echo "versions: $(. /etc/os-release && echo "$PRETTY_NAME"), kernel $(uname -r), actions/runner $version, bun $(/usr/local/bin/bun --version)"
  ;;
register)
  ACTIONS_RUNNER_INPUT_TOKEN=$(head -c 200)
  [[ -n $ACTIONS_RUNNER_INPUT_TOKEN ]] || { echo "register: no token on stdin" >&2; exit 2; }
  # config.sh reads the token from the environment, so it never appears in a process list.
  export ACTIONS_RUNNER_INPUT_TOKEN
  cd "$runner_dir"
  unit=actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm
  entry_state= backup= entry_files= uninstalled=0 registered=0
  # Until config.sh succeeds, every exit puts back the previous registration and the entry state, under the lock.
  finish_register() {
    local status=$? restored_state file
    trap - EXIT HUP INT TERM
    if (( ! registered )); then
      # Put back exactly the files that existed at entry, dropping only those a failed config.sh wrote. A file that existed
      # at entry and was not moved yet (a failed or interrupted move aside) is the original: leave it.
      if [[ -n $backup ]]; then
        for file in .runner .credentials .credentials_rsaparams; do
          if [[ -e $backup/$file ]]; then mv -f "$backup/$file" "$file" || status=1
          elif [[ " $entry_files " != *" $file "* ]]; then rm -f "$file" || status=1
          fi
        done
      fi
      if (( uninstalled )); then ./svc.sh install runner || status=1; fi
      if [[ $entry_state == active ]]; then
        systemctl start "$unit" || { echo 'register: runner restart failed' >&2; status=1; }
      fi
      if [[ -n $entry_state ]]; then
        restored_state=$(systemctl show --property=ActiveState --value "$unit") || restored_state=unreadable
        # A reinstalled unit starts inactive, so failed comes back as inactive.
        if [[ $restored_state != "$entry_state" && ! ( $entry_state == failed && $restored_state == inactive ) ]]; then
          echo "register: runner service state was not restored to $entry_state" >&2
          status=1
        fi
      fi
    fi
    if [[ -n $backup ]]; then
      # Keep the previous credential if it could not be put back.
      if (( registered )); then rm -rf "$backup" || status=1
      else rmdir "$backup" || { echo "register: the previous registration is still in $backup" >&2; status=1; }
      fi
    fi
    exit "$status"
  }
  trap finish_register EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  exec 9>/run/clearcase-ci-verify.lock
  flock -n 9 || { echo 'register: another verification or provision is running' >&2; exit 1; }
  # A registered runner without the admission hook (GRS-158) would take whatever GitHub sends it.
  [[ -x $hook && -r $policy && -r $dropin ]] && grep -qxF "Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook" "$dropin" ||
    { echo 'register: the admission hook is not installed; run provision first' >&2; exit 1; }
  if [[ -f .service ]]; then
    entry_state=$(systemctl show --property=ActiveState --value "$unit") ||
      { echo 'register: could not read runner service state; refusing registration' >&2; exit 1; }
    case $entry_state in
      active | inactive | failed) ;;
      *) echo 'register: could not read a stable runner service state; refusing registration' >&2; exit 1 ;;
    esac
    [[ $entry_state != active ]] || ./svc.sh stop
    # Set before the call: a partial uninstall still needs the unit back.
    uninstalled=1
    ./svc.sh uninstall
  fi
  # --replace takes over the name on GitHub; the old local registration has to go first. Keep it until config.sh succeeds.
  for file in .runner .credentials .credentials_rsaparams; do [[ ! -e $file ]] || entry_files+=" $file"; done
  backup=$(mktemp -d)
  for file in .runner .credentials .credentials_rsaparams; do [[ ! -e $file ]] || mv "$file" "$backup/"; done
  runuser -u runner -- ./config.sh --unattended --replace --url https://github.com/GridShift-Software/clearcase \
    --name clearcase-pc1-vm --labels clearcase-pc1 --work _work
  registered=1
  unset ACTIONS_RUNNER_INPUT_TOKEN
  ./svc.sh install runner
  admission_loaded "$unit" ||
    { echo 'register: the admission hook is not loaded by systemd for the reinstalled runner service; not starting it' >&2; exit 1; }
  ./svc.sh start
  ;;
*)
  echo "usage: clearcase-ci-guest provision VERSION SHA256 | register" >&2
  exit 2
  ;;
esac
