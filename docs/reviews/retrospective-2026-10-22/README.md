# ClearCase retrospective — 22 October 2026

Publication note, 22 October 2026: this report preserves its audited revisions and readback times below. Before opening the draft PR, `dev` advanced to `e05d9a8175afd12aacbf580ce29bbb50829ecf15`, merging PR114 and the later notification retry fix from PR122. The draft branch incorporates that updated base. References below to PR114 as incoming/open describe the audit snapshot, not its current merge state. Recheck findings against the latest `dev` and active ticket work before adopting changes; the post-audit merge is not a fresh runtime audit.

## Decision

**The product direction remains aligned. The local pilot has made substantial progress. Hosted alpha is not ready for client use.** Keep the accepted SvelteKit/Workers/D1/R2/Clerk architecture and the first complete PDF workflow. The highest-return next work is correcting case identity and data-preservation seams, integrating the incoming proofs and guard work, and turning the foundation into one real submission-to-publication journey.

The production hosted adapter deliberately returns unavailable services. That is an honest, safe implementation boundary, not a newly discovered authorization failure. All 42 local views have owners and are available; their hosted counterparts are still largely planned. Additional probe or ticket completions cannot substitute for a functioning client journey.

This audit produced ten specialist reports plus a final challenge/review round. Seven initial Opus 5.5 High attempts failed on API rate limits; their scopes were reassigned. The completed specialist work used GPT-6 Astra High and GPT-6.1 Sol High. Failed attempts supplied no review verdict. Findings shared by reviewers are consolidated below, not counted twice.

## Snapshot and evidence limits

