# Independent GPT review: hosted alpha readiness

Date: 22 October 2026. Baseline inspected: `225b7e00578319d16383678a8d1ae6efb362a0ba` on `audit/retrospective-2026-10-22`.

**Verdict: NO-GO for hosted alpha acceptance.** The repository contains a substantial local application, a deliberately limited hosted bootstrap, useful contracts and component evaluations. It does not yet contain a working production hosted submission-to-publication journey. This is principally tracked unfinished implementation, not evidence that the delivered local app is defective. Proceed toward the existing GRS-137 PDF workflow after its foundation prerequisites; do not substitute a probe PASS, local activation or a test-identity download for that workflow.

## Scope, method and limits

This is an independent end-state and sequencing assessment. I inspected the product brief, ADRs 0007–0011, development and package contracts, glossary, planning snapshot and relevant ticket briefs, local activation/backup code, the hosted route selection and request services, hosted smoke assertions, viewer evaluation/handoff, and relevant incoming proof/guard changes. I did not read the other retrospective reviewers' reports or claim an exhaustive line-by-line review of every implementation file.

All baseline `path:line` references below refer to `225b7e00578319d16383678a8d1ae6efb362a0ba`. Incoming references explicitly name their revision:

- Proofs/PR #114: `a3f80d1305294a8c685a87351281eef7928c7d9c` (`origin/wave/proofs-final`).
- Guard follow-ups: `99cf56bba6afc0bf30d0dc914816ad97d1a750ae` (`origin/wave/guard-followups`). Its merge-base with baseline is `e44e12b397561e7d7ad229e8fad00753db9f00bc`; I used the merge-base diff to distinguish incoming work from changes already made independently on dev. A tip-to-tip diff is not a proposed deletion list.

Doctor was attempted through Git Bash: `C:/Program Files/Git/bin/bash.exe scripts/agent-tools/doctor`. It refused with `agent-tools: unsupported OS 'msys'. Supported: Linux (Arch, CachyOS) with bash >= 4.4. See docs/agent-tooling.md.` The command wrapper reported exit 1; `_common.sh:6–9` specifies exit 2 on this path. No successful doctor receipt was obtained. The Linux gates, browser acceptance, runtime probes and tests are **UNRUN in this review at the baseline SHA**. I did not bypass the platform guard, inspect private `.local` evidence, use case material, or contact production. Historical results below are inspected records, not newly reproduced passes. No implementation, tests, configuration, skills, Git history or external services were changed.

Skills actually used: `cloudflare` and `workers-best-practices`, for platform review and current primary-source retrieval. No verification skill was invoked. Live Linear reconciliation is left to the dedicated product reviewer: the 20 October snapshot explicitly says live issues are authoritative (`docs/plan/work-items.json:3592–3602`). Issue names here indicate ownership, not independently verified current status or authorization to dispatch.

## Findings ordered by actionability

### A1 — Hosted production remains intentionally unavailable; the first complete PDF workflow is unproved

**Classification:** confirmed implementation state / tracked planned work. **Priority:** P1 alpha blocker. **Confidence:** high.

`src/lib/server/runtime/hosted/services.ts:8–15` constructs unavailable services and returns `ready: false`. `src/lib/server/runtime/hosted/handle.ts:19–34` allows only health through that readiness refusal and separately refuses the local filesystem browser. The production smoke explicitly expects protected requests to return 503 (`tests/hosted-foundation/runtime/smoke.ts:60–69`). Therefore a passing production smoke currently establishes safe refusal and runtime plumbing, not usable production identity/storage.

The gate profile is also narrower than the product journey:

- `src/lib/server/runtime/hosted/gate/services.ts:42–50` installs fixture services and leaves user work unavailable.
- `src/lib/server/runtime/hosted/gate/store.ts:19–22` explicitly excludes results, versions, documents and datasets from its bootstrap.
- `deploy/client/routes/cases/[caseId]/+page.server.ts:19–21` renders published results as unavailable because storage is not connected.
- `src/lib/server/runtime/hosted/gate/assets.ts:73,81–96` supplies no viewer URL, refuses an applicable Range request and delivers the original as an attachment. The smoke tests a byte download, not an in-app PDF reader or page citation.

