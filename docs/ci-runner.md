# CI runner on pc1

CI (`.github/workflows/ci.yml`) runs `bun run --bun check` and `bun run --bun test` on one self-hosted GitHub Actions runner, `clearcase-pc1-vm`, inside a disposable KVM virtual machine on pc1. The full case-fixture gate stays on workers' machines; nothing on the VM holds case material.

## What runs where

| Where | What | Created by |
| --- | --- | --- |
| Workstation | `~/.config/clearcase-ci/pc1-vm_ed25519` (guest management key) and `known_hosts` | `scripts/ci/pc1-vm` |
| pc1 host | `/var/lib/clearcase-ci/` (`disk.qcow2`, `seed.iso`, `console.log`, `powerdown`), system user `clearcase-ci`, `/etc/systemd/system/clearcase-ci-vm.service`, `/etc/clearcase-ci-vm.nft` and the nftables table `inet clearcase_ci_vm` it loads while the VM runs, packages `qemu-system-x86`, `qemu-img`, `libisoburn`, `nftables`, `socat` | `scripts/ci/vm-host.sh` |
| Guest | Ubuntu 24.04 cloud image, 4 vCPU, 8 GiB, 40 GiB sparse disk; admin user `ciadmin`; runner user `runner` (no sudo); Bun 1.4.2 in `/usr/local/bin`; runner in `/home/runner/actions-runner`; service `actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm` | `scripts/ci/guest-provision.sh`, installed as `/usr/local/sbin/clearcase-ci-guest` |

The runner is repository-scoped, with labels `self-hosted`, `Linux`, `X64` and `clearcase-pc1` (the workflow names them in that case). The job installs Chrome for Testing 148.0.7778.96 into the runner's home with `scripts/ci/install-chrome.sh` (it unpacks a tree again only when the tree's `.zip-sha256` stamp does not name the checked zip) and wraps each check in `scripts/agent-tools/receipt --base origin/dev` after a full-history checkout. The receipts, Vitest's JSON report `vitest.json`, the summary and a `run-metadata.json` (run ID and attempt, `GITHUB_SHA`, event, ref, pull request head SHA where there is one, runner name; no environment dump) are uploaded as the `receipts` artifact, which fails the job when it is empty.

CI runs for pull requests (on GitHub's merge commit), pushes to `dev` and manual runs (`workflow_dispatch`). A push to a feature branch runs nothing until its pull request exists. That push run used to duplicate the PR run of the same commit on the one runner, so the PR run queued behind it for 110-140 s. The cost: a branch gets no CI before its pull request is opened. The worker's local `bun run --bun gate`, which is required anyway, covers that stretch, and a manual run covers a branch on request (`gh workflow run CI --ref BRANCH`). A newer run of a pull request cancels the superseded one. A push to `dev` never cancels a run in progress, but GitHub keeps only one pending run per branch and replaces it with a newer one, so quick successive pushes can lose the middle commits' results (the last push always runs).

## Test step and timings

The test step puts its temporary files (`TMPDIR` and `CLEARCASE_TEST_TMP`) in a fresh directory on `/dev/shm`, removed when the step ends, and runs Vitest with six workers and its JSON reporter. The reasons, from GRS-60's measurements on this VM (synthetic data only, scratch checkouts and caches):

- The limiter was disk sync. The unit tests commit to SQLite with `synchronous=FULL`, and on the VM's ext4 disk in qcow2 each fsync is slow: a store's startup took about 200 ms there. On tmpfs the test files' summed time fell from 216 s to 117 s. Workers' machines already have tmpfs `/tmp`, so CI now matches them. Durability under power loss was never something a unit test could observe. The test files used under 64 MB of `/dev/shm`.
- The other limiter was sleeping. Four unit tests hold `work.sqlite`'s write lock through every attempt and expect the 503, and each waited the production 9.5 s (4 × `busy_timeout` 2,000 ms plus 1.5 s of backoff). They now use `withoutBusyWait` (`src/lib/local-case/test-support.ts`), which sets the connection's `busy_timeout` to 0 for that write only, so the held lock, `SQLITE_BUSY`, the four attempts, the backoff and the 503 all stay real. `src/lib/local-case/busy.test.ts` runs the production budget end to end and fails if `busy_timeout` or the backoff changes. Tests that release the lock during the wait keep the production timing, and so do the e2e lanes in the local gate.
- `vitest.config.ts` starts the files that wait longest first (`SLOW`). On a fresh checkout Vitest otherwise orders files by size, which put them last.
- Six workers on four vCPUs, because much of the run is asleep. The run takes about 85 CPU-seconds, so four vCPUs set a floor of about 21 s. Eight workers came within 1 s of that floor, but the load average reached 9, and one of six trials with eight workers failed `tests/gate/pidfile.test.ts` because an orphan was not reaped in time. Six workers ran clean.

Measured on 12 October 2026 by running each commit's own workflow steps in scratch homes on this VM. Each side had one cold run (empty home: Chrome download, empty Bun cache), then five warm runs, alternating with the other side. Times are medians in seconds, with the warm range; the queue is not included. Both sides passed every run: 1943 tests before, 1979 after (the 36 new ones are GRS-60's).

