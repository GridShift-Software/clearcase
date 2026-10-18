#!/bin/bash
# Runs as root inside the CI VM, installed as /usr/local/sbin/clearcase-ci-guest by scripts/ci/pc1-vm
# (docs/ci-runner.md). Both modes are safe to rerun.
#   provision VERSION SHA256  packages, Bun, user namespaces, the egress filter and actions/runner VERSION
#   register                  register the runner with the registration token on stdin and start its service; a
#                             failure before config.sh succeeds restores the previous registration and service state
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
runner_dir=/home/runner/actions-runner

case ${1:-} in
provision)
  version=${2:?runner version} sha=${3:?runner sha256}
  unit=actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm
  entry_state= work= restore_active=0
  finish_provision() {
    local status=$? restored_state
    trap - EXIT HUP INT TERM
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
  entry_state= backup= uninstalled=0 registered=0
  # Until config.sh succeeds, every exit puts back the previous registration and the entry state, under the lock.
  finish_register() {
    local status=$? restored_state file
    trap - EXIT HUP INT TERM
    if (( ! registered )); then
      for file in .runner .credentials .credentials_rsaparams; do
        [[ -z $backup || ! -e $backup/$file ]] || mv -f "$backup/$file" "$file" || status=1
      done
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
    [[ -z $backup ]] || rm -rf "$backup" || status=1
    exit "$status"
  }
  trap finish_register EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  exec 9>/run/clearcase-ci-verify.lock
  flock -n 9 || { echo 'register: another verification or provision is running' >&2; exit 1; }
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
  backup=$(mktemp -d)
  for file in .runner .credentials .credentials_rsaparams; do [[ ! -e $file ]] || mv "$file" "$backup/"; done
  runuser -u runner -- ./config.sh --unattended --replace --url https://github.com/GridShift-Software/clearcase \
    --name clearcase-pc1-vm --labels clearcase-pc1 --work _work
  registered=1
  unset ACTIONS_RUNNER_INPUT_TOKEN
  ./svc.sh install runner
  ./svc.sh start
  ;;
*)
  echo "usage: clearcase-ci-guest provision VERSION SHA256 | register" >&2
  exit 2
  ;;
esac
