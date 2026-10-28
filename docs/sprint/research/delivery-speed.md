# Delivery speed: where the loop's time goes, and a sub-2-hour ticket loop (research, 28 Oct 2026)

Measured on a detached scratch worktree at `sprint/hosted-demo-20261105` = `21dfb2b7` (20 cores, 15 GB, Bun 1.4.2). The worktree was removed afterwards. No gate or gate:hosted was run in full; their numbers come from past logs under `.orchestration/reports/` and from GitHub run metadata. Nothing was edited, committed or deployed.

## 1. Measured timings (this machine, one run each unless stated)
| Step | Wall time | Notes |
| --- | --- | --- |
| `bun install --frozen-lockfile` cold / warm | 1.2 s / 0.007 s | 248 packages; a fresh worktree costs nothing |
| `bunx svelte-kit sync` | 0.6 s | needed before tsc or vitest in a fresh worktree |
| `tsc --noEmit -p .` | 9.4 s | PASS |
| `svelte-check --fail-on-warnings` | 12.4 s | 2,692 files, PASS |
| `check:hosted-imports` | 1.8 s | PASS |
| `scripts/agent-tools/doctor` | 0.5 s | 26 checks PASS |
| full `bun run --bun test` (vitest) | **138 s** | 459 files, 9,527 tests; sum of per-file time 1,640 s; 2 FAIL = `tests/hosting-probe/identity/*` (needs its own `bun install`, the gate's `install:identity` step) |
| targeted `test tests/hosted-smoke` | 7.7 s | 40 files |
| targeted `test tests/publication` | 3.9 s | 24 files |
| `vitest related src/lib/views/analysis/contradictions.ts --run` | 3.4 s | found and ran 3 test files |
| `vitest list --changed` (one edited src file) | 3.2 s | lists the 3 related files; works here |
| `bun run --bun build` | 3.1 s | |
| `bun run --bun build:hosted` | 5.7 s | artifact stamped with HEAD, 182 modules scanned |
| `bun run --bun check` (sum of its parts) | about 30 s | sync, hosted-imports, tsc, schema checks, registry check, svelte-check, links, source-check |
| CI job on pc1 VM (4 vCPU), run 40315126037 | check 25 s, test 177 s, gate-hosted 79 s | total 3.5 to 5.2 min; 9.4 to 9.7 min when queued behind another run (one runner) |
| `gate` steps from past logs | build 3 to 6 s, check 10 to 14 s, test 67 to 92 s, **test:e2e 1,086 to 2,105 s**, parity 216 to 227 s, verify:pilot:v5 24 to 30 s | 25 to 45 min, plus a browser slot wait (recorded 180 s; cap 45 min) |
| `gate:hosted` from past logs | test:hosted 96 s; about 2 to 3 min locally | 79 s on CI |

**Ten slowest test files** (seconds in the full run; all PASS): `tests/gate/reviewed-python-file-protection.test.ts` 112 (spawns git repos), `tests/results-review/native/staged-scale-fix2.test.ts` 89, `tests/hosted-foundation/artifact-scope/artifact-scope.test.ts` 80 (builds into temp dirs), `recovery-native-evidence/adverse.test.ts` 76, `recovery-http/authority.test.ts` 75, `recovery-native-evidence/file-set.test.ts` 72, `recovery-native-evidence/privacy-liveness.test.ts` 68, `tests/ci/pc1-vm-verification.test.ts` 57, `recovery-native-evidence/io-order.test.ts` 49, `tests/ci/pc1-vm-github-lifecycle.test.ts` 46. By directory: `tests/hosted-foundation` 842 s of 1,640 (161 files), `tests/gate` 172, `tests/results-review` 162, `tests/ci` 144; everything the sprint touches (`hosted-smoke`, `publication`, `src/lib`, `bundles`, `registers`, `system`) is under 130 s combined. The recovery tests use no timers or spawns; they are CPU-bound evidence and hash builds. Global `testTimeout` is 60 s; 70 test files set five-digit millisecond timeouts; only two real sleeps exist (`tests/bundles/r2-store.test.ts`, 1.5 s and 1.2 s).

## 2. Where the hours went (27 October units, from report mtimes in `reports/alpha-hardening-20261027/`)
| Unit | Build report → last re-check | Rounds | Shape |
| --- | --- | --- | --- |
| runtime-config | 07:07 → 07:17 | 1 fix | 10 min: the loop's floor when nothing waits |
| brand-tokens | 07:22 → 07:46 | 2 re-checks | 24 min |
| rx-asset-policy | 13:46 → 14:29 | 3 re-checks | 43 min; fix3 re-check closed the Medium as a prerequisite, not a bug |
| staff-callback | 07:38 → 10:13 | 6 fix rounds | 2 h 35 m; about 25 min per round (fix 8 to 15 min, fresh re-check 8 to 10 min, launch gaps between) |
| session-renewal (refresh, live-2, live-3, r4, r5) | 08:38 → 18:09 | 5 rounds + 4 Astra live runs | 9.5 h; each Astra run about 25 min; the real cause needed a design change |

Where it goes, in order of size: (1) **review and re-check rounds**: every Medium cost a fresh reviewer session plus a fresh re-check, about 25 min a round, and 57% of briefs were reviews, fixes or re-checks; (2) **the heavy gate on the combined head**: `test:e2e` alone is 18 to 35 min, and the gate waits for a browser slot (two host-wide slots, 15 s polls, 45 min cap, a 3,500 MB memory gate, 25 min watchdog) while `dev-gate` runs a full gate per dev commit in a fresh worktree; (3) **live proof**: Astra journeys at 15 to 25 min each, serialized behind the same lock; (4) **the dev PR**: ticket-to-wave PRs merged in 0.0 to 0.2 h, but wave-to-dev PRs took 1.0 to 7.3 h (#154 7.3 h with 4 reviews, #153 5.7 h, #114 6.3 h, #135 28 h) through Greptile loops, CI reruns and merge records. CI itself was never the bottleneck (3.5 to 5 min), except queueing on the single runner (9.7 min). Deploy was not the bottleneck either: `build:hosted` 6 s, `deploy/probes/target.ts stage` 0.3 s, `wrangler deploy` typically 20 to 60 s; the 25 Oct pipeline evidence run covered 13 legs in 62 s. There is no `fast-deploy-b.sh` in the repo or `orch-bin/`; B was deployed through `deploy/native-alpha/pipeline.ts` (`NATIVE_UPLOAD_ARGV = wrangler deploy --config`).

**Register-your-test guards that make parallel PRs collide:** `tests/parity/m2-base.test.ts` hard-codes project file counts (the last sprint-branch commit bumped 15 → 16 to admit one intake test); `tests/ci/pc1-vm-test-inventory.json` lists 115 scenario names and `pc1-vm-split-inventory.test.ts` checks it; `scripts/ci/summary.ts` fails CI for any tracked `*.test.ts` the root run did not collect, mirrored by `tests/ci/test-collection.test.ts`; `scripts/pilot/generate-view-registry.ts --check` regenerates `src/lib/components/view-registry.ts` from `docs/plan/view-coverage.json`, so every new view edits the same two files; `export-schemas --check`; the fix-round-guard manifests and the approval hook (already parked by the sprint plan).

## 3. CI today and CI-lite for PRs into the sprint branch
`ci.yml` runs on every `pull_request` whatever the base, so a PR into the sprint branch already triggers the full job: checkout, test guard (two extra worktrees and a trusted install), Chrome install, `bun install`, `check` (25 s), Node setup, identity install, `test --maxWorkers=6` (177 s), `gate:hosted` on workerd (79 s), summary, verdict store, artifact upload. Runner: one self-hosted `clearcase-pc1-vm` (4 vCPU, 8 GiB, labels `self-hosted, Linux, X64, clearcase-pc1`). Wall 3.5 to 5.2 min; a second PR waits for the whole run.

**CI-lite (budget 8 min, aim 3):** a job keyed on `github.base_ref == 'sprint/hosted-demo-20261105'`, the existing job keyed on everything else.
1. checkout, setup-bun, `bun install` (10 s warm). 2. `tsc` + `svelte-check` + `check:hosted-imports` (30 s on 4 vCPU). 3. `vitest run --changed origin/sprint/hosted-demo-20261105` plus the fixed set `tests/hosted-smoke tests/publication src/lib` (60 to 90 s). 4. `build:hosted` (10 s): proves the bundle. 5. `gate:hosted` only when `deploy/` or `src/lib/server` changed (80 s). Skip: test guard, identity install, Chrome, receipts wrapper, verdict store (keep the artifact). Expected 2 to 4 min, with `gate:hosted` 3.5 to 5.5 min. The full job still runs on the sprint-to-dev PR. Add a second runner (a boat.dev VM registered with the same labels, or a second pc1 VM) so two developers' PRs do not queue; that alone removes the 9.7 min cases.

## 4. The fast loop: ticket to merged PR in under 2 hours
Per-ticket checks, in order, with budgets (local, from the measurements above):
| # | Step | Budget | Why |
| --- | --- | --- | --- |
| 1 | `git worktree add` from the sprint branch, `bun install`, `svelte-kit sync`, `doctor` | 10 s | all measured under 2 s |
| 2 | Build the change, tests alongside | 45 to 60 min | the only step that should take real time |
| 3 | `tsc` (always); `svelte-check` only if a `.svelte` file changed | 10 s / 13 s | |
| 4 | `vitest related <changed src files> --run`, then the ticket's test dir from the map below | 5 to 30 s | `related` and `--changed` both work at this HEAD |
| 5 | `check:hosted-imports` + `build:hosted` if `src/lib`, `deploy/` or `scripts/` changed | 8 s | the bundle proof; `wrangler deploy --dry-run` is already inside the bundle contract |
| 6 | `wrangler preview` (or a `wrangler deploy` to the ticket's preview) and a 2-minute self-check on the URL | 3 min | the only check that measures the user's experience |
| 7 | Push, open the PR into the sprint branch, CI-lite | 3 to 5 min | |
| 8 | One review, one reviewer, one pass, at most 5 findings | 20 to 30 min | run it on the diff while CI-lite runs |
| 9 | Fix High and Medium in the same session, rerun steps 3 to 5, push | 10 to 15 min | no fresh re-check session |
| 10 | Merge (merge commit), staging deploy on merge | 2 min | `build:hosted` 6 s + `wrangler deploy` under a minute + migrations |
Total: about 1 h 30 m for a half-day ticket, 15 min of it machine time.

**Path → test map** (run `vitest related` first, then these directories): `src/lib/views/**`, `src/routes/v/**` → `src/lib/views`, `tests/system`, `tests/analysis|litigation|quantum|calculations` (fixture-driven, 2 to 10 s); `src/lib/viewer/**`, `src/lib/results/hosted/assets.ts`, `src/lib/storage/cloud/**` → `tests/hosted-smoke`, `tests/hosted-foundation/storage`, `tests/hosted-foundation/runtime`; `src/lib/auth|tenancy|audit/**` → `tests/hosted-foundation/identity`, `tests/hosted-foundation/audit`, `tests/hosted-foundation/upload-grant`, `tests/hosting-probe/identity` (own install, run only here); `deploy/client/routes/**` → `tests/hosted-smoke`, `tests/native-alpha-journey`; `src/lib/publication/**`, `scripts/publish/**` → `tests/publication`, `tests/evidence`, `tests/hosted-foundation/publication-material`; `src/lib/case-package/**` → `tests/case-package`; `src/lib/components/**`, styles → `svelte-check` plus `src/lib/components/*.test.ts`; `src/lib/bundles|registers` → `tests/bundles`, `tests/registers`. Never run `tests/gate`, `tests/ci`, `tests/results-review/native` or `tests/hosted-foundation/recovery-*` per ticket (620 s of the 1,640; none of the sprint's paths touch them). The full suite runs on the merge to the sprint branch and nightly, not per PR.

**Merge cadence.** Merge each PR as soon as CI-lite is green and the one review is done; do not batch. Before opening the PR, merge the sprint branch into the ticket branch (no rebase) so the PR shows only the ticket's diff. Staging takes every merge automatically (a workflow step on `push` to the sprint branch, or the merger runs the deploy from a clean worktree); A and B stay frozen. Record `sha url time` in the 30-line status. Expect 6 to 10 merges a day across three developers.

**Suspend for the sprint branch.** The hard-coded counts in `tests/parity/m2-base.test.ts` and `tests/ci/pc1-vm-test-inventory.json` (make them `it.skip` under `CLEARCASE_SPRINT=1`, or exclude those files in CI-lite); the `receipt`/`verify` wrappers (run the bare command; the PR and CI log are the record); `browser-lock` for anything that is not a Chromium run, which is already true of `vitest` but not of the habit; `dev-gate` per commit; `gate` and `gate:hosted` before deploy (nightly on the fleet instead); the CI test guard and Chrome install on sprint PRs; merge records, Linear bookkeeping per round.

**Conflicts to pre-empt.** (1) `src/lib/components/view-registry.ts` and `docs/plan/view-coverage.json`: S5, S6, S7a and S7b all add views; give S5 the registry change for every planned route up front, with placeholders, so later tickets fill files that already exist. (2) `deploy/client/hosted-files.json` and `deploy/client/wrangler.toml`: S0 owns them; nobody else edits. (3) `src/lib/views/payloads.ts`: S1 lands first, today, before S5 branches. (4) `follow-ups.md`, `status.md`, `human-log.md`: one line per ticket appended in the PR causes trivial conflicts; write `follow-ups/<ticket>.md` instead and let the orchestrator fold them. (5) `GLOSSARY.md`, `docs/development.md` map notes: put them in the report, not the PR. (6) Migrations: S3 (KV revocation, sessions) and S4 (manifest in D1) both add a D1 migration; assign numbers 0006 and 0007 now.

**Where a boat.dev VM fleet helps.** Three jobs are worth moving off the developers' machines: (a) the full vitest suite plus `gate:hosted` on every merge to the sprint branch (about 4 min on a 4-vCPU VM, zero local contention); (b) the nightly `gate` with `test:e2e`, parity and `verify:pilot:v5` (25 to 45 min, needs the v5 locator and case folder on the VM, so it needs the owner's `.local` data and must stay on a private VM); (c) Astra and Playwright journeys against staging from a snapshot with Chromium preinstalled, run in parallel per ticket, replacing the two-slot `browser-lock` entirely. A snapshot with `bun install` and Chrome done starts in seconds; the cold install here was 1.2 s, so the snapshot's value is Chrome, the locator and the identity probe install, not the dependencies. A second GitHub runner on the fleet with the `clearcase-pc1` labels fixes the CI queue without touching `ci.yml`.

Not run: `gate`, `gate:hosted`, `test:e2e`, parity, any deploy, any Cloudflare or Clerk call. The two identity test failures were not investigated beyond the missing nested install.