| step | before (`6edaff0`) warm | after (`cd6845e`) warm | before cold | after cold |
| --- | --- | --- | --- | --- |
| install Chrome | 3.7 (3.7-3.7) | 0.2 (0.2-0.2) | 32.7 | 33.7 |
| `check` | 10.0 (10.0-10.1) | 10.3 (10.1-10.5) | 10.5 | 10.8 |
| `test` | 87.2 (84.4-90.2) | 25.4 (25.2-25.5) | 84.3 | 25.3 |
| whole job | 101.3 (98.5-104.4) | 36.3 (35.9-36.4) | 134.1 | 76.4 |

`check` grew 0.3 s with `source-check`. Removing the duplicate push run saves queue time, which this table does not show: on 12 October such a run held the runner for 110-140 s while the pull request run waited.

## What a failed run tells an agent

The `summary` step runs even after a failure. It writes the job summary, and `summary.md` and `summary.json` into the `receipts` artifact. It fails the job, with exit 1, unless the `check` and `test` receipts both exist for the checked-out HEAD, ran on a clean tree, and say PASS with exit 0, and unless `vitest.json` lists every tracked `*.test.ts` file (except `tests/acceptance/`, which Vitest never collects) with at least one test, none failed and none skipped. A skipped test fails the job, because a skip usually means a missing tool. Each problem names:

- its check (`check` or `test`);
- the file and line where there is one: `tsc`'s `file(line,col): error TSnnnn`, `svelte-check`'s machine output, `source-check`'s `path:line:col: error [rule]`, or a failing test's line from Vitest's task location;
- the raw diagnostic, or the contract that failed (a missing receipt, a receipt for another revision, a skipped test, a test file missing from the report);
- the command that reproduces it, such as `bun run --bun test tests/a.test.ts -t 'name'` or the receipt's own command.