This is consistent with the bootstrap's documented limits; it is not a discovered production bypass. The incoming proof wave does not replace these production services or build the missing intake/review/publication routes.

**Smallest next action:** adopt the identity, storage, user-work and recovery contracts into the production artifact through their existing foundation owners, then execute the already scoped GRS-137 workflow alongside GRS-120's protected PDF reader. Do not add all 42 views first. Keep the bootstrap pass visibly distinct from foundation acceptance and first-workflow acceptance.

**Validation:** a non-double production artifact at one exact SHA must accept a fresh synthetic PDF, permit an authorized operator to claim/download it, resume with human-produced output, import/edit/sign off/publish privately, and let a real authorized client read the overview and exact cited PDF page. A verified hash download alone fails the viewing criterion. This is already required by `docs/plan/tickets/HA-first-workflow.md:24–29`.

### A2 — Route reservations and owner references are out of step with the actual hosted build

**Classification:** confirmed documentation/handoff defect; future missing-route regression is a risk, not an observed shipped failure. **Priority:** P2, fix before dispatch. **Confidence:** high.

The hosted build selects `deploy/client/routes` (`deploy/client/hosted-files.json:2`; `vite.config.ts:18–24`). GRS-137 instead reserves `src/routes/v/[vid]/overview/**`, `src/routes/client/intake/**` and `src/routes/admin/**` (`docs/plan/tickets/HA-first-workflow.md:13,20`). Storage and recovery briefs likewise reserve endpoints in `src/routes` (`HA-storage.md:21–28`; `HA-recovery.md:21–27`). Adding routes there alone cannot expose them in the selected hosted route tree. This is a concrete integration trap even if a later dispatch brief is intended to repair reservations.

The runtime comments also assign storage to GRS-117 and assets to GRS-118 (`src/lib/server/runtime/hosted/services.ts:8–9`; `hosted/gate/assets.ts:18`). The snapshot and foundation brief assign protected D1/R2 storage to GRS-115, user work to GRS-117, and recovery/export/deletion to GRS-118 (`docs/plan/tickets/CC-28.md:14–17`). The incoming storage proof repeats the older ownership shorthand (`a3f80d1:docs/acceptance/hosting/storage.md:5`).

**Smallest fix:** coordinator records the actual hosted route paths and transfers shared files in each dispatch; correct the stale owner IDs. Reuse shared domain modules across local/hosted routes rather than switching the whole local route tree into Workers. No new architecture is needed.

**Validation:** inspect the emitted production route manifest and drive each required route on workerd. A route existing under `src/routes` or rendering on the local pilot is insufficient. Check the generated briefs and authoritative ticket reservations agree before their owners start.

### A3 — Local activation is useful infrastructure, but cannot serve as hosted sign-off

**Classification:** confirmed semantic difference / tracked publication work; unsafe reuse is a hypothesis. **Priority:** P1 for the first workflow. **Confidence:** high about the difference, no claim of a live exploit.

ADR-0010 requires separately recorded sign-off, an exact-version binding, explicit publication authority, complete validation and preserved user work (`docs/adr/0010-exact-version-signoff-and-publication.md:8–28`). The local `canActivate` policy only requires acknowledgement when there are fresh warnings (`src/lib/case-package/policy.ts:24–48`). With no errors and no fresh warnings, no acknowledgement is needed. `CaseStore.writeActivation` updates a pointer and records the local activation, allowing a null acknowledgement (`src/lib/local-case/store.server.ts:159–171`). Those are appropriate local semantics; neither function records the hosted publisher's explicit case grant and human sign-off.

The hosted runtime contract currently exposes case read/original/preview/user-work operations, not review/approve/publish operations (`src/lib/server/runtime/contracts.ts:21–24`). Candidate editing and publication have downstream owners. The library's class named `Candidate` and its content hash are not proof of private access control or human approval.

**Smallest fix:** implement one explicit approval record and one guarded publication operation in the GRS-137 slice. Bind the human decision to the exact candidate identity and its validated required sections/previews; store actor, time and acknowledgements. Recheck authorization and the expected current publication when switching the pointer. Preserve separate candidate, approval and publication events. A saved edit creates a new identity and cannot inherit the old approval. Do not enlarge the slice into a general workflow engine.