- Integrated baseline: `225b7e00578319d16383678a8d1ae6efb362a0ba` on `dev`; audit branch `audit/retrospective-2026-10-22`.
- Incoming proof wave: `a3f80d1305294a8c685a87351281eef7928c7d9c`, [PR114](https://github.com/GridShift-Software/clearcase/pull/114). Incoming guard wave: `99cf56bba6afc0bf30d0dc914816ad97d1a750ae`. Neither was merged during the audit. The guard wave diverges from an older base; its tip-to-tip diff is not a list of intended application reversions.
- The product reviewer read all **154 live Linear issues and their relations**, including archived records, over two list pages. The observations are dated, non-atomic reads. Live issues remain the execution authority; the committed 20 October plan is a snapshot.
- The CI reviewer inspected remote checks, logs and settings. The latest 60-run sample had 53 success, 3 failure, 3 canceled and 1 active; this is not a flake-rate estimate. The pinned dev push had successful remote CI. PR114's CI was successful on its test merge, while a substantive review objection remained. A green reviewer check does not settle its comments.
- **No local runtime acceptance was run.** Git Bash doctor refused unsupported OS `msys`; the command wrapper reported exit 1, while the source's refusal path specifies exit 2. WSL attempts also lacked `/bin/bash`. No successful doctor receipt, Linux gate, production-browser run or live Cloudflare proof was obtained here. Pure-function and simulated-I/O diagnostics are identified in individual reports and are not acceptance results.
- This was a broad source, dependency, evidence and operational review, not a claim to have exercised every code path. No real case material, secrets or production data were used. No deployment, merge, settings mutation or tracker write occurred.

## Progress against the intended product

Live issue totals were **90 Done, 47 Backlog, 7 In Progress, 8 In Review and 2 Canceled**: 62 open. Do not report 90/154 as product completeness. Design decisions, infrastructure repairs, probes, features and gates have very different sizes. M5 hosted delivery has 34 issues, of which only the runtime/bootstrap and its gate are Done; 32 remain open. All 42 view rows have local and hosted owners, but the six hosted view-owner tickets are Backlog.

The completed local work has real substance: separate immutable results and user work, activation/rollback, 42-view parity infrastructure, exact-money helpers, restart/restore coverage, source integrity checks, and recently merged CSV, interest-basis, timezone and deletion-confirmation repairs. The source review found no reason for a framework/database rewrite. The latest scope additions are recorded user-approved realignment, not evidence of arbitrary agent feature growth.

The critical path is still the existing one:

1. Resolve **GRS-24's concrete compatibility contract decision**, preserving its disclosed browser/original/performance limits.
2. Integrate **GRS-26's proof wave**, resolve its remaining findings, and complete the authorized provider handoff and **GRS-27 design checkpoint**. Cloudflare remains pinned under current owner decisions; approved Clerk-development work is a separate allowance.
3. Implement **GRS-113–118**, aggregate at **GRS-36**, then deliver **GRS-120 plus GRS-137**: synthetic PDF submission, operator claim/download, the user's actual manual recipe, private import/edit, fresh sign-off, publication, client overview and in-app cited original.
4. Widen into remaining formats/views, then **GRS-66/32** acceptance with real-provider, recovery, operational and client-workflow evidence.

No reliable finish date or current productivity/spend rate can be derived from these records. Provider and user decisions, manual processing duration, active execution time and queue wait need separate measurement. Existing GRS-165/166/167 already own measured verification-cost work; use those rather than deleting tests indiscriminately.

## Priority actions

These are audit recommendations mapped to existing owners where possible, not new tickets or changes made by this audit. “Now” means before relying on the affected workflow or copying it into hosted production. Specific report IDs retain the original evidence and reproduction limits; their numeric severity schemes differ, so use this ordering for the consolidated handoff.

| Order | Action and concrete failure | Scope / owner route | Closure evidence |
| --- | --- | --- | --- |
| Now | Bind PDF builder drafts, async completion and saved output to their originating case. Case A's module state can appear/save under case B. | Local; ARCH-01 / D1; local bundle owner with GRS-133/128 | Real A→B→A browser journey, including assembly/save in flight; verify bytes, metadata and destination case. |
| Now | Reject accidental case-ID collisions in click import. Unrelated folders named `Pack` normalize to one identity despite different labels. | Local; ARCH-02; GRS-70/47 | Same basename, accent/case/truncation collisions; separate active pointers and saved user work; legitimate repeat updates retained. |
| Before release; P2 | Compare the displayed row version before generic-register deletion. A stale tab's confirmed deletion can erase another tab's newer save. | Local; D2; register owner; narrowed by final challenge | Two-tab edit/delete and edit-after-confirmation conflict; current row remains unchanged. |
| Now | Prevent multipart completion from replacing an acknowledged original after two requests both pass HEAD. | Incoming proof only; SI-01 / CF-05; GRS-109→115 | Native concurrent completion/finalization test; upload-specific immutable keys or another recoverable ownership protocol. Not a vulnerability in the unavailable production adapter. |
| Now | Handle partial output writes in verified original snapshots; current code hashes input and ignores `bytesWritten`. | Local; SI-02; originals owner | Early/final short writes, zero progress and disk errors produce exact bytes or refusal/cleanup. |
| Before normal bundle use | Remove executable PDF page actions from generated derivatives and bound decoding/import allocations. Preserve unchanged originals separately. | Local; SI-03/04/05; bundle/import owners | Inspect output action graph; small over-budget compressed/HTML fixtures refuse safely; legitimate content survives. No app-origin script execution was demonstrated. |
| Before merge/recovery reliance | Reconcile branch/release enforcement and live action allowlist. Fix PR114's separate verifier setup for nested identity dependencies and real Node. | Repository/incoming; CI-01/02/03 | Effective GitHub rules/settings readback and authorized negative checks; fresh Linux `pc1-vm verify` with exact-SHA receipts and service restoration. Settings remain unchanged here. |
| Before hosted dispatch | Reconcile reserved routes with `deploy/client/routes`; connect GRS-120 to GRS-137 acceptance; connect GRS-177 dispositions and GRS-176 coverage to release. | Planning; PD-1/2/3; GRS-27/137/177/66/32 | Live scopes/graph and generated snapshot agree; emitted hosted routes exist; each temporary IDR has an owner or explicit disposition. Do not assume all 30 temporary exceptions require implementation. |
| Before trusting factory checks | Collect Python/shell control behavior suites; invalidate stale fix-round label verdicts; acquire browser admission in the local runner; validate referenced feature steps. | Controls; VC-1–4 | Negative controls actually fail CI/index/admission, including invalid label state at the same head. Documentation alone does not fix these gaps. |
| Before release acceptance | Wait for complete incremental tables; require persisted values from AC3 edits; bind aggregate metrics to one app/build revision; run composed readiness checks. | Acceptance; AP-1–4 | Late-row/disabled-save/no-op/stale-summary controls fail; required readiness evidence at integrated release SHA. No measured performance breach is claimed. |
| Before affected data paths scale | Commit rescans atomically; make backup export limits symmetric with restore; preserve dotted keys, duplicate CaseLines sections and pre-normalized numeric values; share exact monetary formatting; bind Word index links to built source selections. | Local; ARCH-03/04, D3–8 | Failure injection preserves whole prior scan; backup boundary round trips; lossless marker/numeric fixtures; cross-view cents and changed-source index checks. |

The bundle and backup findings appearing in multiple reports are the same defects. Existing GRS-178 reload-family work, GRS-179 guard residuals, GRS-150 semantic-review limits, GRS-128 durable bundles and GRS-118 hosted recovery should not be recreated as new umbrella tickets.

The [final critical-finding challenge](critical-findings-validation.md) supports all six examined core findings, with qualifications that take precedence over broader wording in the initial reports. D2 is P2 because it requires a concurrent edit followed by an intentional confirmed deletion. A save already dispatched from case A does not retarget its HTTP request to case B; the supported bundle defect is retained state saved after navigation, plus shared-state completion effects. Import conflates case identity but does not automatically activate the second candidate or overwrite original bytes. The multipart race is an incoming, unauthenticated storage-probe design issue within one client's bucket, not a demonstrated deployed exploit. Short-write occurrence on the pinned runtime and downstream PDF action execution remain unproved; simulated I/O and retained PDF structures establish narrower claims.

## Cloudflare: optimize the proven path

Keep per-client Workers/D1/R2/Clerk and one codebase. The lowest-cost improvements are bounded UTF-8 byte batching (not JavaScript string length), conditional writes where supported, deletion predicates inside write batches, explicit upload/read concurrency, and privacy-bounded operational signals under **GRS-147**. Single PUT conditions do not invent a conditional multipart-complete API. These recommendations and current primary sources are in [Cloudflare readiness](cloudflare-readiness.md).

Before provisioning/rollout, reconcile the trusted deployment schema with the recovery bucket and EU-jurisdiction choice. Record app/config digests, Worker version, migration set and recovery bookmark. Exercise code rollback against the migrated schema: Worker rollback is not database rollback. Prove that newly acknowledged originals survive the selected failure model, that restore does not revive withdrawn/deleted content or revoked grants, and that real cleanup timing meets the accepted retention policy.

Measure whole-original hashing and repeated small PDF ranges under concurrent real viewer traffic, plus Clerk live-session call volume, D1 binding/query limits, recovery/export peak memory and largest-entry behavior. Local timings do not establish remote budgets. Keep revocation and integrity guarantees while measuring; caching them away changes correctness. GRS-93 owns policy/budgets, GRS-109 the storage proof, GRS-113 identity and GRS-118 recovery.

Defer read replication, authorization caches, traffic splitting, extra queues/coordinators/databases and processing-prompt optimization until a measured need justifies them. Necessary durable outbox/recovery scheduling remains part of the accepted design. There is no evidence here that adding more infrastructure speeds the first two-client alpha.

## Verification and instruction changes made

Ten existing documentation/skill files were updated in this audit branch; application code, executable verifiers, CI configuration and remote settings were not changed:

- Both verification skills now distinguish driven actions and real/doubled boundaries. The local skill separates application revision from the calling verifier's revision/state and discloses its admission/reference-validation gaps.
- The local map correctly describes the case card's activation destination and stale-run FAIL behavior. The hosted map requires its final gate once; a duplicate standalone drive is optional debugging because the gate contains the same lifecycle.
- Verification guidance names omitted control suites, label-input freshness, dependency-review limits, targeted checks and failed-provider handoffs, while retaining mandatory gates and independent review.
- AGENTS guidance covers missing external workspace instructions and the actual hosted route selector. Product approval, Greptile versus human release roles, GRS-147 ownership and the authorized Clerk-development exception were corrected from source/live evidence.
- The final guidance review prompted matching provider-disposition corrections in the operating plan and dated acceptance baseline, a precise independently-reviewed-checks claim, and an accurate description of recorded browser-background canary hits. These preserve the offline network and production/cloud HOLD requirements.

The ten audit reports document remaining executable fixes; **updating instructions is not equivalent to repairing those mechanisms**. Live tracker graph/scopes and generated snapshots still need coordinator reconciliation. No automated review/gate was weakened to make a result green.

Validation: both edited skills pass the skill metadata validator; `git diff --check` passes. A working-tree link/anchor check including the new reports found no broken links. These are document checks, not app acceptance. The [guidance review](guidance-change-review.md) found one medium and two low residuals; the corrections passed the [focused recheck](guidance-recheck.md), with all findings closed and no weakened gates. The [critical-finding challenge](critical-findings-validation.md) is complete and its qualifications are incorporated above. The guidance and all linked audit reports are packaged together for draft review; the review records retain their original working-tree context.

## Specialist evidence

1. [Product direction, live tickets and delivery](product-and-delivery.md)
2. [Architecture and feature implementation](architecture-and-features.md)
3. [Security and data integrity](security-and-integrity.md)
4. [Cloudflare research and capacity worksheet](cloudflare-readiness.md)
5. [Verification skills and factory process](verification-and-factory.md)
6. [CI, DevOps and repository health](ci-and-repository-health.md)
7. [Acceptance coverage and performance](acceptance-and-performance.md)
8. [Independent data correctness review](gpt-data-correctness.md)
9. [Independent adversarial controls review](gpt-verification-controls.md)
10. [Independent alpha readiness review](gpt-alpha-readiness.md)

Final review records: [critical-finding challenge](critical-findings-validation.md), [guidance change review](guidance-change-review.md), and [guidance correction recheck](guidance-recheck.md).

Each report contains exact source references, distinctions between observed/reproduced/inferred claims, proposed minimum fixes and validation. Treat the reports as audit evidence, not an alternate issue tracker or approval to deploy.
