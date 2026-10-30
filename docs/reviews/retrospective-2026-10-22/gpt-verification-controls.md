# Independent review: verification controls

Review date: 22 October 2026. Reviewer: GPT, verification-controls assignment. This is an independent source review; I did not read the other retrospective reports.

The controls have useful fail-closed checks, but their automated coverage is uneven. The most consequential gap is that CI does not execute the behavior suite for the guard, receipts, approval ledger and dispatch controls. The CI guard's label input can also become stale without invalidating its check. The local verification skill bypasses the shared browser admission mechanism. These remain in the incoming branches inspected below.

## Revision and evidence boundary

- Baseline and checkout HEAD: `225b7e00578319d16383678a8d1ae6efb362a0ba` (`dev` baseline), on `audit/retrospective-2026-10-22`.
- Incoming PR114 / `origin/wave/proofs-final`: `a3f80d1305294a8c685a87351281eef7928c7d9c`.
- Incoming `origin/wave/guard-followups`, as locally available: `99cf56bba6afc0bf30d0dc914816ad97d1a750ae`.
- Incoming changes were read with Git diff/show, without checkout, fetch or merge. The combined result of the incoming waves was not executed or accepted.
- Read the repository instructions, glossary, relevant development and agent-tooling contracts, CI runner documentation, verification maps, runners, receipt/approval/guard implementation and associated control tests. No skills were invoked. No agents were spawned.
- Doctor attempt: `bash scripts/agent-tools/doctor`, exit 1, with `<3>WSL (43345 - Relay) ERROR: CreateProcessCommon:735: execvpe(/bin/bash) failed: No such file or directory`. The wrapper itself also requires Linux (`scripts/agent-tools/_common.sh:6`). **Doctor unsupported/unrun; no doctor receipt was produced.**
- Builds, gates, browser acceptance and behavior suites: **UNRUN** on this Windows host, as instructed. No PASS is claimed for any revision. The findings below are confirmed source-level control gaps, with proposed behavior checks clearly separated from observations. Only this report was written; no case material or credentials were accessed.

All baseline file/line references below name the full baseline SHA above. Links pin that SHA; incoming exceptions explicitly name their own SHA.

## Findings for implementation

### VC-1 — The behavior tests for the factory controls are outside CI and both gates

**Severity: medium (P1). Confidence: high. Status: confirmed coverage defect; not fixed by either incoming wave.**