Read it with `gh run view RUN_ID` (the summary) or `gh run download RUN_ID -n receipts` (`summary.json`, and the full logs in each receipt's `stdout.txt` and `stderr.txt`). `bun scripts/ci/summary.ts DIR check test` runs the same verdict on local receipts.

## Isolation

- **The VM is disposable, a job is not.** The runner is persistent: it keeps its credentials, binaries (`/home/runner/actions-runner`, writable by `runner`), caches and `_work` between jobs, and one job can alter what every later job runs. There is no per-job isolation and no ephemeral runner. Run only code from trusted writers; the isolation boundary is the VM, and `destroy` followed by `create` removes all state it retained, including the runner credential, which `create` replaces with a new one.
- **Fork pull requests are blocked by the repository's settings.** The repository is private with `allow_forking: false` and `run_workflows_from_fork_pull_requests: false` (read on 12 October 2026 from `gh api repos/GridShift-Software/clearcase` and `.../actions/permissions/fork-pr-workflows-private-repos`). The job's `if:` guard also skips fork pull requests, but it is not a control: a fork could supply its own workflow file with the runner's labels. Do not relax those settings or make the repository public while this runner is registered.
- QEMU runs as the unprivileged `clearcase-ci` user under systemd sandboxing, with only `/dev/kvm` and its own directory. There are no shared folders, host sockets or credentials in the guest.
- **The guest cannot reach pc1's own services, even as root.** QEMU's user-mode network turns the guest's `10.0.2.2` into pc1's loopback, and guest root can hand QEMU raw frames for any address, such as `127.0.0.53:1716`, which QEMU then connects to from pc1. So the boundary is on the host, around the QEMU process:
  - `clearcase-ci-vm.service` sets `IPAddressDeny=` for all of `127.0.0.0/8` and `::1`, private ranges, the tailnet and pc1's own networks, and `IPAddressAllow=` for `127.0.0.57` (the SSH forward) and `127.0.0.53` (the resolver QEMU forwards the guest's DNS to). These lists are per address, not per port.
  - Before QEMU starts, the service loads the nftables table `inet clearcase_ci_vm` from `/etc/clearcase-ci-vm.nft`, and deletes it after QEMU stops. Its output chain drops every packet that the `clearcase-ci` user sends to pc1 itself (routed through `lo`), except DNS (TCP and UDP port 53) to `127.0.0.53` and replies on connections that came in to `127.0.0.57:2257`. A connection QEMU opens from that port is not a reply, so it is dropped too. The table touches no other table or user. Flushing pc1's whole ruleset (`nft flush ruleset`, or starting `nftables.service` after the VM) removes it while the VM runs; run `scripts/ci/pc1-vm restart` afterwards.
  - The same table also drops, for that user and on any interface, IPv4 multicast (`224.0.0.0/4`), the limited broadcast `255.255.255.255` and IPv6 multicast (`ff00::/8`), and `IPAddressDeny=` lists the same three. These leave through pc1's LAN interface, not `lo`, so the `lo` rules never see them, yet pc1's wildcard mDNS and LLMNR listeners receive them by multicast loopback.
  - The only inbound path is SSH forwarded from `127.0.0.57:2257` on pc1. Because the service's source address must be allowed, `pc1-vm` reaches the guest through `socat` on pc1 bound to `127.0.0.57`.
  - `scripts/ci/vm-boundary-probe` proves this from guest root with raw frames: it fails if any of pc1's loopback addresses answers on a denied port, over TCP or UDP, or if a wildcard listener on pc1 receives raw UDP from the guest sent to a synthetic multicast group (`239.255.57.57`) or to `255.255.255.255`, and checks that DNS, HTTPS to github.com and management SSH still work. It changes nothing on pc1 or in the guest, so it can run while a job does.
  - Inside the guest, nftables additionally stops the `runner` user from reaching `10.0.2.2` and private ranges.
- The deny list of pc1's own networks is read when the unit is written, at `create`. After pc1's addresses or routes change, run `scripts/ci/pc1-vm refresh` to rewrite the unit and restart the VM.
- Ubuntu 24.04 refuses unprivileged user namespaces by default, and the browser tests need them (`unshare -rn`). The guest sets `kernel.apparmor_restrict_unprivileged_userns = 0` in `/etc/sysctl.d/60-clearcase-ci-userns.conf`, so jobs don't need sudo. That widens the guest's kernel attack surface, which is why the host boundary above matters.
- Registration uses a one-hour token piped from `gh api` into the guest; it is never printed, stored or passed on a command line. The runner keeps only its own runner credential.

## Commands

Run these from a checkout on a workstation with `ssh root@100.80.13.122` (pc1 over Tailscale) and an admin `gh` login. `verify` and `verdict` need only management SSH, without a GitHub login or API request. Override the host with `CLEARCASE_CI_HOST`.

`provision`, `refresh` and `restart` refuse to run unless GitHub reports `clearcase-pc1-vm` as registered and idle, because they would kill a running job: a GitHub API error or a runner missing from the list also refuses. Only `create` provisions a VM that isn't registered yet. `stop` does not check.

