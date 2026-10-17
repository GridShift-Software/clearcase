# Second CI guest on pc1: instance-aware VM scripts and two jobs at once

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-140/second-ci-guest-on-pc1-instance-aware-vm-scripts-and-two-jobs-at-once) is the execution authority.

Planning key `HA-ci-second-guest`. From the read-only CI review of 17 October 2026 (`clearcase/.orchestration/reports/CI-REVIEW-20261017/report.md`). Optional: it buys redundancy and removes the 40 to 75 s queue waits when a PR run and a dev merge overlap. It does not shorten a job. Do it after the CI verdict ticket, and only after pc1's headroom is measured.

## What to build

Make `scripts/ci/vm-host.sh` and `scripts/ci/pc1-vm` instance-aware so a second guest can be created without touching the first: a template unit `clearcase-ci-vm@N`, a separate `/var/lib/clearcase-ci-N`, its own SSH forward address and port in `IPAddressAllow=` and the nft reply rule, its own nft table (today one instance's `ExecStopPost` would delete a shared table), its own QMP socket, hostname, `HostKeyAlias` and runner name, and the busy check per runner name. Instance 1 keeps today's paths. Prefer several guests over several runners in one guest: runners in one guest would share the Chrome cache that `install-chrome.sh` deletes, `~/.bun`, `/dev/shm` and one network namespace for the tests' local servers. `ci.yml` needs no change; every runner carries the `clearcase-pc1` label and the per-ref concurrency group already lets different PRs run at once.

## Before sizing

Measure RAM per job with the guest cgroup's `memory.peak` during a job, and read pc1's `nproc` and `free -g`. Plan 4 vCPU and 6 to 8 GiB per guest; N is the smaller of (threads minus 2) over 4 and (RAM minus 4 GiB) over 9. pc1 still runs desktop services (KDE Connect and CUPS were named in the <issue id="c3a1a1b4-dad8-4263-87ed-18fd3ba8a7e5" href="https://linear.app/vaper/issue/GRS-57/move-clearcase-ci-to-a-disposable-vm-runner-on-pc1">GRS-57</issue> review), so it is not yet a dedicated host; decide whether to strip those first.

## Acceptance criteria

- [ ] `pc1-vm create --instance 2` brings up a second guest and registers a second runner while instance 1 keeps running a job.
- [ ] Two CI jobs run at the same time on two guests, both PASS, with receipts.
- [ ] `scripts/ci/vm-boundary-probe` passes on both guests; neither can reach pc1's loopback, the other guest, multicast or broadcast.
- [ ] `pc1-vm destroy --instance 2` removes only instance 2's unit, directory, nft table and runner.
- [ ] `docs/ci-runner.md` documents instances, sizing numbers measured, and the host services decision.

## Reserved write scope

* scripts/ci/vm-host.sh
* scripts/ci/pc1-vm
* scripts/ci/guest-provision.sh
* docs/ci-runner.md

## Boundaries

Runner stops and host changes need the user's consent in a quiet window. No repository settings changes. One fresh independent diff review, one bounded fix round, fresh re-check. Only the coordinator changes Linear.
