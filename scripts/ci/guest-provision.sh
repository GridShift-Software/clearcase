#!/bin/bash
# Runs as root inside the CI VM, installed as /usr/local/sbin/clearcase-ci-guest by scripts/ci/pc1-vm
# (docs/ci-runner.md). Both modes are safe to rerun.
#   provision VERSION SHA256  packages, Bun, user namespaces, the egress filter and actions/runner VERSION
#   register                  register the runner with the registration token on stdin and start its service
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
runner_dir=/home/runner/actions-runner

case ${1:-} in
provision)
  version=${2:?runner version} sha=${3:?runner sha256}
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
  trap 'rm -rf "$work"' EXIT
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
    [[ ! -f $runner_dir/.service ]] || (cd "$runner_dir" && ./svc.sh stop)
    install -d -o runner -g runner "$runner_dir"
    tar -xzf "$work/runner.tar.gz" -C "$runner_dir"
    chown -R runner:runner "$runner_dir"
    echo "$version" >"$runner_dir/.clearcase-version"
    [[ ! -f $runner_dir/.service ]] || (cd "$runner_dir" && ./svc.sh start)
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
  if [[ -f .service ]]; then ./svc.sh stop; ./svc.sh uninstall; fi
  # --replace takes over the name on GitHub; the old local registration has to go first.
  rm -f .runner .credentials .credentials_rsaparams
  runuser -u runner -- ./config.sh --unattended --replace --url https://github.com/GridShift-Software/clearcase \
    --name clearcase-pc1-vm --labels clearcase-pc1 --work _work
  unset ACTIONS_RUNNER_INPUT_TOKEN
  ./svc.sh install runner
  ./svc.sh start
  ;;
*)
  echo "usage: clearcase-ci-guest provision VERSION SHA256 | register" >&2
  exit 2
  ;;
esac