**Validation:** approve A, edit to B, attempt to publish B with A's approval and observe denial with no pointer or user-work change; then revalidate/sign off B and publish it. Also test a clean zero-warning candidate without approval, a revoked publisher, competing publication attempts, a failed required preview, and interruption before the commit. Try candidate result/preview/export URLs with a valid client session, not only an anonymous one. Unknown required content must hold the entire update. These are obligations of GRS-30/31/130/137, not new duplicate tickets.

### A4 — Viewer research is valuable, but accepted-format and hosted fidelity acceptance remain open

**Classification:** documented component limitations and tracked integration/proof gaps. **Priority:** P1 for full alpha; only the PDF subset blocks GRS-137. **Confidence:** high.

ADR-0011 requires every accepted published file and supplied location to be readable in-app; a failed required preview holds the whole update (`docs/adr/0011-originals-and-complete-in-app-file-viewing.md:8–32`). The temporary pre-publication download exception does not extend to publication.

The component evaluation records 418 PASS and 11 FAIL observations and explicitly holds Firefox/WebKit/real mobile devices (`docs/acceptance/viewers/coverage-matrix.md:7–13`). The failures helped choose alternatives; they do not mean 11 known failures must ship. Conversely, the selected alternatives still need production acceptance. The document identifies missing tests for XLS formulas without cached values, TNEF companion clearance and HEVC, including that HEVC is not currently classified into a required rendition hold (`coverage-matrix.md:61,69,78`). These are disclosed evaluation limitations, not newly discovered product defects.

The handoff expressly leaves hosted whole-object integrity/ranges, the credential-free viewer origin, browser/device checks, genuine owner-created synthetic email exports, and Worker-side parsers unproved (`docs/acceptance/viewers/handoff.md:49–61`). Its large-file tiers report measurements without latency or memory budgets (`handoff.md:68`). The evidence JSON records pre-rewrite SHA `8f3194619db99626f074661bce2e67903477ba89`; the coverage document maps it to `1932037ab00fd919e945ad17b40422d7688c5d75` and the same harness tree. That provenance explanation is useful, but is not a fresh acceptance run at this audit SHA.

**Smallest fix:** ship the protected PDF/original/page-citation slice first. Carry a per-format proof ledger into GRS-120–123; distinguish rejected alternatives from mandatory repairs in selected readers. Bind readiness to exact original and file-preview hashes. Include the existing corrupt-body PNG case when the broader publication gate lands: syntax-valid metadata must not override a reader failure. Record unsupported files as held, not silently download-only.

**Validation:** test the selected production readers and delivery path, including valid and invalid page references without clamping, original-versus-generated page labels, changed preview bytes after validation, and nested attachments. Freeze the supported browser/device matrix and run it; Chromium mobile emulation cannot certify Safari codecs or device memory. Retain complete export manifests linking originals and published previews. The 42-view and full-format release obligations stay intact after the PDF slice passes.

### A5 — Recovery proof must compose storage, authority and asset history

**Classification:** tracked implementation gap plus explicitly disclosed incoming residuals. **Priority:** P1 alpha blocker. **Confidence:** high.

The agreed outcomes are different: publication rollback loses **no** user work; disaster recovery permits at most one hour of recent Notes/case edits, while acknowledged uploads remain recoverable; recovery copies have a rolling 30-day window. Four staffed hours is a measured restoration aim, not a strict launch SLA (`docs/plan/hosted-alpha-acceptance.md:25–28`). Do not apply the disaster-recovery allowance to ordinary rollback.

Local `backupWork` uses `VACUUM work INTO` and fsync/rename (`src/lib/local-case/store.server.ts:174–188`), and local restore takes a pre-restore copy (`src/lib/user-work/backup/backup.server.ts`, `copyBeforeWrite` and `restoreBackup`). This provides reusable behavior, not a hosted coherent restore implementation.

The incoming probes materially improve confidence: PR #114's recorded fix rounds cover inconsistent snapshots, interrupted erasure and restore leftovers. They must not be reported as still-unfixed discoveries. However, `a3f80d1:docs/acceptance/hosting/recovery.md:182–184,188–201` still records:

- real Time Travel RPO, platform rotation and remote restore elapsed time on HOLD;
- a write admitted before removal that can commit after removal unless deletion is checked inside the write batch;
- revoked-grant resurrection on restore not yet tested because grants belong to identity;
- a remaining decision about durable bundle versions in case backup.

**Smallest fix:** foundation integration must add deletion-state checks to the same batch as user-work writes and compose identity revocation with the restore design. Explicitly inventory originals, published previews, current/previous publication, Notes/registers/costs, durable bundle versions and deletion/revocation records in the backup contract. Bundle recovery should not depend on a tacit assumption that regenerated bytes equal a saved version. Keep authoritative deletion/revocation reconciliation outside whatever state is being rewound.

**Validation:** preserve byte-for-byte user work through publication failure and rollback; then separately restore a client after a timed sequence of edits, acknowledged uploads, revoked grants and approved deletion. Verify original hashes and published previews, no resurrected access/data, bundle history/Keep protection, and a working app after restart. Run a race between removal and saving. Measure remote RPO and restore duration; local dumps cannot certify Time Travel.

Current Cloudflare documentation describes D1 Time Travel as database point-in-time recovery and R2 consistency as object operation visibility. Neither is evidence of a coordinated ClearCase recovery point across D1, R2 and permissions. That last conclusion is an architectural inference, not a provider guarantee. Sources retrieved for this review: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

### A6 — Readiness status is contradictory across authority documents

**Classification:** confirmed documentation defect. **Priority:** P2. **Confidence:** high.

`docs/product-brief.md:7` says overall plan approval remains open, every hosted issue is blocked by it and every runtime proof is unrun. ADR-0009:36 and ADR-0010:30 repeat the open planning gate. But `docs/plan/hosted-alpha-acceptance.md:8` and `docs/plan/work-items.json:3602` record approval on 17 October and the snapshot separately records local hosted evidence. The incoming identity proof additionally records actual Clerk-development work, which makes a blanket “all provider checks unrun” stale when discussing that incoming head. This is not a basis to mark production acceptance passed.

**Smallest fix:** after the product reviewer reconciles live Linear, update the brief's decision-state paragraph and ADR status notes, while keeping implementation acceptance separate. Maintain one compact ledger with capability, owner, production route/adapter, evidence type, source SHA, fixture/configuration, unresolved HOLD and next proof. Link historical documents to it; do not copy a new static status into every paragraph.

**Validation:** the brief, foundation dispatch and release checklist should give the same answer to “approved?”, “implemented?”, “tested locally?”, “tested against provider?” and “accepted at release SHA?”. A new developer must not infer authorization or a production pass from a completed research ticket.

## Incoming evidence: what it changes and what it cannot establish

These are recorded source SHAs from the committed summaries, inspected at `a3f80d1305294a8c685a87351281eef7928c7d9c`. I did not rerun them or their evidence checkers.

| Proof | Recorded source SHA | Useful evidence and remaining boundary |
| --- | --- | --- |
| Runtime, already on baseline | `098f2ad48363a500e103c9ff0483de5b4b8e4816` | Local workerd runtime probe; not the product migration or cloud deployment. |
| Deployment | `45e736f9d6ccf9c87f50872eb2e6963f43a5581f` | Local artifact/target/credential-boundary checks; real upload, grants, rollback and teardown remain HOLD. |
| Identity | `a0b458afc993fe5c2393268c5079205d8499f9f7` | Real client/staff Clerk development sessions with local Workers. The second real client issuer, sibling production subdomains and clerk-js/CSP integration remain HOLD. |
| Storage | `eb855c2e4092e5fdacf4367501a607089b094f6e` | POC-scale synthetic bytes, integrity/concurrency/export/restore model; remote CPU, latency, upload and placement remain HOLD. |
| Recovery | `e3d1cacf1641eecc991ac2df799870db68fb431a` | Local failure/reconciliation model, including fixed erasure/snapshot classes; remote RPO/rotation/restore remain HOLD. |
| Notifications | `0493a66d06206fae872bb03f8cee01ddc6e732cb` | Local simulated sending and failure behavior; no real message delivery/inbox proof. |

Sources: baseline `docs/acceptance/hosting/evidence/runtime-summary.json`; incoming `docs/acceptance/hosting/evidence/{deployment,identity,storage,recovery,notifications}-summary.json`, plus each matching Markdown report's opening verdict and “What stays HOLD”.