| Command | Effect |
| --- | --- |
| `scripts/ci/pc1-vm create` | Create the key if needed, build and start the VM, provision it and register the runner |
| `scripts/ci/pc1-vm provision` | Rerun guest provisioning: package upgrades, Bun, latest actions/runner (the runner service stops while a new version unpacks, then starts) |
| `scripts/ci/pc1-vm register` | Register again with a fresh token, replacing the runner of the same name |
| `scripts/ci/pc1-vm refresh` | Rewrite the service unit and `/etc/clearcase-ci-vm.nft` with pc1's current networks and restart the VM; the disk and runner stay |
| `scripts/ci/pc1-vm ssh [COMMAND]` | SSH to the guest as `ciadmin`, through pc1 to `127.0.0.57:2257` |
| `scripts/ci/pc1-vm verify REV` | Bundle the committed revision and cached `origin/dev`, run the CI commands in the idle guest, store receipts and print `PASS SHA` or `FAIL SHA` plus the receipt directory |
| `scripts/ci/pc1-vm verdict SHA` | Read the most recent completed result for a full commit SHA; print its verdict and receipt directory, or `UNKNOWN SHA` (exit 2) |
| `scripts/ci/pc1-vm status`, `stop`, `start`, `restart` | `systemctl` on `clearcase-ci-vm.service`; `stop` powers the guest off cleanly |
| `scripts/ci/vm-boundary-probe` | Check from guest root that pc1's loopback, multicast and broadcast are closed and DNS, github.com and SSH work; exits 1 on any reachable denied port |
| `scripts/ci/pc1-vm destroy` | Delete the runner from GitHub, then stop the VM and delete everything `create` made on pc1 |

`vm-host.sh` installs the QEMU packages without syncing pacman's database, so it never partially upgrades pc1. When that database is older than the mirrors, a few files 404; on 12 October 2026 the fix was to install `wolfssl-5.9.2-1`, `vde2-2.3.3-9` and `iniparser-4.3.0-1` from `https://archive.archlinux.org/packages/` with `pacman -U --asdeps`, then rerun `create`.

The VM starts on boot and the runner service starts with the guest. `create` refuses to run while `/var/lib/clearcase-ci/disk.qcow2` exists, so recreating is `destroy` then `create`. It fetches the current Ubuntu 24.04 cloud image and the latest actions/runner, and checks both against published SHA-256 sums. Neither is pinned, so `provision` prints the versions it ends with. On 12 October 2026 they were Ubuntu 24.04.5 LTS (cloud image serial 20260926), kernel 6.8.0-146-generic, actions/runner 2.338.0, Bun 1.4.2, Chrome for Testing 148.0.7778.96 and QEMU 11.1.1 on pc1.

`destroy` removes only the runner named `clearcase-pc1-vm`, `clearcase-ci-vm.service`, `/etc/clearcase-ci-vm.nft`, the `inet clearcase_ci_vm` table, `/var/lib/clearcase-ci` and the `clearcase-ci` user. The packages stay; `nftables` and `socat` were already on pc1 on 12 October 2026, so remove only the QEMU ones with `pacman -Rs qemu-system-x86 qemu-img libisoburn` if nothing else uses them. The same thing by hand on pc1:

```sh
gh api repos/GridShift-Software/clearcase/actions/runners --jq '.runners[] | select(.name == "clearcase-pc1-vm") | .id'
gh api -X DELETE repos/GridShift-Software/clearcase/actions/runners/RUNNER_ID   # from the workstation
systemctl disable --now clearcase-ci-vm.service                                 # on pc1, as root
rm -f /etc/systemd/system/clearcase-ci-vm.service /etc/clearcase-ci-vm.nft && systemctl daemon-reload
nft delete table inet clearcase_ci_vm 2>/dev/null                               # normally gone when the service stops
rm -rf /var/lib/clearcase-ci && userdel clearcase-ci
```

## Running the CI checks by hand in the guest

Prefer `scripts/ci/pc1-vm verify REV`, described below: it checks for a running job, captures receipts and restarts the runner through an exit trap. The older manual recipe below requires those precautions from the operator.

Stop the runner service first, so a live job doesn't race this run for `~/.cache` and `~/.bun`, and start it again afterwards. The guest holds no GitHub credential, so send the source over the SSH link as a bundle and run the job's commands as `runner`:

```sh
git branch -f ci-bundle HEAD && git bundle create /tmp/ci.bundle ci-bundle && git branch -D ci-bundle
scripts/ci/pc1-vm ssh 'sudo systemctl stop actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm'   # only when no job is running
scripts/ci/pc1-vm ssh 'cat > /tmp/ci.bundle && chmod 644 /tmp/ci.bundle' < /tmp/ci.bundle
scripts/ci/pc1-vm ssh 'sudo -u runner -H bash -c "cd && rm -rf by-hand && git clone -q -b ci-bundle /tmp/ci.bundle by-hand && cd by-hand &&
  scripts/ci/install-chrome.sh && bun install --frozen-lockfile && bun run --bun check &&
  t=\$(mktemp -d /dev/shm/by-hand.XXXXXX) && TMPDIR=\$t CLEARCASE_TEST_TMP=\$t bun run --bun test --maxWorkers=6; s=\$?; rm -rf \$t; exit \$s"'
scripts/ci/pc1-vm ssh 'sudo systemctl start actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm'
```

Recreating the VM registers a new runner ID under the same name and labels, so the workflow needs no change.

## Verdicts without GitHub

```sh
GH_HOST=github.invalid scripts/ci/pc1-vm verify HEAD
GH_HOST=github.invalid scripts/ci/pc1-vm verdict FULL_40_CHARACTER_SHA
```

`verify` resolves `REV` in the script's checkout and sends only that commit's history and the locally cached `origin/dev` history as a Git bundle. It neither fetches nor changes local refs; uncommitted edits are excluded. The cached base must exist because the job's receipt commands use `--base origin/dev`. Both commands use the existing workstation-to-guest management SSH path; no listener, guest credential or guest-to-host connection is added. `CLEARCASE_CI_SSH` is an executable SSH transport override for the local fake-guest tests; leave it unset for real management SSH.

The guest holds one `flock` across admission, service stop, checks, restoration and verdict publication. Before stopping anything it reads systemd's `ActiveState`; unreadable or transitional states refuse verification. An active service is stopped and restored to active after success, failure or HUP/INT/TERM, including a failed stop. An inactive or failed service is left untouched, preserving its entry state without starting it. The exit trap checks that the final state matches the entry state, removes the uploaded bundle and checkout, and reports FAIL if restoration fails. `guest-provision.sh provision` takes the same lock and reads a registered service's entry state before any provisioning mutation. Version replacement stops only an active-at-entry service; its EXIT trap restores that state and removes scratch after success, failure or HUP/INT/TERM under the lock. First provision without a registered service leaves service startup to `register`. A powered-off guest, SIGKILL or broken systemd cannot be repaired by a shell trap.

Admission defaults to a bounded quiet-period drain before any service stop. It requires three consecutive idle observations spanning at least five seconds, with `pgrep -u runner Runner.Worker` absent at each and unchanged Worker diagnostics throughout. An initial busy runner refuses immediately; activity at a later observation refuses with exit 3 before stopping or running checks. The lock remains held throughout. `CLEARCASE_CI_QUIET_SECONDS` (default `5`), `CLEARCASE_CI_IDLE_OBSERVATIONS` (default `3`) and `CLEARCASE_CI_DRAIN_TIMEOUT` (default `30`) are forwarded as numeric arguments to the guest; quiet/timeout accept decimal seconds. Require `0 < quiet <= timeout <= 300` and `2..100` observations. Samples are spaced by `quiet / (observations - 1)`; the sampling loop uses a monotonic deadline and bounds its process probes by the remaining time. Timeout refuses with exit 3; it never proceeds on a partial quiet period. Inspection/configuration errors also fail closed.

The snapshots include Worker log names, inodes, sizes and nanosecond modification/change times, plus the diagnostic directory's inode, size and modification/change times. Directory changes conservatively refuse even if a transient Worker log has already vanished; listener log creation/rotation can also cause a refusal. Writes to existing listener logs are excluded. After stop, compare the original snapshot again and require no worker before running checks; activity in that final interval refuses and restores the service. Missing, unsafe or changing diagnostic history refuses admission. This relies on the guest filesystem recording metadata changes; snapshots do not provide a filesystem event journal.

