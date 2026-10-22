# CI and repository health retrospective

Reviewed 22 October 2026, approximately 08:42–08:49 UTC. This is the replacement for the failed CI/repository reviewer only. No implementation, tests, configuration, skills, branch, deployment or service settings were changed.

## Scope and evidence boundary

- Current checkout: `audit/retrospective-2026-10-22`, HEAD `225b7e00578319d16383678a8d1ae6efb362a0ba` (the pinned `dev`).
- Incoming proofs: `origin/wave/proofs-final` at `a3f80d1305294a8c685a87351281eef7928c7d9c`, PR114 into that dev SHA. Inspected through Git objects and connector/API reads without checkout.
- Incoming controls: `origin/wave/guard-followups` at `99cf56bba6afc0bf30d0dc914816ad97d1a750ae`. Its merge-base with pinned dev is `e44e12b397561e7d7ad229e8fad00753db9f00bc`; it is not a descendant of pinned dev. Files absent from that older line are not proposed deletions from dev. Its own guard changes need integration followed by checks on the combined head.
- Read `AGENTS.md`, `GLOSSARY.md`, relevant development and runner contracts, local demo recovery instructions, recovery/release planning and the relevant live Linear issues. No skills invoked; no agents spawned.
- GitHub connector reads supplied PR114, its jobs and job logs. `gh api` filled connector gaps for settings, rules, check runs and recent run history. Linear issue reads worked; `get_agent_context` returned `Tool get_agent_context not found`.
- No local gate, build, install, acceptance harness, runner SSH, secret, production system or real case material was used. The parent reported that doctor fails on this Windows/Git Bash environment with unsupported OS `msys`; this reviewer did not turn that limitation into a PASS or create a receipt. Findings below are static analysis or attributed remote observations, not local acceptance results.

## Findings and priorities

### CI-01 — High / P1: merge and release policy has no server-side enforcement

**Classification:** Existing, explicitly documented governance gap; not a newly introduced code defect. No bypass or unauthorized merge was observed. High confidence in settings; impact is a policy-enforcement inference.

**Evidence:** At pinned dev, `AGENTS.md:41–44` requires wave-only integration, successful CI and Greptile at the exact head, no unresolved findings, and a user-only release merge into `main`. `docs/ci-runner.md:84` already acknowledges absent dev protection and rulesets. Read-only API responses on 22 October were:

```text
GET /repos/GridShift-Software/clearcase/rulesets                    200 []
GET /repos/GridShift-Software/clearcase/rules/branches/dev          200 []
GET /repos/GridShift-Software/clearcase/rules/branches/main         200 []
GET /repos/GridShift-Software/clearcase/branches/dev/protection     404 Branch not protected
GET /repos/GridShift-Software/clearcase/branches/main/protection    404 Branch not protected
GET /repos/GridShift-Software/clearcase/branches/main               protected: false
```

The active-rules endpoint includes applicable organization rules, so the empty result is stronger evidence than checking repository rulesets alone. [GitHub rules API](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch).

**Trigger and impact:** A writer can use a direct push or ordinary merge outside the coordinator's merge checker. GitHub has no configured rule requiring these checks, the release approval or resolved conversations. A rejected local merge checker is therefore an operational control, not a repository boundary. PR114 illustrates why checking only green checks is insufficient: both its check runs are successful while its latest review contains a finding (see PR snapshot below).

