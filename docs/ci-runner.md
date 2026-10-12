# CI runner on pc1

CI (`.github/workflows/ci.yml`) runs `bun run --bun check` and `bun run --bun test` on one self-hosted GitHub Actions runner, `clearcase-pc1-vm`, inside a disposable KVM virtual machine on pc1. The full case-fixture gate stays on workers' machines; nothing on the VM holds case material.

## What runs where

| Where | What | Created by |
| --- | --- | --- |
| Workstation | `~/.config/clearcase-ci/pc1-vm_ed25519` (guest management key) and `known_hosts` | `scripts/ci/pc1-vm` |
| pc1 host | `/var/lib/clearcase-ci/` (`disk.qcow2`, `seed.iso`, `console.log`, `powerdown`), system user `clearcase-ci`, `/etc/systemd/system/clearcase-ci-vm.service`, packages `qemu-system-x86`, `qemu-img`, `libisoburn` | `scripts/ci/vm-host.sh` |
| Guest | Ubuntu 24.04 cloud image, 4 vCPU, 8 GiB, 40 GiB sparse disk; admin user `ciadmin`; runner user `runner` (no sudo); Bun 1.4.2 in `/usr/local/bin`; runner in `/home/runner/actions-runner`; service `actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm` | `scripts/ci/guest-provision.sh`, installed as `/usr/local/sbin/clearcase-ci-guest` |

The runner is repository-scoped, with labels `self-hosted`, `Linux`, `X64` and `clearcase-pc1` (the workflow names them in that case). The job installs Chrome for Testing 148.0.7778.96 into the runner's home with `scripts/ci/install-chrome.sh` and wraps each check in `scripts/agent-tools/receipt --base origin/dev` after a full-history checkout. The receipts and a `run-metadata.json` (run ID and attempt, `GITHUB_SHA`, event, ref, pull request head SHA where there is one, runner name; no environment dump) are uploaded as the `receipts` artifact, which fails the job when it is empty. Newer runs of the same ref cancel superseded ones.

## Isolation

- **The VM is disposable, a job is not.** The runner is persistent: it keeps its credentials, binaries (`/home/runner/actions-runner`, writable by `runner`), caches and `_work` between jobs, and one job can alter what every later job runs. There is no per-job isolation and no ephemeral runner. Run only code from trusted writers; the isolation boundary is the VM, and `destroy` followed by `create` removes all state it retained, including the runner credential, which `create` replaces with a new one.
- **Fork pull requests are blocked by the repository's settings.** The repository is private with `allow_forking: false` and `run_workflows_from_fork_pull_requests: false` (read on 12 October 2026 from `gh api repos/GridShift-Software/clearcase` and `.../actions/permissions/fork-pr-workflows-private-repos`). The job's `if:` guard also skips fork pull requests, but it is not a control: a fork could supply its own workflow file with the runner's labels. Do not relax those settings or make the repository public while this runner is registered.
- QEMU runs as the unprivileged `clearcase-ci` user under systemd sandboxing, with only `/dev/kvm` and its own directory. There are no shared folders, host sockets or credentials in the guest.
- **The guest cannot reach pc1's own services, even as root.** QEMU's user-mode network turns the guest's `10.0.2.2` into pc1's loopback, so the boundary is on the host. The only inbound path is SSH forwarded from `127.0.0.57:2257` on pc1. `clearcase-ci-vm.service` sets `IPAddressDeny=` for all of `127.0.0.0/8` and `::1`, private ranges, the tailnet and pc1's own networks, and `IPAddressAllow=` for just `127.0.0.57` (the forward) and `127.0.0.53` (the resolver QEMU forwards the guest's DNS to). Because the service's source address must be allowed, `pc1-vm` reaches the guest through `socat` on pc1 bound to `127.0.0.57`. Inside the guest, nftables additionally stops the `runner` user from reaching `10.0.2.2` and private ranges.
- The deny list of pc1's own networks is read when the unit is written, at `create`. After pc1's addresses or routes change, run `scripts/ci/pc1-vm refresh` to rewrite the unit and restart the VM.
- Ubuntu 24.04 refuses unprivileged user namespaces by default, and the browser tests need them (`unshare -rn`). The guest sets `kernel.apparmor_restrict_unprivileged_userns = 0` in `/etc/sysctl.d/60-clearcase-ci-userns.conf`, so jobs don't need sudo. That widens the guest's kernel attack surface, which is why the host boundary above matters.
- Registration uses a one-hour token piped from `gh api` into the guest; it is never printed, stored or passed on a command line. The runner keeps only its own runner credential.