The actual guard/approval/receipt/dispatch behavior suite is Python. Its normal entry is [`tests/agent-tools/run.sh:1397`](https://github.com/GridShift-Software/clearcase/blob/225b7e00578319d16383678a8d1ae6efb362a0ba/tests/agent-tools/run.sh#L1397), which runs `python3 -I .../test_controls.py`. That file contains `ApprovalLedger` (line 234), `DispatchBookkeeping` (697), the guard classes (1110 onward), `GuardBinding` (1941), and the real CI guard replay through `tests/ci-guard/run.sh` (2615 onward).

Neither `.github/workflows/ci.yml` nor `scripts/gate.mjs` nor `scripts/gate-hosted.mjs` invokes this suite. The root test script is `vitest run` (`package.json:15`); its include list is TypeScript only (`vitest.config.ts:29–47`). The collection completeness check inventories only `*.test.ts` ([`scripts/ci/summary.ts:81`](https://github.com/GridShift-Software/clearcase/blob/225b7e00578319d16383678a8d1ae6efb362a0ba/scripts/ci/summary.ts#L81)). Python source syntax checking is not behavior execution.

CI does run `tests/ci/guard-enforcement.test.ts`, but that test explicitly uses a **stub** base guard that returns PASS/FAIL/HOLD (`:9–10`, `:62–63`, `:88`). It proves workflow failure propagation, not whether the real parser or ledger enforces its contracts. CI running the real guard against a PR's manifests is also not equivalent to running its negative regression cases.

**Concrete consequence:** a change that accidentally stops rejecting a forged guard binding, weakens a protected-test comparison, or resets dispatch accounting can pass the normal CI collection inventory without running the existing regression that would reject it. This is an automation gap, not evidence that those defects currently exist.

**Incoming accounting:** `99cf56bb` adds `test_docs_only.py` to `run.sh`, but still does not wire that entry into CI/gates. PR114 adds deployment/identity TypeScript collection and an early TypeScript inventory check; it leaves this Python omission intact.

**Smallest fix:** add a required, receipted controls step in CI for the Python synthetic suites, and include it in the required summary names. Use the actual suite entry/classes; do not add another source-string assertion saying a command exists. Avoid blindly invoking the entire legacy `run.sh` in every gate: it has additional installed-skill and environment prerequisites. Run the network-dependent CI replay in an appropriate CI step; keep the other synthetic controls offline. A change-scoped local controls command can complement the full app gate without making every UI-only local check repeat the whole factory harness.

**Behavior check:** in a disposable synthetic checkout, introduce an intentional failure in a collected approval/guard regression and require the CI controls step and final summary to fail. Verify the receipt names the checked-out SHA. Restore the regression and require PASS. Repeat for the incoming docs-only suite so adding its file cannot silently omit it again.

### VC-2 — Applying the enforcement label does not invalidate an earlier green guard

**Severity: medium (P1). Confidence: high. Status: confirmed stale-policy-input defect; not fixed by either incoming wave.**

The workflow subscribes to `pull_request` with no activity types ([`.github/workflows/ci.yml:10–11`](https://github.com/GridShift-Software/clearcase/blob/225b7e00578319d16383678a8d1ae6efb362a0ba/.github/workflows/ci.yml#L10)). The guard requires a manifest only when the event payload has `fix-round` (`:99`, `:121–124`). Without a manifest, label requirement or ledger, `fix-round-guard` deliberately returns a PASS receipt for “nothing to protect” ([`agent_tools.py:2186–2203`](https://github.com/GridShift-Software/clearcase/blob/225b7e00578319d16383678a8d1ae6efb362a0ba/scripts/agent-tools/agent_tools.py#L2186)). CI supplies no ledger.

GitHub's current documentation confirms the default activities are opened, synchronize and reopened; label changes need explicit activity types. Source checked during this review: [GitHub workflow event reference, pull_request](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

**Concrete sequence:** open an unlabeled PR with no manifest; let CI pass. Add `fix-round` after the run, without pushing a commit. The requirement is now true in the PR UI, but no new CI run judges it. Rerunning the original event also must not be assumed to supply a fresh label snapshot. This scenario needs no workflow edit, runner compromise or forged receipt.

**Smallest fix:** trigger enforcement on relevant label changes and ensure the resulting required guard check judges the current requirement. To avoid rerunning the entire build/test job for routine labeling, a small required guard job can handle these policy changes. Keep the trusted-base implementation and pre-install ordering. A merge-side check that compares the current requirement with the recorded guard result would close stale-run reuse too; that coordinator code was outside this review, so I do not claim whether it already does so.

**Behavior check:** model opened/unlabeled and labeled events at the same head. The former may report nothing to protect; adding `fix-round` must cause a fresh required failure when no manifest exists. Adding an appropriate manifest must then pass using the trusted base's guard. Test trigger/event behavior, not only the presence of `--require-manifest` in a shell string.

**Immediate instruction update:** apply and verify `fix-round` before dispatching its CI run; a pre-label green run is not evidence of manifest enforcement.

### VC-3 — The local verification skill starts Chromium without browser admission

**Severity: medium (P1), operational reliability/cost. Confidence: high. Status: confirmed admission gap; not fixed by either incoming wave.**

The local skill's preflight returns after checking tools and ports ([`.agents/skills/verify-clearcase/lib/main.mjs:65–72`](https://github.com/GridShift-Software/clearcase/blob/225b7e00578319d16383678a8d1ae6efb362a0ba/.agents/skills/verify-clearcase/lib/main.mjs#L65)). Its run spawns the namespace directly (`:150–159`), and `inner.mjs:107–114` launches Chromium directly. No local skill source resolves or acquires the shared browser lock. `verify app` directly invokes this runner (`agent_tools.py:1433–1438`); doctor reporting that a lock is available does not acquire it.

The hosted runner supplies the existing implementation pattern: `main.mjs` resolves the lock in preflight and passes it to the lifecycle; [`verify-clearcase-hosted/lib/inner.mjs:217–222`](https://github.com/GridShift-Software/clearcase/blob/225b7e00578319d16383678a8d1ae6efb362a0ba/.agents/skills/verify-clearcase-hosted/lib/inner.mjs#L217) actually wraps the browser drive in that command.

**Concrete consequence:** a local `verify app` can start another Chromium while the shared slots are occupied. Even an invalid `CLEARCASE_BROWSER_LOCK` or retired `BROWSER_LOCK` does not refuse this entry point. Parallel reviewers and gates can exceed the host browser budget and suffer avoidable queue/capacity interference. I did not measure latency or demonstrate a host overload.

**Incoming accounting:** `99cf56bb` changes the local runner's Git calls to use `gitEnv`; it does not add admission or acquisition. PR114 does not change this path.

**Smallest fix:** reuse `resolveBrowserLock`, record its admission in evidence, and wrap the browser-bearing portion of the local run with the admitted lock. Preserve the existing deliberate CI `none` contract; do not turn doctor into a second scheduler. Do not hold a browser slot through unrelated build work if the existing lifecycle can acquire it around the browser phase.

**Behavior check:** an invalid/retired lock setting refuses before Chromium starts; an executable recording lock sees the browser-bearing child; another job holding the required slot prevents that child from starting until release. Run this with synthetic inputs on supported Linux. An arbitrary recording wrapper alone proves invocation, not mutual exclusion.

### VC-4 — The feature contract accepts a nonexistent drive-step reference

**Severity: low (P2). Confidence: high. Status: confirmed validation gap; not fixed by either incoming wave.**

[`verify-clearcase/lib/features.mjs:12`](https://github.com/GridShift-Software/clearcase/blob/225b7e00578319d16383678a8d1ae6efb362a0ba/.agents/skills/verify-clearcase/lib/features.mjs#L12) treats the text `Step \`` as a drive marker. `parseFeature` checks only that marker (`:46–51`). `featureIndex` validates step modules and maps their feature IDs, but never compares a bullet's referenced step ID with the discovered steps (`:100–110`). The README's opening paragraph says the runner drives every bullet marked with a step ID.

**Concrete source-level counterexample:** a structurally valid feature file with `- **Save.** Step \`misspelled-save\`` satisfies the marker check even when no step has that ID. Its feature index can be PASS and the regular run can succeed without executing the claimed action. This was not executed here, and I found no currently mistyped step ID in the feature-reference inventory inspected. The gap is the contract checker itself. The file's blob is identical in baseline, `99cf56bb` and PR114 (`2e8e07c2e770ba0e4b7abaebc1d27dcdd43e24b6`).

**Smallest fix:** extract explicit step references in each Driving section and require each to exist in the discovered step inventory. Permit intentional cross-feature references, such as `every-view`; existing docs use them. Keep “not yet driven” as an honest coverage state rather than requiring every mapped behavior to pass immediately.

**Behavior check:** a nonexistent ID fails the index; an existing cross-feature ID passes; deleting the module that supplied a referenced ID fails; a properly marked not-yet-driven behavior remains visibly uncovered. These are small pure contract checks and need no application build.

## Boundaries and incoming work that should not become duplicate defects

- **Incoming fix:** PR114 wires deployment/identity TypeScript tests and hosting-probe evidence checks, adds storage/notifications probe cases to the hosted gate and installs the identity workspace. Do not reopen those omissions against the baseline as new work. Incoming checks of historical evidence validate recorded inputs/ancestry; they do not establish that a live cloud provider was exercised at the audit SHA.
- **Incoming fix:** `99cf56bb` adds docs-only declarations bound to review findings, makes a recorded fix require a guard receipt even for an empty protected-test list, handles the fix line inside a wave, and strengthens Git environment isolation/read-document checks. Baseline `guard_binding`'s empty-list early return (`agent_tools.py:1849–1850`) is consequently not a new recommendation.
- **Known local trust limit:** the ledger does not authenticate reviewer identity, and a same-user writer can replace the entire unsigned store. `docs/agent-tooling.md`, “Ledger store and push hook,” explicitly documents this. No new claim of a privilege boundary is warranted. Coordinator ownership and external wave review remain necessary. Do not expand this audit into a signing project solely to restate that limitation.
- **Known deployment boundary:** the repository does not install its coordinator's pre-push hook. This audit did not read or modify external `orch-bin` files, verify hook installation, or inspect live branch-protection settings. Hook effectiveness on this host is **unverified**, not a confirmed deployed bypass.
- **Tracked/manual review boundary:** the guard intentionally does not freeze all dependencies: `test_guard.mjs:847–855` keeps test scripts and selected resolution fields while allowing dependency/version edits. Neither named callback retention nor a byte-identical lockfile comparison authenticates installed runner bytes. A protected test can therefore change meaning when its test framework or resolver dependency changes. This is a source-confirmed limitation; a working dependency-substitution bypass was **not reproduced**. Existing reviewer-owned package/alias and dynamic-code routes are already recorded around `docs/agent-tooling.md:277–285` under GRS-150. Narrow the reviewer instruction to explicitly inspect test-framework pins, overrides and relevant lockfile resolution changes before accepting a guard PASS; do not file every documented route again.
- **Behavior evidence:** the 42-view sweep checks navigation, a heading and readiness/current-view markers (`verify-clearcase/lib/drive.mjs`, `every-view`). Feature files explicitly mark many operations not yet driven by this skill and name separate browser suites. Preserve that distinction: a navigation PASS is useful, but cannot stand in for a save/delete/export/reload proof. CI tests the merge commit and records the PR head separately (`docs/ci-runner.md:15`); preserve both identities instead of relabeling merge-commit receipts as head acceptance.

## Narrow instruction changes

1. Require a receipted factory-controls behavior run for changes to `scripts/agent-tools`, its control fixtures or the trusted-base CI guard path. Record exact SHA and selected suites; a TypeScript collection PASS does not cover Python/shell suites.
2. Require the fix-round enforcement input to be current for the run being accepted. Set the label before CI and invalidate/rejudge a verdict when the requirement changes.
3. Require every browser-bearing verification entry point to acquire shared admission itself. Doctor is prerequisite reporting, not a slot reservation.
4. Report local skill coverage by action: driven, not yet driven, or separately proved with an exact suite/SHA. A feature index or 42-view navigation result is not aggregate behavioral acceptance.

These changes fit the current process. No new agent roles, repeated whole-gate runs, private fixture copies, external approval service or broad guard rewrite is needed to address VC-1 through VC-4.