The bounded wait is the offline fallback, not an admission switch in the running listener. In the [runner listener source](https://github.com/actions/runner/blob/main/src/Runner.Listener/Runner.cs), `--once` is selected at process startup; changing a live registered service to it would itself require a stop/restart. Listener shutdown [cancels running dispatches](https://github.com/actions/runner/blob/main/src/Runner.Listener/JobDispatcher.cs), so ordinary service stop does not establish a graceful drain. No usable live offline drain control is established here. Verification makes no GitHub API calls to disable dispatch.

The guarantee is observed local quiet before stop and refusal on recorded activity through stop. **Residual window:** the listener still accepts jobs during the quiet period and between the final observation and completion of `systemctl stop`. A newly dispatched job can still be interrupted; acceptance killed before a worker or recorded metadata change can remain invisible. The manual lock serializes verify/provision, not GitHub dispatch. Once stopped, this assumes systemd has quiesced the listener and nobody independently starts it. This fallback reduces the race and detects the tested transient-log cases; it does not guarantee that no job is ever interrupted. Other subcommands retain their GitHub-based `not_busy` checks.

Checks run as `runner` in a fresh bundle clone with a minimal environment (`CI=true`). The commands match the job: install Chrome, `bun install --frozen-lockfile`, the `check` and six-worker tmpfs `test` steps under `scripts/agent-tools/receipt --base origin/dev`, then `summary.ts` even after a failed check. A missing, failed or skipped check cannot produce PASS.

Results live on the guest's persistent disk, owned by `runner`:

```text
/home/runner/ci-results/<full-sha>-<run>-<attempt>/
  verdict.txt              # PASS <full-sha> or FAIL <full-sha>; published last
  run-metadata.json        # checkout_head, GITHUB_SHA, PR_HEAD_SHA, run/attempt; no environment dump
  <timestamp>-check/       # receipt.json (if check ran)
  <timestamp>-test/        # receipt.json (if test ran)
  summary.json, summary.md # if summary ran
```

For manual verification `run` is `verify` and `attempt` is a unique suffix; its GitHub SHA and PR head fields are empty. Manual receipts are written directly into the store and additionally retain `stdout.txt`, `stderr.txt` and `vitest.json`. Every GitHub job copies only regular `receipt.json` files and the top-level `summary.json`/`summary.md` into `<GITHUB_SHA>-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`. It rejects symlinks, special files and paths resolving outside the receipt directory, and never copies raw stdout/stderr into the persistent store. Metadata is regenerated from the allowlist. The existing Actions artifact upload still uploads the original receipt directory, including raw output; this change does not scrub that artifact or manual output.

GitHub entries record both `GITHUB_SHA` and `PR_HEAD_SHA`, and store FAIL if an earlier step failed or the summary is missing or fails. For a PR, the key and verdict refer to GitHub's tested merge commit; `PR_HEAD_SHA` records the branch head without giving it a verdict. Results survive guest reboot and are lost on `destroy`; no automatic retention cleanup is installed.

`verify` exits 0 only for PASS and nonzero for refusal, failure or transport errors. `verdict` requires the full SHA and exits 0 for a stored PASS, 1 for a stored FAIL, or 2 for UNKNOWN. It ignores unfinished entries and entries naming another SHA, chooses the latest completed `verdict.txt` modification time (directory name breaks ties), and prints the guest's receipt directory. Reads use non-following directory/file descriptors, `lstat`-equivalent checks and realpath containment. A symlinked store root, matching entry or verdict, or an unsafe path encountered while opening it, returns UNKNOWN/2 with a reason, even alongside a valid result. Transport errors still fail the command. Paths in copied receipt JSON refer to the original checkout or Actions temporary directory; workflow entries omit the raw output those paths name.

The store is evidence for an honest rerun, not a signature: **any job can write it**, alter caches or forge previous results. It has the same trusted-writer assumption as a push to this runner. Receipt and metadata commands add no tokens, credentials or environment dump; trusted code must also keep secrets out of its output. A `verify` PASS proves only that the bundled SHA passed `check` and `test` in the CI VM environment. It says nothing about GitHub check status, branch protection, a different head or merge commit, the full case-fixture gate, or the external reviewer's approval.

## Known limits

Accepted and not fixed in GRS-57:

- The receipts compare against a hardcoded `origin/dev`, whatever a pull request's base is, so a stacked pull request is compared with `dev`, not its parent branch.
- `run-metadata.json` is evidence about a run, not a check. Since GRS-60 the `summary` step fails the job when a `check` or `test` receipt is missing, belongs to another revision, or is not a PASS.
- If guest provisioning fails while the runner is stopped for an upgrade (for example in the `tar` unpack), the runner service stays stopped. Rerun `scripts/ci/pc1-vm provision`, or start the service in the guest.
- `wait_guest` runs a second SSH command for `cloud-init status --wait`; if that command fails with an SSH error it is reported as a cloud-init error with exit 255.
- `nft flush ruleset` on pc1 removes the boundary table until the VM restarts, a host reboot has not been tested, and the busy check can race a job that starts just after it.

## Review, 17 October 2026

A read-only review at `origin/dev` `8ab9ef4` of the last 30 CI runs (12 to 15 October). Verdict: CI is already fast. The gap is independence from GitHub, not speed. Step times come from GitHub's whole-second timestamps.

| Median seconds (range) | 6 runs before GRS-60 | 23 runs on GRS-60 code |
| --- | --- | --- |
| Queue wait | 48 (4-105) | 4 (3-75) |
| Job | 116 (60-122) | 57 (54-88) |
| `check` | 10 | 11 |
| `test` | 85 | 28 |
| Checkout, setup-bun, install-chrome, `bun install` | 1.5, 0, 4, 0 | 2, 0, 0, 0 |

- Queue waits over 30 s: 5 of 29. Two were a push run and a PR run of the same SHA, which GRS-60 removed. Two were one run waiting behind another on the single runner (75 s and 42 s). One was the first run after setup.
- No infrastructure failures. "Set up job" took 12 to 16 s on 15 October against 3 to 4 s on other days.
- All 9 failures in the last 200 runs were `bun run --bun test` failures under the pre-GRS-57 workflow.

pc1 headroom, measured 17 October 09:43 SAST after the Tailscale re-login (read-only): AMD Ryzen 7 8700F with 8 cores and 16 threads, load 0.33 over 21 days of uptime. RAM 30 GiB with 19 GiB available, swap unused. 399 GB free on the disk that holds `/var/lib/clearcase-ci`. The guest is `-smp 4 -m 8G` with `MemoryMax=11G`. `plasmalogin.service` and `cups.service` are desktop services, so pc1 is not yet a dedicated host. By the formula `min((threads - 2) / 4, (RAM - 4 GiB) / 9)` there is room for two guests at 4 vCPU and 8 GiB, or three if `memory.peak` confirms 6 GiB is enough. One 8 vCPU guest also fits.

Proposals, ranked by payoff per hour:

1. **GitHub-independent verdict (about 4 h).** `pc1-vm verify REV` runs the job's exact commands in the guest under `receipt` and writes a verdict. A receipt store in the guest, keyed by commit, lets `pc1-vm verdict SHA` answer for any SHA that GitHub or `verify` already ran. No new listener, no credential in the guest. It proves one bundle's SHA passed `check` and `test` in the CI VM. It does not satisfy branch protection or the external reviewer. Ticket: [GRS-139](https://linear.app/vaper/issue/GRS-139/ci-verdict-without-github-pc1-vm-verify-and-verdict-answer-pass-or).
2. **Second guest (about 1 day).** Instance-aware `vm-host.sh` and `pc1-vm`, one guest per runner, to remove the 40 to 75 s queues when merges overlap and to keep CI up when one guest is down. It does not shorten a job. Do it after the verdict ticket. Ticket: [GRS-140](https://linear.app/vaper/issue/GRS-140/second-ci-guest-on-pc1-instance-aware-vm-scripts-and-two-jobs-at-once).
3. **Faster single job (1 to 3 h each, 10 to 20 s of the 57 s).** An 8 vCPU guest, then `check` and `test` as parallel jobs once a second guest exists. Caching is already done. Not ticketed.
4. **Hosted workerd gate in the same job (2 to 4 h).** The guest needs nothing new as root. `workerd` arrives through `bun install`, D1 and R2 run under Miniflare with their persist directory under `/dev/shm`, and no Cloudflare binding or token enters the job. It is an acceptance item of [GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before).