## Commands

Run these from a checkout on a workstation with `ssh root@100.80.13.122` (pc1 over Tailscale) and an admin `gh` login. Override the host with `CLEARCASE_CI_HOST`.

| Command | Effect |
| --- | --- |
| `scripts/ci/pc1-vm create` | Create the key if needed, build and start the VM, provision it and register the runner |
| `scripts/ci/pc1-vm provision` | Rerun guest provisioning: package upgrades, Bun, latest actions/runner (the runner service stops while a new version unpacks, then starts) |
| `scripts/ci/pc1-vm register` | Register again with a fresh token, replacing the runner of the same name |
| `scripts/ci/pc1-vm refresh` | Rewrite the service unit with pc1's current networks and restart the VM; the disk and runner stay |
| `scripts/ci/pc1-vm ssh [COMMAND]` | SSH to the guest as `ciadmin`, through pc1 to `127.0.0.57:2257` |
| `scripts/ci/pc1-vm status`, `stop`, `start`, `restart` | `systemctl` on `clearcase-ci-vm.service`; `stop` powers the guest off cleanly |
| `scripts/ci/pc1-vm destroy` | Delete the runner from GitHub, then stop the VM and delete everything `create` made on pc1 |

`vm-host.sh` installs the QEMU packages without syncing pacman's database, so it never partially upgrades pc1. When that database is older than the mirrors, a few files 404; on 12 October 2026 the fix was to install `wolfssl-5.9.2-1`, `vde2-2.3.3-9` and `iniparser-4.3.0-1` from `https://archive.archlinux.org/packages/` with `pacman -U --asdeps`, then rerun `create`.

The VM starts on boot and the runner service starts with the guest. `create` refuses to run while `/var/lib/clearcase-ci/disk.qcow2` exists, so recreating is `destroy` then `create`. It fetches the current Ubuntu 24.04 cloud image and the latest actions/runner, and checks both against published SHA-256 sums. Neither is pinned, so `provision` prints the versions it ends with. On 12 October 2026 they were Ubuntu 24.04.5 LTS (cloud image serial 20260926), kernel 6.8.0-146-generic, actions/runner 2.338.0, Bun 1.4.2, Chrome for Testing 148.0.7778.96 and QEMU 11.1.1 on pc1.

`destroy` removes only the runner named `clearcase-pc1-vm`, `clearcase-ci-vm.service`, `/var/lib/clearcase-ci` and the `clearcase-ci` user. The QEMU packages stay; remove them with `pacman -Rs qemu-system-x86 qemu-img libisoburn` on pc1 if nothing else uses them. The same thing by hand on pc1:

```sh
gh api repos/GridShift-Software/clearcase/actions/runners --jq '.runners[] | select(.name == "clearcase-pc1-vm") | .id'
gh api -X DELETE repos/GridShift-Software/clearcase/actions/runners/RUNNER_ID   # from the workstation
systemctl disable --now clearcase-ci-vm.service                                 # on pc1, as root
rm -f /etc/systemd/system/clearcase-ci-vm.service && systemctl daemon-reload
rm -rf /var/lib/clearcase-ci && userdel clearcase-ci
```

## Running the CI checks by hand in the guest

Stop the runner service first, so a live job doesn't race this run for `~/.cache` and `~/.bun`, and start it again afterwards. The guest holds no GitHub credential, so send the source over the SSH link as a bundle and run the job's commands as `runner`:

```sh
git branch -f ci-bundle HEAD && git bundle create /tmp/ci.bundle ci-bundle && git branch -D ci-bundle
scripts/ci/pc1-vm ssh 'sudo systemctl stop "actions.runner.*"'   # only when no job is running
scripts/ci/pc1-vm ssh 'cat > /tmp/ci.bundle && chmod 644 /tmp/ci.bundle' < /tmp/ci.bundle
scripts/ci/pc1-vm ssh 'sudo -u runner -H bash -c "cd && rm -rf by-hand && git clone -q -b ci-bundle /tmp/ci.bundle by-hand && cd by-hand &&
  scripts/ci/install-chrome.sh && bun install --frozen-lockfile && bun run --bun check && bun run --bun test"'
scripts/ci/pc1-vm ssh 'sudo systemctl start "actions.runner.*"'
```

Recreating the VM registers a new runner ID under the same name and labels, so the workflow needs no change.
