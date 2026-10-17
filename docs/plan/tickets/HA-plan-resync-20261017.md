# Resync the plan snapshot and generated briefs to live Linear of 17 October (13 stale descriptions)

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-142/resync-the-plan-snapshot-and-generated-briefs-to-live-linear-of-17) is the execution authority.

Planning key `HA-plan-resync-20261017`. Preparation sprint, wave `wave/preflight-parity`.

## Outcome

`docs/plan/work-items.json`, the generated briefs under `docs/plan/tickets/` and `docs/delivery-plan.md` match live Linear as captured on 17 October, so the briefs workers read at dispatch carry the accepted descriptions.

## Why

The final readiness audit of 17 October (<issue id="7e83827a-23fd-431a-96c5-3d2471790e1c" href="https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha">GRS-69</issue> comment, receipt `.local/agent-receipts/20261017T141134.572430Z-linear-relations/receipt.json`) found that the structural plan graph passes at `525aa8a` but the full description comparison fails on 13 issues changed in Linear after the committed snapshot: <issue id="3ee13f2b-c1b4-44bb-9c43-cd750b3623e5" href="https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work">GRS-36</issue>, <issue id="3e18e69c-1912-45e4-aa6a-5e4d6ceac22c" href="https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime">GRS-106</issue> to <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue>, <issue id="13f1315c-d8af-4ac6-ae9a-e700a682f570" href="https://linear.app/vaper/issue/GRS-115/implement-hosted-d1-results-storage-and-protected-r2-assets">GRS-115</issue> to <issue id="f82e9243-2d68-47ee-8ae1-b62cb98f4d58" href="https://linear.app/vaper/issue/GRS-118/implement-complete-case-export-backup-recovery-and-approved-deletion">GRS-118</issue> and <issue id="b97a8bee-9190-453b-9a7d-6e98099ad25f" href="https://linear.app/vaper/issue/GRS-135/implement-the-internal-fifo-processing-queue-and-audited-operator">GRS-135</issue>. No dependency mismatch was reported. The readback capture is `.orchestration/kickoff-live-linear-readback-20261017.json` (114 issues, 63 open).

## Reserved write scope

* `docs/plan/work-items.json`
* `docs/plan/tickets/**`
* `docs/delivery-plan.md`
* `tests/agent-tools/fixtures/graph/**` only where a fixture pins a count that the resync changes

Nothing under `src/`, `scripts/`, the parity register or the workspace instructions.

## Acceptance

- [ ] `scripts/agent-tools/check-plan --linear-relations .orchestration/kickoff-live-linear-readback-20261017.json --require-linear-relations` reports `plan-graph` PASS and `linear-relations` PASS (0 description drifts, 0 dependency mismatches) at the fix head. `plan-format` may still be SKIPPED; that is <issue id="75c4dcbc-09d3-4db9-b156-0c1fb1ea6aa7" href="https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery">GRS-104</issue>.
- [ ] `python3 scripts/planning/generate.py --compare-linear` on the same capture reports 0 drift.
- [ ] <issue id="7ee8f208-ad5b-4717-8513-dc512aff98d7" href="https://linear.app/vaper/issue/GRS-141/dev-gate-fail-at-8ab9ef4-overview-and-documents-subtitles-differ-from">GRS-141</issue> and this issue have planning keys in `work-items.json` and generated briefs.
- [ ] Hand-edited edges and briefs are not reintroduced: the live capture is the authority for descriptions and relations; if the generator and the capture disagree on structure, the report names the disagreement instead of editing the capture.

## Verification and handoff

Doctor at session start, `receipt`-wrapped runs of the two checks above at the exact head. Report PASS or FAIL at an exact SHA, the receipt paths and the list of items whose description changed. One fresh diff review, at most one written-finding fix round. Only the coordinator writes Linear.

## Boundaries

Docs-only. No case material. No Linear writes from the worker. The branch is cut from `wave/preflight-parity` and its PR targets that wave.
