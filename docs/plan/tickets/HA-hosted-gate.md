# Build the hosted gate and the verify-clearcase-hosted skill before foundation fan-out

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before) is the execution authority.

## User decision — 19 October 2026

The user approved local Workers build/scaffolding and hosted-gate bootstrap (<issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> → <issue id="ab5e730e-f8a2-48d3-9b1c-ff54c6fd8498" href="https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before">GRS-138</issue>) before <issue id="c99e1ba3-dc84-4bbc-aee5-f8c3c34692f2" href="https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation">GRS-27</issue>, once their local runtime and viewer inputs pass. Cloudflare remains pinned. This authorization covers credential-free local work with synthetic fixtures and explicitly named doubles. Real-provider acceptance and all remaining foundation work still wait for <issue id="c99e1ba3-dc84-4bbc-aee5-f8c3c34692f2" href="https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation">GRS-27</issue>. Every original acceptance obligation remains; do not mark incomplete or real-provider work Done from a local slice.

Local runtime prerequisite: an independently reviewed exact-SHA PASS for <issue id="3e18e69c-1912-45e4-aa6a-5e4d6ceac22c" href="https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime">GRS-106</issue>'s local workerd/software leg, not completion of its still-held provider legs. Viewer prerequisite: accepted <issue id="ea230ba7-d71a-41fa-8916-530a865a1392" href="https://linear.app/vaper/issue/GRS-97/evaluate-viewer-components-and-freeze-alpha-file-coverage">GRS-97</issue> coverage and dependency handoff. <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> hands <issue id="ab5e730e-f8a2-48d3-9b1c-ff54c6fd8498" href="https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before">GRS-138</issue> the independently accepted local build, stubs, fixture, boot command and feature map. Preserve the known draft defect list and rerun at the new integrated SHA.

---

Planning key `HA-hosted-gate`. Added by the 17 October restructure. Backlog until the overall plan is approved.

## Why this exists

Every hosted ticket says "run the existing required gate or its independently reviewed hosted replacement". The existing gate proves v5 parity of the local SQLite app and says nothing about Workers, D1, R2 or Clerk. Without this ticket, the six proofs and the seven foundation owners would be verified by self-report and three throwaway probes, which is the failure mode the 12 October retro recorded. The local plan solved this with CC-27 and CC-03 before fan-out; this ticket is the hosted equivalent and is the pilot unit for the hosted brief template.

## What to build

One command proves a hosted revision the way `bun run --bun gate` proves the local app:

1. Build with Bun for the accepted Workers adapter and stamp the build with the exact source revision.
2. Start the app locally under workerd with synthetic D1 and R2 bindings and no cloud credentials.
3. Run the foundation request/render/action smoke tests and the hosted import-boundary negative test that <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> reserves.
4. Drive one user path through real Chromium: sign in as a test identity, open a provisioned synthetic case, open an original, and deny a wrong-client request. Bootstrap rule: the first version of this path runs against the identity, storage and user-work stubs and the synthetic case fixture that <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> lands, so this ticket does not wait for <issue id="c4b67eb1-ae1c-4c4a-81e6-88f2392eddd9" href="https://linear.app/vaper/issue/GRS-113/implement-clerk-invitations-sessions-and-hosted-access-checks">GRS-113</issue> or <issue id="13f1315c-d8af-4ac6-ae9a-e700a682f570" href="https://linear.app/vaper/issue/GRS-115/implement-hosted-d1-results-storage-and-protected-r2-assets">GRS-115</issue>; those owners then extend the skill's feature map to the real boundaries as part of their own acceptance, and the summary names each boundary as real or a double.
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

Native prerequisites: <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> (accepted local Workers build/stubs/fixture/boot/feature-map handoff), <issue id="7e83827a-23fd-431a-96c5-3d2471790e1c" href="https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha">GRS-69</issue> (approved plan), <issue id="617fe50a-a4ea-45e2-8834-659b007ffdf6" href="https://linear.app/vaper/issue/GRS-139/ci-verdict-without-github-pc1-vm-verify-and-verdict-answer-pass-or">GRS-139</issue> (CI inputs) and <issue id="74ea5f9a-cf9b-4273-bdfd-467611b33ca9" href="https://linear.app/vaper/issue/GRS-144/adopt-the-synthetic-poc-scale-corpus-generator-under-scriptsfixtures">GRS-144</issue> (synthetic corpus). <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> carries the local runtime and viewer prerequisites. <issue id="c99e1ba3-dc84-4bbc-aee5-f8c3c34692f2" href="https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation">GRS-27</issue> is not a prerequisite for this credential-free local bootstrap; it remains required for real-provider acceptance and the remaining foundation work.

This gate still blocks the foundation fan-out, viewer core, first workflow and foundation aggregate as recorded in native blocking relations. Passing this local gate never substitutes for real Clerk, D1, R2 or email evidence.
