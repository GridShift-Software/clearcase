# Build the hosted gate and the verify-clearcase-hosted skill before foundation fan-out

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before) is the execution authority.

Planning key `HA-hosted-gate`. Added by the 17 October restructure. Backlog until the overall plan is approved.

## Why this exists

Every hosted ticket says "run the existing required gate or its independently reviewed hosted replacement". The existing gate proves v5 parity of the local SQLite app and says nothing about Workers, D1, R2 or Clerk. Without this ticket, the six proofs and the seven foundation owners would be verified by self-report and three throwaway probes, which is the failure mode the 12 October retro recorded. The local plan solved this with CC-27 and CC-03 before fan-out; this ticket is the hosted equivalent and is the pilot unit for the hosted brief template.

## What to build

One command proves a hosted revision the way `bun run --bun gate` proves the local app:

1. Build with Bun for the accepted Workers adapter and stamp the build with the exact source revision.
2. Start the app locally under workerd with synthetic D1 and R2 bindings and no cloud credentials.
3. Run the foundation request/render/action smoke tests and the hosted import-boundary negative test that <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> reserves.
4. Drive one user path through real Chromium: sign in as a test identity, open a provisioned synthetic case, open an original, and deny a wrong-client request.
5. Write a summary that names the exact SHA, the fixture identity, which boundaries were real and which were test doubles, and `evidence: true` only when nothing was reduced, stale or skipped.

A project-local verification skill, `verify-clearcase-hosted`, wraps the same lifecycle with a feature map, so a worker can prove one hosted user path in seconds the way `verify-clearcase` does for the local app. PC1 CI runs the credential-free part on every PR to `dev` and `feature/**`. Checks that need real Clerk, D1 or R2 stay in the proof tickets and the release gate, and the summary says so.

## Acceptance criteria

- [ ] The gate fails closed on a build stamp that is not HEAD, a dirty tree, a missing binding, a reduced-run variable, or a summary without `evidence: true` for HEAD. A throwaway test for each of these fails the gate and is reported.
- [ ] A hosted entry point that imports a local-only module (filesystem, SQLite, process listener) fails the gate.
- [ ] The driven user path reaches the app only over loopback. The identity boundary is a documented test-mode provider; the summary records it as a test double, and no gate run claims Clerk evidence.
- [ ] The credential-free gate runs on the PC1 CI runner inside its 30 minute job limit and leaves a receipt through the existing receipt tooling.
- [ ] CI review note, 17 October: the guest needs nothing new as root. `workerd` arrives as a platform package through `bun install` (cached in the persistent runner), Ubuntu 24.04's glibc is new enough, D1 and R2 run locally under Miniflare with their persist directory under the step's `/dev/shm` directory, `CI=1` and Wrangler telemetry off, no bindings to a Cloudflare account and no token in the job. Add it as a third `receipt` step and list it in the CI summary.
- [ ] The verification skill is proven once end to end per the create-verification-skill rules: launch, doctor, drive one mapped feature, keep evidence, clean up, and the evidence survives cleanup.
- [ ] Hosted probe classes are proposed for the workspace review checklist: wrong client, wrong case, stale results version, draft asset access, and a failed preview that must hold publication. The report lists them; the coordinator adds them to REVIEW.md.

## Reserved write scope

* scripts/gate-hosted.mjs, or a hosted mode of scripts/gate.mjs if that is smaller
* tests/hosted-foundation/gate/\*\*
* .agents/skills/verify-clearcase-hosted/\*\*
* .github/workflows/ci.yml (hosted job only)
* docs/development.md (hosted checks section, serialized with <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue>)
* package.json scripts entry, by handoff from <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue>

These are initial reservations. Pin exact files and the accepted upstream SHA in the coordinator brief.

## Verification and handoff

Run the new gate at the exact revision and keep its summary and receipts. Run the local gate too, since this ticket touches shared config. One fresh independent diff review, one bounded written-finding fix and fresh recheck. Return PASS/HOLD/FAIL at the exact revision with commands, exit codes and evidence paths. Only the coordinator changes Linear.

## Boundaries

Synthetic data only. No cloud credentials in the repository, CI or the gate. RAWS and current production are read-only. No deployment or main merge under this issue.

## Blocked by

Native edges: <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> (the Workers build this gate runs), <issue id="c99e1ba3-dc84-4bbc-aee5-f8c3c34692f2" href="https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation">GRS-27</issue> (the design gate), <issue id="7e83827a-23fd-431a-96c5-3d2471790e1c" href="https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha">GRS-69</issue> (the plan). It blocks the foundation fan-out (<issue id="c4b67eb1-ae1c-4c4a-81e6-88f2392eddd9" href="https://linear.app/vaper/issue/GRS-113/implement-clerk-invitations-sessions-and-hosted-access-checks">GRS-113</issue>, <issue id="13f1315c-d8af-4ac6-ae9a-e700a682f570" href="https://linear.app/vaper/issue/GRS-115/implement-hosted-d1-results-storage-and-protected-r2-assets">GRS-115</issue>), the viewer core (<issue id="96a2872f-99a5-4f0d-b37f-454c41e9dc76" href="https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers">GRS-120</issue>), the first workflow (<issue id="00e869ac-8e6b-4b5c-b961-caec74950e96" href="https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view">GRS-137</issue>) and the foundation aggregate (<issue id="3ee13f2b-c1b4-44bb-9c43-cd750b3623e5" href="https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work">GRS-36</issue>).
