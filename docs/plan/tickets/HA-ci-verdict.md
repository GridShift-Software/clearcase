# CI verdict without GitHub: pc1-vm verify and verdict answer PASS or FAIL from the CI VM alone

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-139/ci-verdict-without-github-pc1-vm-verify-and-verdict-answer-pass-or) is the execution authority.

## User decision — 19 October 2026

The user authorizes maintenance while CI is free. Let active jobs finish before stopping/restarting the runner for the outstanding real-runner acceptance scenarios. New CI jobs may queue until maintenance finishes. If maintenance will take a while, a separate runner may be brought up after the existing sizing/isolation prerequisites are satisfied. Restore and verify service on exit and report exact-SHA evidence for the previously unproven scenarios. This adds no cloud unpin, production change or permission to interrupt active CI.

---

Planning key `HA-ci-verdict`. From the read-only CI review of 17 October 2026 (`clearcase/.orchestration/reports/CI-REVIEW-20261017/report.md`). Infrastructure work on the CI runner, not hosted-app work; it may run before the hosted plan gate.

## Why

CI is already fast (median job 57 s, median queue 4 s over the last 23 runs, no infrastructure failures). The gap is that an agent cannot learn whether a SHA passed when GitHub is down, and the runner's own idle check asks the GitHub API and fails closed in that case. Recent GitHub outages made this matter.

## What to build

1. `scripts/ci/pc1-vm verify REV`: bundle the revision, confirm in the guest that no job is running without asking GitHub (`pgrep -u runner Runner.Worker`), stop the runner service, run the job's exact commands under `scripts/agent-tools/receipt`, run the summary, write the result to the store below, restart the runner, and print `PASS <sha>` or `FAIL <sha>` plus the receipt path. Exit 0 only on PASS.
2. A receipt store in the guest keyed by commit: `~runner/ci-results/<sha>-<run>-<attempt>/`, written by every GitHub-dispatched job as one extra workflow step (recording both `GITHUB_SHA` and `PR_HEAD_SHA`, since a PR run tests the merge commit) and by `verify`. The guest cannot reach pc1 by design, so the store lives in the guest and is read over the existing management SSH; do not open a guest-to-host path.
3. `scripts/ci/pc1-vm verdict SHA`: read the store and print the verdict and receipt path for a SHA GitHub or `verify` already ran, or `UNKNOWN`.

## Acceptance criteria

- [ ] With GitHub unreachable (simulate by pointing `GH_HOST` at a dead name), `verify` still produces a verdict for a fresh bundle, and `verdict` still answers for a SHA that ran earlier.
- [ ] `verify` refuses to start while a job is running and never leaves the runner service stopped; a failed run restarts it.
- [ ] A `verify` verdict names what it proves (that bundle's SHA passed `check` and `test` in the CI VM environment) and does not claim a GitHub check status or satisfy branch protection or the external reviewer.
- [ ] Receipts carry no tokens or secrets; the store survives a guest reboot and is documented as lost on `destroy`.
- [ ] `docs/ci-runner.md` documents both commands, the store layout and the trust model (any job can write the store; it is as trusted as a push).

## Reserved write scope

* scripts/ci/pc1-vm
* scripts/ci/guest-provision.sh (store directory only)
* .github/workflows/ci.yml (one receipt-store step)
* docs/ci-runner.md
* tests/ci/\*\* (new)

## Verification and boundaries

Prove on the real runner in a quiet window with the user's consent for the runner stop; keep the boundary probe green afterwards (`scripts/ci/vm-boundary-probe`). pc1 access over Tailscale needs a human re-login first (the review stalled on it). No changes to repository settings, no new listener on pc1, no credential in the guest. One fresh independent diff review, one bounded fix round, fresh re-check. Only the coordinator changes Linear.