**Smallest fix:** Have the coordinator prepare rules for `dev` and `main` matching the actual policy: PR requirement, required CI/reviewer checks, conversation resolution, blocked force pushes/deletions and deliberate bypass policy. Restrict release updates/merges to the designated user and enforce the designated release review. Keep the wave/base and substantive-finding checks in the merge checker where GitHub status configuration cannot express them. Apply restrictions to administrators as intended; ordinary protection exempts them by default. [GitHub branch-protection behavior](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

**Validation:** Read back effective rules for both branches and verify the intended actor/check requirements. In a separately authorized disposable test branch, demonstrate refusal of a missing-check PR and direct push; demonstrate the approved route. No settings or negative writes were attempted here.

**Ticket disposition:** Related GRS-158 is Done, but its live brief addresses public runner admission, collaborator-only contributions and action policy, rather than claiming branch protection. Treat this as a known gap needing an explicit owner; do not reopen GRS-158 solely because protection was outside its scope.

### CI-02 — Medium / P2: live action policy is broader than the accepted four-commit allowlist

**Classification:** Newly observed settings/documentation mismatch against completed GRS-158; present live during this review and not repaired by either incoming code branch. High confidence; no malicious action execution observed.

**Evidence:** `docs/ci-runner.md:70–82` records `github_owned_allowed: false`, four exact allowed commits, and refusal of other commits. `tests/ci/workflow-admission.test.ts:132–169` derives its expected allowlist from that document and checks workflow source, not live settings. Actual readback:

```text
GET .../actions/permissions
  enabled: true
  allowed_actions: selected
  sha_pinning_required: true
GET .../actions/permissions/selected-actions
  github_owned_allowed: true
  verified_allowed: false
  patterns_allowed:
    actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
    oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
    actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1
    actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9
```

**Trigger and impact:** An internal workflow edit can select another SHA-pinned GitHub-owned action, including another revision of an existing `actions/*` dependency, without passing through the intended settings allowlist update. SHA pinning still prevents a mutable-tag reference; it does not restore the four-commit restriction. The runner hook still rejects fork heads, and trusted writers can already run shell code, so this is a weakened supply-chain/review control, not an independent fork-admission bypass. GitHub defines the broad GitHub-owned allowance separately from individual patterns. [Official permissions API](https://docs.github.com/en/rest/actions/permissions#set-allowed-actions-and-reusable-workflows-for-a-repository).

**Smallest fix:** Coordinator reconciles live policy with the approved GRS-158 intent, normally by disabling the broad GitHub-owned allowance while retaining the four exact patterns and required SHA pins. If the broader policy is intentional, record that decision and correct the false refusal claim. Add a read-only settings readback to periodic repository health review; source-only tests cannot detect this drift.

**Validation:** Read back both endpoints and compare every policy field against the accepted policy. A separately authorized disposable workflow can test refusal of a pinned GitHub-owned action outside the list. No mutation or workflow dispatch performed here.

### CI-03 — Medium / P2: PR114 adds prerequisites to Actions but leaves the GitHub-independent verifier unable to prepare them

**Classification:** New incoming regression in PR114, not a defect in pinned dev's current test collection. High confidence from deterministic path/preparation mismatch; Linux runtime reproduction remains required. Not covered by the observed GRS-156/161/169 controls fixes.

**Evidence at `a3f80d1`:** `.github/workflows/ci.yml:130–182` prepares real Node before tests and separately installs `tests/hosting-probe/identity` with its own frozen lock. `vitest.config.ts:43–44` collects deployment and identity probe tests. `tests/hosting-probe/identity/gates.test.ts:17–20` starts `craftedWorld()`; `harness.ts:80` runs Wrangler from the explicit identity-local path `node_modules/wrangler/bin/wrangler.js`. Its package has distinct Wrangler/workerd pins from root. Root `package.json` has no workspace membership that installs this independent package.

Meanwhile `scripts/ci/pc1-vm:280–302`, unchanged in PR114, launches a fresh bundled clone with `PATH=/usr/local/bin:/usr/bin:/bin`, installs root dependencies only, then runs the entire root test collection. Actions' setup-node tool-cache PATH is absent, and the fresh clone has no identity-local dependencies. The incoming guard branch still has the same preparation sequence, apart from unrelated Git environment hardening.

**Trigger and impact:** Run `scripts/ci/pc1-vm verify a3f80d1305294a8c685a87351281eef7928c7d9c` in an authorized runner maintenance window. Even if a suitable Node happens to exist on its restricted PATH, the identity-local Wrangler path is absent. The verifier cannot produce the intended passing check/test verdict for a revision whose Actions job passes. If Node is absent, deployment tests also fail collection. Reusing root dependency cache does not create the missing nested install. This is a false failure/loss of the GRS-139 fallback, not a false PASS or evidence of a product runtime failure.

**Smallest fix:** Share credential-free test preparation between Actions and `pc1-vm verify`: provision/resolve the supported real Node and install every independent package the selected root test suite requires, under frozen locks, before running tests. Preserve verifier admission/drain/service restoration and its explicitly narrower check/test verdict; extending it to hosted acceptance is a separate scope choice.

**Validation:** On Linux, run a fresh bundle with no nested `node_modules` and the verifier's exact PATH. Prove identity and deployment tests execute, including the explicit nested Wrangler path and real Node. Then exercise the actual verifier in an authorized quiet window and confirm service restoration and the exact-SHA receipts. Existing verifier tests use a synthetic source tree and fake toolchain (`tests/ci/pc1-vm-verify.test.ts:35–49`); retain those lifecycle controls and add a prerequisite-parity check or real synthetic integration path. No verifier execution was attempted here.

## PR114 and incoming guard disposition

[PR114](https://github.com/GridShift-Software/clearcase/pull/114) was open, mergeable and based on pinned dev when read. Registered with this thread; no monitoring or rerun started.

- Head: `a3f80d1305294a8c685a87351281eef7928c7d9c`.
- GitHub test merge: `f2f74de2ad5eeab79950a301fa648d0b984a3c9f`.
- [CI run 39741918885](https://github.com/GridShift-Software/clearcase/actions/runs/39741918885) completed successfully at 07:42:17 UTC. Its log reports `CI PASS` at the **test merge**, with check 15.3 s, test 118.4 s, hosted gate 51.0 s; 3,367 tests in 190 files, zero failed/skipped. This is attributed remote evidence, not a local gate PASS at the PR head.
- The base guard separately judged the PR head and reported no added/changed fix-round manifest and `nothing to protect`; that does not mean all 156 changed files were protected by the guard.
- `check` and `Greptile Review` check runs both had conclusion `success` at the exact PR head. Nevertheless the latest [Greptile finding](https://github.com/GridShift-Software/clearcase/pull/114#discussion_r4345780038), at `tests/hosting-probe/notifications/src/worker.ts:85–87`, says retries can skip their due time. The PR body asks for that fix before merge. No later response was present in the connector snapshot. This reviewer does not duplicate the Cloudflare reviewer's substantive code adjudication; successful reviewer check status alone cannot resolve the objection.
- Earlier storage snapshot, interrupted erasure and deployment false-PASS objections have author replies identifying fixes in `1e3f77c2`, included in the reviewed incoming head. Do not report these as unfixed dev defects or claim this reviewer reran their proofs.

The controls branch contains GRS-156 docs-only manifests, GRS-169 renamed/base-changed protected-path checks, and GRS-161 inherited `GIT_*` isolation, including its polish. For this scope, `scripts/ci/source-check.ts`, `scripts/ci/summary.ts` and `pc1-vm` now clear inherited Git redirection. These are incoming fixes, not additional new retrospective findings. They have not been accepted on the combined dev head by this review.

[GRS-179](https://linear.app/vaper/issue/GRS-179) remains Backlog: a manifest received through a dev merge can be judged against the receiving wave's unrelated changes. Its issue explains the `wave/proofs-final` route. Treat that as tracked guard work; GRS-169's different renamed-path fix does not establish GRS-179 acceptance. [GRS-150](https://linear.app/vaper/issue/GRS-150) also tracks residual reviewer-owned guard routes. The guard is a useful enforcement layer with stated coverage, not a complete semantic security proof.

## Recent run health

Bounded sample: latest 60 workflow runs returned at about 08:43 UTC, from 21 October 00:13 to 22 October 08:42 UTC. Counts were 53 success, three failure, three cancelled and one in progress. This is 53/59 completed runs successful, not a measured flake rate. Latest attempts were sampled; two listed runs had attempt 2, so this understates earlier-attempt failures.

- Pinned dev's [push run 39741411084](https://github.com/GridShift-Software/clearcase/actions/runs/39741411084) succeeded at `225b7e00578319d16383678a8d1ae6efb362a0ba`.
- [39628611903](https://github.com/GridShift-Software/clearcase/actions/runs/39628611903), test merge `c4c42a928862cb064cb905fbaabdd4a7e784d0b0`: check, test and hosted gate succeeded, but summary correctly failed because five tracked deployment test files were omitted. This validates the value of collection coverage beyond test exit codes.
- [39629397199](https://github.com/GridShift-Software/clearcase/actions/runs/39629397199), test merge `013b9d446e77311a5575a5d15b52ce3d089d6c07`: six deployment secrets-test assertions failed. The later PR114 workflow moves real Node before tests. The sampled logs establish assertion failures; they do not by themselves prove every failure's root cause.
- [39660933170](https://github.com/GridShift-Software/clearcase/actions/runs/39660933170), attempt 2, test merge `8efcbcaac57f488be8340727d81ebc22a5ef04e3`: identity `serve.mjs` was not ready within 90 s; 41 skipped tests caused FAIL and the hosted gate did not run. Do not call that run a security acceptance PASS or infer a recurring infrastructure defect from it.
- All three cancellations were PR runs with newer same-branch runs shortly afterward, consistent with `.github/workflows/ci.yml:20–23`. No sampled evidence requires disabling superseded-PR cancellation. Push concurrency intentionally does not cancel an active dev run, but pending runs can be replaced; the workflow documents that limitation.

## Supply chain, reproducibility and runner recovery

**Strengths supported by source/readback:** Exact direct pins, committed `bun.lock`, root frozen installs, SHA-pinned actions and repository-required action SHA pins. The SheetJS URL dependency also has SHA-512 integrity in `bun.lock:446`; its URL alone is not evidence of unverified bytes. The trusted guard uses base code/dependencies, an empty Bun config, no dotenv/auto-install and an install without lifecycle scripts before candidate code executes (`ci.yml:81–124`). Missing base tools/install refuse judgment rather than falling back to candidate code.

The API confirms a read-default workflow token, no ability for Actions to approve PR reviews, collaborator-only PR creation, approval for all external contributors, enabled secret scanning/push protection, and one online `clearcase-pc1-vm` runner. Workflow credentials are not persisted by checkout. No cloud secret or production deployment step appears in this workflow. Secret scanning being enabled is a control observation, not a claim that history is clean.

**Accepted trust limits, not new exploit findings:** `docs/ci-runner.md:126,156–161,278` explicitly says jobs persist state, can alter the runner, and can forge its receipt store. The VM is disposable; jobs are not. Network/host isolation reduces blast radius but does not make a trusted-base guard independent of an earlier hostile admitted job. This matches [GitHub's warning about persistent self-hosted runner compromise](https://docs.github.com/en/actions/reference/security/secure-use). Preserve the user's GRS-158 decision to use pc1; do not silently replace it with hosted runners. After a credible admitted-job compromise, use the documented rebuild/credential replacement route rather than treating provisioning or a green receipt as sanitization. No live host boundary or hook installation was independently verified here.

Chrome ZIPs are pinned and rehashed (`scripts/ci/install-chrome.sh:10–25`), but unpacked trees are reused on a stamp check alone at line 18. Changes or missing files under the extracted tree can survive a warm install. This is a known consequence of the persistent-cache trust model, with an additional cold/warm reproducibility concern; no tampering was observed. A small improvement is validating required executables and rebuilding from the checked ZIP when absent, with periodic cold-cache verification. Full per-job trust requires stronger isolation than checking a writable stamp.

Runner rebuilds are operationally repeatable, not bit-for-bit reproducible: `vm-host.sh:11–12,108–110` fetches Ubuntu's moving `noble/current` image and matching published checksum; `guest-provision.sh:241–242` updates/upgrades packages. Bun and browser archives are checksum-pinned, but OS/kernel/tool state still moves. This is documented, not a hidden exact-image guarantee. Record image digest and installed versions for recovery evidence.

**Dependency upkeep improvement:** Security alerts are enabled (read endpoint returned 204); automated security updates are disabled. No Dependabot/Renovate configuration or dependency-audit CI step was found in the tracked workflow/configuration inspected. Do not equate frozen dependency bytes with current vulnerability review. Assign a review cadence covering root, independent runtime/viewer/identity packages, direct-URL SheetJS and pinned actions; choose controlled update PRs compatible with wave ownership. GitHub supports text Bun locks for Dependabot updates, but dependency-graph coverage must be verified separately, and SHA-pinned Actions do not receive the same alert coverage as semantic-version references. [Supported ecosystems](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories), [dependency-graph coverage](https://docs.github.com/en/code-security/reference/supply-chain-security/dependency-graph-supported-package-ecosystems). No CVE inventory or claim of vulnerable installed versions was produced.

**Release/recovery state:** Local rollback guidance exists in `docs/demo-runbook.md:7–19`; case user-work backup semantics are in ADR 0004 and development contracts. The demo recipe warns about incompatible results versions and reimport, but is not a hosted release/recovery procedure. Hosted complete export/recovery/deletion runbooks and release acceptance are explicitly assigned to GRS-118 and GRS-32 (`docs/plan/tickets/HA-recovery.md:25,33–42`); the incoming GRS-110 proof remains distinct from those production deliverables. Missing production acceptance is planned work, not a surprise release regression. The runner's documented recovery/store-loss-on-destroy procedures are useful; CI-03 must be repaired to preserve its independent check/test fallback after PR114 lands. GRS-140 already tracks a second guest; GRS-165 tracks splitting the slow verifier test file. Neither should become a duplicate retrospective ticket.

## Recommended order

1. Assign and enforce `dev`/`main` protections, retaining the coordinator's unresolved-finding check and user-only release boundary.
2. Reconcile the live GitHub-owned action allowance with GRS-158's accepted exact-commit policy.
3. Repair PR114's verifier prerequisites and validate the actual fresh-bundle Linux path before relying on GRS-139 for recovery.
4. Integrate the guard followups on current dev and run affected checks at that combined SHA; retain GRS-179/150 as explicit remaining coverage. Resolve PR114's current review objection before merge.
5. Add lightweight settings-drift/dependency review and periodic cold recovery checks; continue GRS-118/32, GRS-140 and GRS-165 under their existing owners.

No local acceptance PASS is asserted. The only new file authored by this reviewer is `docs/reviews/retrospective-2026-10-22/ci-and-repository-health.md`.