The incoming gate adds committed-evidence checks and previously uncollected probe cases (`a3f80d1:scripts/gate-hosted.mjs:61–96`). That is useful regression control. A check that an ancestor's probe inputs remain unchanged does not mean the integrated app was exercised at the new head. Keep both facts in reports: the historical probe run and a fresh product acceptance run at the release candidate. In particular, the storage corpus models byte volume rather than valid rendered documents (`a3f80d1:docs/acceptance/hosting/storage.md:35–55`); it cannot replace fresh manually processed results.

The guard follow-ups add Git-environment isolation to revision reads and test subprocesses and fix guard reference handling. They strengthen trust in subsequent receipts; they do not create a product workflow. I did not re-audit that entire guard. Preserve this work, integrate it and run the affected checks once at the combined head; do not keep reporting its addressed classes as new findings.

The incoming storage document also explicitly leaves two-pass delivery exposure, non-ASCII chunk sizing and remote step CPU open (`a3f80d1:docs/acceptance/hosting/storage.md:228–233`). Those deserve bounded transfer decisions before copying probe code into product storage. Streaming and bounded buffers are useful now: Cloudflare's current [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#stream-request-and-response-bodies) recommends them and warns against whole-body buffering. That guidance does not override ClearCase's stricter integrity-before-disclosure requirement. The design gate must reconcile both instead of assuming one solves the other.

## Smallest next vertical slice and efficient sequencing

The plan already has the right main shape. `docs/plan/tickets/HA-first-workflow.md:18` deliberately excludes upload resume, FIFO ordering and deliberate rollback from the first path while retaining correctness; `CC-28.md:20–30` defines the preceding foundation checkpoint. Execute this plan rather than create another planning layer.

1. **Make the foundation handoff concrete.** Reconcile route reservations/owner IDs, integrate accepted proof lessons, and connect production identity, per-client resources, protected assets, stable case/user-work storage, audit and minimum recovery/export primitives. Run the existing two-client grant/revocation and failure tests on those product adapters. Do not substitute test identities for completed identity work.
2. **Use one fresh small synthetic PDF submission.** Record client/case/submission IDs, the finalized input manifest, original byte hash and the operator's exact download. Prove the original remains retrievable before publication and the case shows an honest waiting state.
3. **Respect the existing manual gate.** Stop at `AWAITING MANUAL RESULTS`, naming the manifest, download and expected package shape. The user runs the current recipe; resume import at the same SHA with that output (`HA-first-workflow.md:31–33`). Do not have an agent manufacture an equivalent package and call it manual processing. Pre-arrange this handoff so human availability does not stall an otherwise complete slice.
4. **Prove the private/public boundary.** Import, validate, explicitly approve A, correct to B, reject A's stale approval, revalidate/approve B and publish. Use the same PDF reader behavior during private review and client reading. Add one failure attempt with a prior publication and existing user work, rather than testing only the first ever publication.
5. **Accept and transfer, then widen.** Pin the accepted artifact/fixtures/receipts and hand routes to their owners. Add resume/FIFO/supplements, full editing/rollback/notifications, the other accepted formats and the 42 views. Re-run the selected production path after each shared-boundary change.

Useful advance work already done: immutable content identities, results/user-work separation, stable case identities, optimistic write tokens, default denial, independent original hashes, reader containment, realistic volume probes, failure injection and honest test-double labels. These directly reduce expensive rework or data loss; they are not merely premature optimization.

Work that should wait: prompt optimization/evals, automated processing, live mailbox integration, navigation redesign, a general workflow engine, speculative database layouts and repeated broad component comparisons after the frozen choice. Avoid turning independent models into a second production codebase. Port the smallest contract plus its failure tests, then retire duplicated assumptions. Runtime cleanup/guard fixes that prevent false evidence are worth completing, but set a stopping criterion and move to the integrated path once the observed classes are covered.

The foundation does have a long critical path because recovery/export precede the first user journey. Preserve its accepted data-safety obligations, but keep each implementation to the minimal product-backed primitive needed for the checkpoint; broad recovery UI polish and feature migrations belong downstream. If its scope proves too large, seek explicit scope/dependency realignment rather than silently skip the gate. Track first-workflow elapsed time, review/fix time, time awaiting human results, and unresolved-boundary age. Test count, report volume and completed probe tickets are poor measures of distance to alpha.

