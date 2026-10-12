# CI runner on pc1

CI (`.github/workflows/ci.yml`) runs `bun run --bun check` and `bun run --bun test` on one self-hosted GitHub Actions runner, `clearcase-pc1-vm`, inside a disposable KVM virtual machine on pc1. The full case-fixture gate stays on workers' machines; nothing on the VM holds case material.

## What runs where

| Where | What | Created by |
| --- | --- | --- |
| Workstation | `~/.config/clearcase-ci/pc1-vm_ed25519` (guest management key) and `known_hosts` | `scripts/ci/pc1-vm` |
| pc1 host | `/var/lib/clearcase-ci/` (`disk.qcow2`, `seed.iso`, `console.log`, `powerdown`), system user `clearcase-ci`, `/etc/systemd/system/clearcase-ci-vm.service`, packages `qemu-system-x86`, `qemu-img`, `libisoburn` | `scripts/ci/vm-host.sh` |
| Guest | Ubuntu 24.04 cloud image, 4 vCPU, 8 GiB, 40 GiB sparse disk; admin user `ciadmin`; runner user `runner` (no sudo); Bun 1.4.2 in `/usr/local/bin`; runner in `/home/runner/actions-runner`; service `actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm` | `scripts/ci/guest-provision.sh`, installed as `/usr/local/sbin/clearcase-ci-guest` |

The runner is repository-scoped, with labels `self-hosted`, `Linux`, `X64` and `clearcase-pc1`. The job installs Chrome for Testing 148.0.7778.96 into the runner's home with `scripts/ci/install-chrome.sh` and wraps each check in `scripts/agent-tools/receipt`; the receipts are uploaded as the `receipts` artifact.

## Isolation

- The workflow runs the job only for pushes, manual runs and pull requests whose head is in this repository. A fork's pull request is skipped and never reaches the runner.
- QEMU runs as the unprivileged `clearcase-ci` user under systemd sandboxing, with only `/dev/kvm` and its own directory. There are no shared folders, host sockets or credentials in the guest.
- The guest uses QEMU user-mode networking. Its only inbound path is SSH forwarded from `127.0.0.1:2257` on pc1. The service's `IPAddressDeny=` keeps the VM off private ranges, the tailnet and pc1's own networks; inside the guest, nftables stops the `runner` user from reaching `10.0.2.2` (pc1's loopback) and private ranges.
- Ubuntu 24.04 refuses unprivileged user namespaces by default, and the browser tests need them (`unshare -rn`). The guest sets `kernel.apparmor_restrict_unprivileged_userns = 0` in `/etc/sysctl.d/60-clearcase-ci-userns.conf`, so jobs don't need sudo.
- Registration uses a one-hour token piped from `gh api` into the guest; it is never printed, stored or passed on a command line. The runner keeps only its own runner credential.

## Commands

Run these from a checkout on a workstation with `ssh root@ci-host.example.invalid` (pc1 over Tailscale) and an admin `gh` login. Override the host with `CLEARCASE_CI_HOST`.

| Command | Effect |
| --- | --- |
| `scripts/ci/pc1-vm create` | Create the key if needed, build and start the VM, provision it and register the runner |
| `scripts/ci/pc1-vm provision` | Rerun guest provisioning: package upgrades, Bun, latest actions/runner |
| `scripts/ci/pc1-vm register` | Register again with a fresh token, replacing the runner of the same name |
| `scripts/ci/pc1-vm ssh [COMMAND]` | SSH to the guest as `ciadmin`, through pc1 to `127.0.0.1:2257` |
| `scripts/ci/pc1-vm status`, `stop`, `start`, `restart` | `systemctl` on `clearcase-ci-vm.service`; `stop` powers the guest off cleanly |
| `scripts/ci/pc1-vm destroy` | Delete the runner from GitHub, then stop the VM and delete everything `create` made on pc1 |

`vm-host.sh` installs the QEMU packages without syncing pacman's database, so it never partially upgrades pc1. When that database is older than the mirrors, a few files 404; on 12 October 2026 the fix was to install `wolfssl-5.9.2-1`, `vde2-2.3.3-9` and `iniparser-4.3.0-1` from `https://archive.archlinux.org/packages/` with `pacman -U --asdeps`, then rerun `create`.

The VM starts on boot and the runner service starts with the guest. `create` refuses to run while `/var/lib/clearcase-ci/disk.qcow2` exists, so recreating is `destroy` then `create`. It fetches the current Ubuntu 24.04 cloud image and the latest actions/runner, and checks both against published SHA-256 sums.

`destroy` removes only the runner named `clearcase-pc1-vm`, `clearcase-ci-vm.service`, `/var/lib/clearcase-ci` and the `clearcase-ci` user. The QEMU packages stay; remove them with `pacman -Rs qemu-system-x86 qemu-img libisoburn` on pc1 if nothing else uses them. The same thing by hand on pc1:

```sh
gh api repos/GridShift-Software/clearcase/actions/runners --jq '.runners[] | select(.name == "clearcase-pc1-vm") | .id'
gh api -X DELETE repos/GridShift-Software/clearcase/actions/runners/RUNNER_ID   # from the workstation
systemctl disable --now clearcase-ci-vm.service                                 # on pc1, as root
rm -f /etc/systemd/system/clearcase-ci-vm.service && systemctl daemon-reload
rm -rf /var/lib/clearcase-ci && userdel clearcase-ci
```

## Running the CI checks by hand in the guest

```sh
scripts/ci/pc1-vm ssh
sudo -iu runner
git clone https://github.com/GridShift-Software/clearcase.git  # needs a token for the private repo; or copy a bundle
cd clearcase && ~/clearcase/scripts/ci/install-chrome.sh && bun install --frozen-lockfile
bun run --bun check && bun run --bun test
```

The guest holds no GitHub credential, so get the source in with `git bundle` over the SSH link rather than putting a token in the VM.
