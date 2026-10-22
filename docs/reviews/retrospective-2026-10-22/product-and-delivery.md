# Product and delivery retrospective

Review date: 22 October 2026. Source reads completed at approximately 08:49 UTC (10:49 SAST).

**Verdict:** the end vision is coherent and substantially owned, but the current product is a local pilot plus a deliberately unavailable hosted production scaffold. Hosted alpha is not accepted or near-complete merely because the local 42-view inventory is available. The principal delivery risks are inconsistent dispatch instructions, a missing viewer prerequisite for the first workflow, and temporary pilot limitations not connected to release disposition.

## Scope and evidence

- Reviewed checkout: `audit/retrospective-2026-10-22`, exact HEAD **225b7e00578319d16383678a8d1ae6efb362a0ba**. All source line references below refer to this SHA unless marked incoming.
- Incoming only: `a3f80d1305294a8c685a87351281eef7928c7d9c` (`origin/wave/proofs-final`, [PR #114](https://github.com/GridShift-Software/clearcase/pull/114)); `99cf56bba6afc0bf30d0dc914816ad97d1a750ae` (`origin/wave/guard-followups`). Read with Git show/diff; no checkout changes. Neither changes the product brief, plan paths, or hosted route selector implicated below.
- Read repository AGENTS.md, glossary, issue-tracker rules, development guide, product brief, ADR index and hosted decisions, acceptance and delivery plans, view coverage, generated briefs, route inventory, current hosted runtime/route selection, local view registry, compatibility acceptance report, and user-approved parity dispositions.
- Live Linear **worked** through `linear_list_issues`, `linear_get_project`, `linear_get_issue` and `linear_list_comments`; the earlier failed `get_agent_context` does not imply tracker unavailability. Project UUID: `f473fd2d-c994-4dc6-84e2-b90a68848e48`. Two issue pages, **100 + 54**, requested with archived issues included; page 1 cursor `be596ca1-3a0e-4ef9-a39f-172d65b2bf2c`; final `hasNextPage:false`. Read all **154/154** issues individually with `includeRelations:true`. Selected comments for GRS-24/26/109/137/176/177 had no further page.
- GitHub connector search returned `InvalidActionArgumentsError: Invalid action arguments`; used the authorized read-only `gh pr list` fallback. Examined the 25 latest-created PRs, #97–#121, with states, heads, target branches and merge timestamps. This is a bounded recent-work sample, not an all-time PR census.
- No build, install, browser acceptance, gate, deployment, secret access, real case-material access, or external write was performed. Parent already ran doctor through Git Bash and received unsupported OS `msys`; I did not bypass that limitation or manufacture a receipt. Static JSON/code/graph inspection below is **not acceptance PASS**. No skills or additional agents were invoked.
- Historical PASS statements below are attributed to their original report/comment and SHA, not certified by this review. Tracker reads span several minutes and are not an atomic snapshot.

## End vision versus delivered behavior

The accepted alpha serves one or two initial clients through separately provisioned client instances, with explicit case access, preserved originals, complete published-file viewing, durable user work and bundles. Manual processing produces private candidates; validation and human sign-off bind an exact resultsVersion; publication and rollback preserve user work. Case existence and independent user work do not depend on published results. These commitments fit the three primary lawyer journeys: find/read/cite evidence, develop the case, and produce a usable bundle/export.

The plan makes defensible scope choices: preserve all 42 views and their navigation; keep live mailbox integration, processing automation and prompt optimization later; distinguish requested supplements from new submissions; exclude payment checkout; allow the preparer to sign off through a separately recorded action. ADR-0009/0010/0011 cover these boundaries concretely. There is no evidence here of unauthorized navigation redesign or automated publication being substituted for the agreed product.

Current code is honest about the implementation boundary:

- `src/lib/server/runtime/hosted/services.ts:8–16` constructs unavailable production services and returns `ready:false`; `hosted/handle.ts:34` refuses protected requests with 503.
- `deploy/client/routes/cases/[caseId]/+page.server.ts:20–27` explicitly distinguishes pending, withdrawn and unavailable results. It does not fabricate a published case.
- `src/lib/server/runtime/hosted/gate/services.ts:1–5,44–46` labels test identity/store/assets as doubles and leaves user work unavailable.
- `deploy/client/hosted-files.json:2` selects a separate hosted route tree. The local registry is not the hosted workspace.
- `src/lib/components/view-registry.ts:25` onward marks the 42 local entries available. That agrees with completed local owners; it does not mean hosted Notes, costs, viewing, publication or recovery are implemented.

These are **planned omissions**, owned by GRS-113–118, GRS-120–134 and the workflow owners. Reporting the unavailable production adapters as new defects would confuse incomplete planned work with a regression.

### Coverage and status denominators

The 42/42 view rows have both a local owner and a hosted owner. Hosted allocation: GRS-131 owns 16, GRS-132 owns 12, GRS-133 owns 10, GRS-119 owns 1, GRS-134 owns 2, GRS-118 owns 1. All six corresponding hosted tickets are Backlog. This is **100% ownership coverage, not implementation or acceptance coverage**.

The live project has **154 issues: 90 Done, 47 Backlog, 7 In Progress, 8 In Review, 2 Canceled**; 62 remain open. It is not meaningful to call the product 90/154 complete: planning, probes, infrastructure repairs, independent gates and product features differ greatly in scope.

| Live issue grouping | Total issues | Done | Open | Canceled |
| --- | ---: | ---: | ---: | ---: |
| M0 reference/package | 4 | 4 | 0 | 0 |
| M1 local pilot | 4 | 4 | 0 | 0 |
| M2 local parity | 12 | 12 | 0 | 0 |
| M3 compatibility | 8 | 7 | 1 | 0 |
| M4 design/realignment | 39 | 28 | 10 | 1 |
| M5 hosted delivery/acceptance | 34 | 2 | 32 | 0 |
| M6 later automation | 3 | 0 | 3 | 0 |
| M7 later integrations/authoring | 3 | 0 | 3 | 0 |
| No milestone | 47 | 33 | 13 | 1 |

These are issue counts derived from the 154 detail reads, not Linear's displayed progress formula. Linear displays M3 91%, M4 78%, M5 6%; its weighting was not established, so those percentages should not be treated as a feature acceptance measure. In M5, the two Done issues are GRS-112 and GRS-138: runtime/bootstrap and its gate, not client workflow completion.

The committed snapshot at `docs/plan/work-items.json:3591–3612` is explicitly dated 20 October and records 132 project issues, 59 open. There are 22 additional issues created after that capture. Its 77 mapped items have **5/77 status differences**, GRS-107–111 moving from Backlog to active/review states. Today **17/62 open issues** are outside the mapped item list, versus the recorded 14/59. External dependencies are intentionally supported by the plan: raw comparisons of `depends` alone would incorrectly label GRS-147 and other external owners missing. The full live blocker graph has **no detected directed cycle across 154 nodes**.

The 55 historical production routes remain a separate inventory from the 42 v5 views. `docs/reference/route-map.md:9–16` explicitly records 52 identified slugs, 3 unknown and an alternate 51/4 interpretation. Do not turn that uncertain audit count into a new 55-view commitment.

## Findings requiring coordinator action

Severity uses **medium/low** prose, avoiding confusion with the repository's unusual review-to-P-number mapping. These are planning/control findings; no immediate production incident was established.

### PD-1 — Medium: hosted dispatch reservations point at routes the hosted artifact does not build

**New planning inconsistency; high confidence.** Existing owners: GRS-27 for frozen reservations, GRS-113, GRS-120, GRS-137, and their downstream route owners.

Evidence at the pinned SHA:

- `vite.config.ts:24` uses `selected(...)` for hosted files; `scripts/ci/hosted-imports.ts:24–30` reads the route tree from `deploy/client/hosted-files.json:2`: **deploy/client/routes**.
- `docs/plan/tickets/HA-first-workflow.md:13,20` reserves **src/routes/v/[vid]/overview**, **src/routes/client/intake**, and **src/routes/admin/** for the first hosted workflow.
- `docs/plan/tickets/HA-viewer-core.md:16,51` reserves **src/routes/v/[vid]/doc/[ref]** and **src/routes/cases/[caseId]/files**.
- `docs/plan/tickets/HA-identity.md:14–16,47` reserves **src/routes/auth**, support, information handling and the root **src/routes/+page.server.ts**.
- Live GRS-137 and GRS-120 still contain those reservations. This is not merely an obsolete generated copy.
- `deploy/client/routes/[...path]/+server.ts:2–9` returns 503 for unmatched hosted routes.

**Trigger/impact:** a worker implements the authorized route paths literally after foundation sign-off. The local route tree changes, but the hosted artifact never acquires those endpoints. Hosted acceptance eventually catches it, after avoidable implementation/review work; workers may instead widen into shared configuration without an agreed handoff. Initial-reservation language mitigates this if dispatch always resolves exact paths, but does not reconcile the present contradiction.

**Smallest fix:** at GRS-27, decide the actual deployed route ownership and update the live owner scopes, generated briefs and handoff map together. Either reserve the existing hosted tree or explicitly own a reviewed route-sharing change. No navigation redesign is needed.

**Validation:** map each reserved hosted endpoint to a build-selected entry, then prove the first identity/intake/viewer route on workerd at the accepted implementation SHA. Static plan validation should flag hosted-only reservations wholly outside the selected tree. Neither named incoming branch fixes this mismatch.

### PD-2 — Medium: the first complete PDF workflow can become ready without its viewer

**New missing dependency; high confidence.** Existing owners: [GRS-137](https://linear.app/vaper/issue/GRS-137) and [GRS-120](https://linear.app/vaper/issue/GRS-120).

**Evidence:** live GRS-137 is blocked only by GRS-138, GRS-36 and GRS-69. Neither direct nor transitive prerequisites include GRS-120. GRS-120 is separately blocked by GRS-36/138/97/69. Yet `HA-first-workflow.md:18` requires the existing originals viewer while explicitly excluding ownership of the viewer shell; `HA-viewer-core.md:51–53` requires the core contract for this early workflow. Both are grouped in `wave/first-workflow` (`agent-delivery-operating-plan.md:79`), which does not itself impose an acceptance order.

The current hosted bootstrap is not that viewer: `hosted/gate/assets.ts:81–83,93` refuses the applicable range request with 416 and serves originals as attachment downloads; its documented gate checks downloading original bytes. ADR-0011 requires in-app viewing for published files.

**Trigger/impact:** GRS-36 finishes and the scheduler dispatches GRS-137 first. It can build intake/import stages but cannot complete its owned end-to-end acceptance without another unfinished owner. The human manual-processing handoff may be reached prematurely, or a worker may mistake a download for the required in-app viewing.

**Smallest fix:** add GRS-120 as a blocker for GRS-137's integrated acceptance, with explicit permission for independent upstream stages to proceed if desired. If the tracker cannot express staged readiness, use the native blocker and dispatch viewer first. Keep the already agreed PDF-only scope.

**Validation:** read the updated live graph; with viewer incomplete, GRS-137 must not be accepted or scheduled as fully ready. At the shared exact head, the client must view the PDF and follow a verified citation inside the hosted app, without a required download.

### PD-3 — Medium: temporary pilot exceptions are not connected to hosted release disposition

**Tracked work with a newly identified graph omission; high confidence.** Reuse [GRS-177](https://linear.app/vaper/issue/GRS-177), with GRS-176/66/32 and the existing view owners.

**Evidence:** `docs/reference/parity/approvals/2026-10-21-user-review.md:9,19` accepts 30 listed limitations temporarily for the local pilot while retaining hosted durable-bundle, citation and viewing requirements. Live GRS-177 explicitly says to group them into implementation tickets by view owner **before hosted alpha**, or record why a limitation remains. It is Backlog, has no assignee or milestone, **no blocks/blockedBy relations**, and only relates to GRS-163. It is absent from GRS-32's transitive prerequisite set. GRS-176's 13 pending technical coverage reviews likewise have no blocker path; GRS-176 is already In Progress, so do not duplicate that review.

**Trigger/impact:** all currently connected release ancestors close while the 30-item disposition exercise remains Backlog. Generic ADR acceptance should catch major missing functions, but the delivery graph can still advertise readiness without proving that every temporary exception was fixed or explicitly carried. Session-only PDFs and unchecked page bounds are particularly relevant to the agreed bundle/citation journeys.

**Smallest fix:** have GRS-177 record a 30-row mapping to existing owners and explicit deferrals, then make the relevant acceptance gate depend on this disposition. Link required resulting work to the existing feature/release gates. Include GRS-176's output in that reconciliation. Do **not** assume all 30 must be implemented: the user's approved option permits reasoned retained limitations.

**Validation:** every listed IDR has an owner/disposition and an acceptance destination; every required fix is in GRS-32's dependency closure or explicitly checked by its gate. No new umbrella ticket is necessary.

### PD-4 — Low: the product entry point and operating guidance contradict current approval and ownership

**Recurring documentation defect; high confidence.** Reuse the coordinator's GRS-69/94 plan-maintenance responsibility; GRS-180 is a related map-maintenance unit, but its current narrower scope should not be silently expanded.

**Evidence:** `docs/product-brief.md:7` says GRS-69 approval remains open, every hosted issue is blocked by it, and all implementation/runtime proofs are UNRUN. Live GRS-69 is Done; `docs/plan/hosted-alpha-acceptance.md:9` and `agent-delivery-operating-plan.md:3` record the 17 October approval. GRS-106/112/138 are Done and the bootstrap is in code. `verification-and-review.md:111` says observability has no owner, although live GRS-147 already owns it and directly blocks GRS-32. The same document's `:40` says dev requires the human reviewer's approval, while `:86` and AGENTS.md correctly give that merge gate to Greptile/CI with no unresolved findings.

**Trigger/impact:** a fresh worker reads the mandated product brief first, infers an already granted authorization is missing, or proposes a duplicate observability ticket. Mixed present and historical text also makes progress reports less trustworthy.

**Smallest fix:** preserve historical ADR decisions, but put one current, dated state pointer at the start of the product brief and clearly mark superseded operating paragraphs. Separate plan approval, local proof, provider proof and alpha acceptance. This is a documentation correction, not a reason to reopen approval.

**Validation:** reconcile against a fresh Linear capture and accepted Git heads; search active guidance for stale approval/no-owner assertions. None of the two named incoming branches changes these paragraphs.

## Critical path and legitimate holds

The live dependency chain supports the intended sequencing:

1. **GRS-24 compatibility contract decision.** Its latest comment, `d22eca0f-5a3a-4ccc-8cdb-eaf9711f3124` (21 October, 14:48 UTC), reports items 1–5 passing at **e44e12b397561e7d7ad229e8fad00753db9f00bc**, with item 6 awaiting the user's contract approval. This is a concrete decision waiting on the user, not evidence that engineering has been idle.
2. **GRS-26 integrates the six architecture proofs**, also depending on GRS-24. GRS-106 is Done; GRS-107/108/110/111 are In Review and GRS-109 In Progress. Proof code and evidence are incoming in PR #114, not yet on pinned dev.
3. **Provider legs and GRS-27 design checkpoint** remain mandatory. GRS-26's 20 October comment `b351a2ac-e1e3-452c-a9bf-970336ca76f1` permits local/Clerk-development work but keeps Cloudflare pinned; comment `83bd39b4-69c4-4f45-a0b0-691fd70ae9ab` assigns HectoLogic the Cloudflare handoff and provisioning decisions. This reviewer did not act on that delegation. The parent should use those current decisions rather than the older blanket statement that all credentialed proof is UNRUN.
4. **GRS-113–118 foundation** follows GRS-27: identity precedes provisioning; identity/storage precede audit; storage precedes user work; user work/storage precede recovery. GRS-36 aggregates the foundation.
5. **GRS-120 plus GRS-137** must produce the first complete PDF workflow, with PD-2 resolved. The actual manual recipe is a named human gate, `AWAITING MANUAL RESULTS`; schedule the operator handoff and resume at the same SHA.
6. **Widening, GRS-66 and GRS-32** complete all views/formats/integrations and independent real-provider release acceptance. GRS-147 operational signals already blocks release. Later GRS-23/63/99/33/34 are not alpha blockers.

No defensible finish date can be inferred: live project/milestones have no target dates, provider work is intentionally pinned, user decision times are not committed, and manual processing duration has not been measured here. Backlog is not synonymous with forgotten work; the team has no Blocked status.

### Compatibility acceptance needs an explicit evidence boundary

GRS-24's remaining approval must not be presented as “all newer/JSON user paths proved.” `docs/acceptance/CC-25/report.md:39,59,87–98` explicitly says those generations were server-rendered in a Vite dev server, with no original opened in their originals viewer and no production-browser latency comparison to v5 budgets. The live comment repeats that HOLD and calls it nonblocking for contract approval. This is an **existing disclosed acceptance limit**, not a newly discovered converter defect.

Keep GRS-24's contract decision separate from final hosted user-path acceptance. Ensure GRS-32 owns the remaining supported-generation browser/original/citation/performance checks; its existing acceptance already requires supported v5/newer/JSON workflows. Scope residual analysis roots through GRS-24's actual approval text rather than calling privately retained data complete presentation.

## Recent work, incoming work and scope churn

The sample of PRs and live issue comments show a repair-and-proof phase with meaningful product improvements:

- [PR #118](https://github.com/GridShift-Software/clearcase/pull/118), merged into dev at the pinned SHA, implements GRS-172/173/174/175: CSV formula protection, coherent interest-basis comparisons, calendar-timezone deadlines and destructive-action confirmation. Do not re-report their old defects as unfixed. GRS-181 already owns the carried low follow-ups.
- [PR #109](https://github.com/GridShift-Software/clearcase/pull/109) merged GRS-170/171 source-field collision repairs and GRS-160 Court Bundle failed-reload recovery. GRS-178 already owns the analogous remaining page families.
- [PR #100](https://github.com/GridShift-Software/clearcase/pull/100) records the user's register dispositions; it is scope governance, not a runtime proof.
- [PR #114](https://github.com/GridShift-Software/clearcase/pull/114) is OPEN at the named incoming SHA. [PR #119](https://github.com/GridShift-Software/clearcase/pull/119) is merged **into that wave**, addressing storage snapshot consistency, interrupted erasure and deployment assertions. These fixes are not in pinned dev. Incoming `docs/acceptance/hosting/identity.md:3–5` reports local and real Clerk-development proof at `a0b458af`, while retaining other HOLDs and explicitly saying it is not production integration. I did not independently validate its evidence binding.
- GRS-156/161/169 work is merged into **wave/guard-followups**, not dev. Latest sampled PR #120 adds GRS-161 polish to that wave. GRS-179 is an existing residual guard follow-up; neither “all guard defects fixed” nor “none of the fixes exist” is accurate.
- [PR #121](https://github.com/GridShift-Software/clearcase/pull/121) is an open GRS-180 documentation unit targeting wave/app-followups. It should not be counted as delivered at pinned dev.

The 8–17 October evolution expands a local parity POC into a complete hosted case lifecycle, adding private editing, Notes, accepted-format viewing, KYC, costs, privilege and durable bundles. That is **recorded user-approved realignment**, not evidence of arbitrary agent scope growth. The current risk is carrying old local route reservations and pilot exceptions across that transition without reconciling them.

## Effort efficiency and ownership

No productivity or spending conclusion is derived from raw commit counts, issue throughput, PR volume or model choice. I did not obtain a complete runtime/spend ledger, queue durations, paid versus blocked time, or all review-round receipts. The historical dollar estimates and median review waits in the operating documents are dated observations, not current measurements.

Evidence does support three practical efficiency improvements:

1. **Close decisions that unlock the product path.** Present the already concrete GRS-24 contract decision with its current SHA and limits, and the GRS-26 provider handoff at the authorized boundary. Avoid repeated generic planning approvals. Reconcile PD-1/PD-2 before starting route work.
2. **Preserve the first workflow as the next product learning milestone.** Its accepted design correctly tests manual output, private editing and publication before broad migration. Use the necessary foundation contracts, but avoid treating additional polish/probe volume as a substitute for this complete user journey.
3. **Optimize verification only from measured ownership.** GRS-165 explicitly targets a measured 51.593-second fixture file inside a 62-second CI step; GRS-166 maps layout-test ownership; GRS-167 profiles hosted preparation. These existing units are more defensible than indiscriminate test removal. Report before/after wall time at named SHAs, suite coverage, and queue time separately.

Of 154 live issues, 29 have an assignee and 47 have no milestone; these counts alone do not prove missing ownership. The plan intentionally assigns execution through ticket scopes and the coordinator. The material omission is GRS-177's missing release disposition path, not every unassigned Backlog feature. Observability, synthetic corpus generation, compatibility, first workflow, rollback, full-format viewing and release each already have named owners. Use their IDs instead of creating duplicate “missing” tickets.

Suggested ongoing report denominators: accepted product journeys out of the three agreed journeys; independently accepted view behaviors out of 42; accepted format families out of the frozen GRS-97 matrix; local/provider proof legs with separate totals; and open findings by severity, owner and exact revision. State capture time and show decision/provider wait separately from active engineering time.

## Priority handoff

1. **Before foundation/first-workflow dispatch:** reconcile actual hosted route paths under GRS-27; add GRS-120 readiness to GRS-137.
2. **On the existing critical path:** resolve GRS-24's concrete contract decision and complete GRS-26's integration/provider handoff within current authorization. Keep PR #114 incoming until merged and independently accepted at its head.
3. **Before hosted alpha readiness:** use GRS-177 to map all temporary exceptions and GRS-176 to settle pending coverage; connect required outcomes to GRS-66/32.
4. **At the next coordinator documentation fold:** repair product-brief approval status and contradictory review/observability text without rewriting historical decisions.
5. **Retain the explicit limits:** no hosted release acceptance from a test-double gate, no production-browser compatibility claim from server rendering, no performance/productivity claim from ticket percentages.

Only this Markdown report was authored. Parent owns synthesis, changes, tracker updates and any further execution.