## Measurable go/no-go conditions

**GO to continue bounded engineering:** the independent static assessment supports continuing the existing foundation/first-workflow sequence, subject to current native blockers. It does not approve deployment or accept any checkpoint.

**GO for GRS-137 only when all of the following hold at one exact accepted SHA:**

- Fresh finalized synthetic PDF inputs and human-produced results are linked by retained manifests; all stages run through the production hosted artifact and selected real boundaries. Test-double legs remain separately labelled.
- Client A can open its published overview and valid PDF page with verified original bytes; a publication-state change cannot create an invented result or hide independent user work.
- Every tested wrong-client, wrong-case, unassigned, revoked and private-candidate access is denied with zero protected content released, including direct assets and exported paths.
- An edited candidate cannot publish under an earlier approval; required validation/preview failures cause zero publication-pointer changes. A selected failed update leaves prior results and user work intact.
- Independent implementation and verification review is complete; the human sees the actual path. A download, a probe app or a stale summary cannot satisfy this checkpoint.

**GO for alpha only when GRS-137 plus the broader accepted scope passes:**

- All 42 meaningful view workflows and v5/newer-2,131-document/JSON compatibility obligations are accepted; navigable tabs alone do not count.
- Every accepted published format, nested child and supplied reference has a tested in-app path on the agreed browser/device matrix. Required failed/unmapped previews block publication. Exports preserve originals, previews and their manifest; Notes are opt-in.
- Production client/staff identity, two client instances, resource-swap negatives, grant revocation, private review and cache/file/export isolation are tested together. Real identity/provisioning and cloud HOLDs are closed or the scope is explicitly revised before acceptance; local denial tests do not close provider HOLDs.
- Publication rollback preserves all user work. A coherent disaster restore meets the one-hour recent-edit objective, preserves acknowledged uploads, honors deletion/revocation and retains the agreed asset history. The 30-day recovery policy is demonstrated; restore time is measured against the four-staffed-hour aim without inventing a hard SLA.
- Intake/supplements/FIFO, Notes permissions, case costs, KYC, drafts, privilege, durable bundles, scoped audit and required notifications meet their accepted behavior. Email failure does not undo publication or block file access; provider acceptance, mail-server delivery and observed inbox placement are distinct observations.
- Release evidence names SHA, artifact/profile, fixture hashes, configuration, command/receipt, result and outstanding issues. Required checks are neither skipped nor mocked at the acceptance boundary. The user/Global Admin makes the launch decision.

Numeric latency/load budgets are still a decision gap, not permission to invent passing thresholds after measuring. Before remote workload acceptance, choose and record tolerances for first-case open, original/citation open, upload completion and export, using the accepted POC envelope and a representative South African connection. Record cold/warm distributions and failure/retry rates. The initial one-or-two-client rollout is guidance, not a new code-enforced cap.

## Low-effort improvements with immediate payoff

1. Correct the route and ticket-owner handoff drift before any new owner writes code (A2).
2. Separate five status columns in the readiness ledger: decision, implementation, local proof, provider proof and release acceptance. Populate it from existing artifacts instead of commissioning another audit (A6).
3. Give GRS-137 one named human-processing handoff package and booked checkpoint; retain the exact recipe/version and package-shape instructions. This addresses the known long pole without optimizing prompts.
4. Make the stale-approval and failed-preview scenarios part of the first production publication test. Add the zero-warning/no-sign-off negative so local activation semantics cannot accidentally become the hosted policy (A3).
5. Put restore-after-revocation and remove-versus-save races into the product foundation acceptance before the new adapters are considered complete (A5). Reuse incoming fixes rather than reopening their resolved probe bugs.
6. Keep bootstrap health, functional readiness and provider evidence distinguishable in operational reports. A `/health` sentinel round-trip should never be summarized to the user as “the alpha works”.

No new standalone platform, orchestration system or mass ticket fan-out is justified by this review. The next useful milestone is one complete, independently witnessed hosted case with faithful viewing and failure preservation.
