# Hosted alpha agent delivery plan — proposal

Planning reference: `b93bad097fdd7b3c076d68025267c36395fc9921`.
Updated 16 October 2026. This is a proposal under [Define the Fable and swarm delivery operating plan](https://linear.app/vaper/issue/GRS-94/define-the-fable-and-swarm-delivery-operating-plan). The [overall planning gate](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha) remains open.

## Model roles

The user explicitly wants Claude Fable and GPT Astra as rare escalators. Fable is a model, not a separate product to install. The live T3 catalog lists both targets below and allows their provider instances to run child tasks. Catalog presence does not prove a completed dispatch or establish comparative cost/performance.

| Role | Proposed target | Source and treatment |
| --- | --- | --- |
| Feature implementation and normal swarm workers | `claudeAgent/claude-opus-5-5`, `effort=xhigh` | The user-selected large/xhigh preset supersedes the earlier high-effort default. Keep routine work in this lane. |
| Independent diff review and fix recheck | `claudeAgent/claude-opus-5-5`, `effort=xhigh` | Fresh reviewer session at the declared revision; retain the existing one-reviewer process. |
| Routine corrections from written findings | `claudeAgent/claude-sonnet-5-5`, `effort=xhigh` | Written-finding fixes retain Sonnet, using the selected xhigh preset; one bounded fix round. |
| Rare escalation | One of `claudeAgent/claude-fable-5-1`, `effort=xhigh`, or `codex/gpt-6-astra`, `reasoningEffort=xhigh` | Rare use is user-approved. The particular trigger, model selection and bounded scope are recorded before launch. Do not automatically fan out both. Proposed reasoning level follows the existing escalation preference. |
| Deterministic checks and measurements | Scripts and the real test harness | No model call is needed merely to run a check. Preserve receipts. |

Accepted escalation rule: first use the normal build/review/written-fix/recheck process. Escalate a remaining substantive blocker or a clearly documented technical impasse with the exact failure, attempted fixes, evidence and a bounded question. Before dispatch, create a linked Linear escalation issue recording the source issue, exact SHA, reproduction, prior attempts, evidence, bounded question, selected model/effort, spend target and completion predicate. Choose one escalator and add its T3 task ID to that issue. After the attempt, update the same issue with findings, outcome, resulting SHA and checks. Keep the source blocked if unresolved; after one bounded escalation, return the unresolved blocker or design decision to the user. Do not create an escalation issue or dispatch a model when no blocker exists. Missing access, unavailable infrastructure and simple editorial corrections do not by themselves justify an expensive escalation.

The user permits Astra in this rare role despite the older blanket workspace ban on Codex. This is a scoped exception; it does not enable all Codex roles or recurring model panels. Keep the existing restriction on `max` and unrequested modes.

## Pstack configuration handoff

- The canonical plugin is t3-pstack `2.0.0-rc.6`. Do not reinstall its upstream skill mirror.
- The canonical machine model sheet is currently absent. The Codex and Claude legacy sheets match and contain Fable defaults for all bug-fix/performance/hillclimb work, plus the retired `strongest judgment` role.
- That broad Fable routing conflicts with rare escalation. The proposed sheet routes routine bug/performance work to Opus and renames `strongest judgment` to `hardest tasks`.
- The sheet has one `hardest tasks` target. Keep a single default there; the coordinator selects the other approved escalator through an explicit per-task T3 target when appropriate. Do not invent unsupported role keys or a scalar role containing a list.
- Before writing a sheet, review every role and the reasoning budget, validate all entries against a fresh T3 catalog, and account for machine-wide effects on other projects. Preserve unrelated global settings deliberately.
- Existing panel rows are not authority to run panels in this project. Swarm permission covers the agreed bounded workload shape, not automatic races or critic panels.
- The user selected `large - xhigh reasoning` and session hook on (decision comment `68ef42c3-ac86-4a1c-b7f6-ef908922859e`). The complete candidate validates against the live catalog; full role-sheet confirmation remains before the machine-wide write. No model sheet, session hook or live agent configuration has changed during this planning stage.

## Proposed work loop and controls

1. Pick a native Linear issue whose blockers are accepted. Pin its actual upstream base, scope, reserved paths, acceptance and test recipe. The coordinator writes the brief; workers do not draft briefs for other workers.
2. Use one branch and worktree per writing ticket. For T3 children, request `isolation: worktree`; check the actual checkout/base before any writes. Stay in that checkout. Do not use a prompt's `cd` instruction to substitute for T3 workspace binding.
3. Build once, run the appropriate deterministic checks, then obtain one fresh independent diff review. App changes retain the required gate until its hosted replacement is reviewed. Documentation and source research receive proportionate checks rather than an irrelevant app gate.
4. Apply one bounded written-finding fix round on Sonnet and obtain a fresh recheck of that fix diff. Use the rare escalation lane only for a justified remaining blocker. Record low findings as follow-ups rather than widening every review.
5. Preserve tests and acceptance boundaries. A required check that is skipped, mocked at its boundary, weakened, or run at a different revision is not a pass. An author cannot independently approve their own final acceptance suite/verdict.
6. Leak-scan and push only the reviewed revision, open/link the PR, and retain the existing external-review requirement before merging into `dev`. Use merge commits, accepted upstream heads and serial integration; never rebase, force-push or merge `main`.
7. After an upstream change, merge it into dependent branches and rerun affected checks. Integrate one ready layer at a time and record exact revision/evidence handoffs. A worktree isolates files; it is not a security boundary.

Accepted initial limits: at most three worker jobs in total and two browser jobs, preserving current limits until measurement justifies more. Use PC2 as the first isolated test pool and preserve PC1's current CI role. KVM access and spare RAM are capacity inputs, not VM boot, isolation or concurrency proofs. Provisioning, allocations and job cleanup/reset behavior need their own bounded work.

Shared agent/test pools use synthetic data and have no production/account tokens. Keep trusted deployment credentials outside those pools and outside app builds. Use reviewed target manifests/configuration for credentialed steps; the cf/Void research proofs still apply. A local pass does not substitute for real hosted isolation, storage, provider or recovery acceptance.

Existing USD targets are build 20, review 6, written fix 8, recheck 2 and escalation 12. The user chose reporting only: exceeding a target does not automatically pause, cancel or escalate work. Report actual/unknown spend and variance. These are not a T3-enforced cap; the older headless runner can enforce some spend limits, but the T3 task API does not. Bound repeated attempts and excessive runtime independently of spending using the accepted controls below. A delegate_task wait timeout is not a child runtime limit; explicit task cancellation or a proven runner deadline is required. Keep briefs to one page, reports under 40 lines and one fresh session per stage.

## Accepted retry and runtime controls

- Keep one written-review fix round plus fresh recheck and at most one justified rare escalation. Allow one transient infrastructure retry; stop when the same failure repeats twice without a new diagnosis.
- Count attempts against the original issue/stage. Restarting, renaming or redispatching a task does not reset its budget of attempts or silently create another repair round.
- Default writing-task runtime is 90 minutes; review runtime is 30 minutes. Assess a stall after 30 minutes without meaningful progress. Declare legitimate bounded long tests and justified per-task deadlines in the brief before dispatch; a quiet agent alone is not evidence of a stall.
- Give a short checkpoint grace period, then explicitly cancel an overlong/stalled job. Retain its branch/diff, completed checks, failure evidence and cancellation result; clean up only that job's processes/resources. Do not mark interrupted verification as PASS or automatically respawn the same failing job.
- These are agent-run limits, not application restrictions. The tooling/test-pool owners must prove deadline/cancellation failure paths; this planning record does not install a watchdog. A T3 wait timeout alone is not runtime enforcement.

## Concrete delivery owners

Thirty-two concrete Backlog issues have been created from the live graph. They carry bounded scope, acceptance, evidence recipes and native prerequisites. All hosted work remains behind the overall planning gate; no implementation is dispatched. Exact paths and accepted upstream SHA are pinned again at pickup.

| Delivery owner | Initial scope |
| --- | --- |
| [Align agent tooling with the canonical pstack plugin and delivery controls](https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery) | scripts/agent-tools/**; tests/agent-tools/** |
| [Prove a disposable synthetic test pool on PC2 while preserving PC1 CI](https://linear.app/vaper/issue/GRS-105/prove-a-disposable-synthetic-test-pool-on-pc2-while-preserving-pc1-ci) | deploy/test-pool/**; scripts/test-pool/** |
| [Prove SvelteKit 3 and Bun builds on the Cloudflare Workers runtime](https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime) | tests/hosting-probe/runtime/**; docs/acceptance/hosting/runtime.md |
| [Prove cf and Void deployment, migration and credential boundaries](https://linear.app/vaper/issue/GRS-107/prove-cf-and-void-deployment-migration-and-credential-boundaries) | tests/hosting-probe/deployment/**; deploy/probes/** |
| [Prove Clerk sessions and explicit case authorization on Workers](https://linear.app/vaper/issue/GRS-108/prove-clerk-sessions-and-explicit-case-authorization-on-workers) | tests/hosting-probe/identity/**; docs/acceptance/hosting/identity.md |
| [Prove D1 and R2 integrity, layout and POC workload performance](https://linear.app/vaper/issue/GRS-109/prove-d1-and-r2-integrity-layout-and-poc-workload-performance) | tests/hosting-probe/storage/**; docs/acceptance/hosting/storage.md |
| [Prove recovery, deletion and retention contracts for hosted alpha](https://linear.app/vaper/issue/GRS-110/prove-recovery-deletion-and-retention-contracts-for-hosted-alpha) | tests/hosting-probe/recovery/**; docs/acceptance/hosting/recovery.md |
| [Prove minimal Cloudflare transactional notifications for alpha](https://linear.app/vaper/issue/GRS-111/prove-minimal-cloudflare-transactional-notifications-for-alpha) | tests/hosting-probe/notifications/**; docs/acceptance/hosting/notifications.md |
| [Migrate the app build and shared server entry points to Workers](https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers) | package.json; bun.lock |
| [Implement Clerk invitations, sessions and hosted access checks](https://linear.app/vaper/issue/GRS-113/implement-clerk-invitations-sessions-and-hosted-access-checks) | src/lib/auth/**; src/routes/auth/** |
| [Provision isolated client instances, cases and explicit grants](https://linear.app/vaper/issue/GRS-114/provision-isolated-client-instances-cases-and-explicit-grants) | src/lib/tenancy/**; src/routes/admin/clients/** |
| [Implement hosted D1 results storage and protected R2 assets](https://linear.app/vaper/issue/GRS-115/implement-hosted-d1-results-storage-and-protected-r2-assets) | src/lib/storage/cloud/**; src/lib/results/hosted/** |
| [Implement permission-scoped audit events and audit views](https://linear.app/vaper/issue/GRS-116/implement-permission-scoped-audit-events-and-audit-views) | src/lib/audit/**; src/routes/admin/audit/** |
| [Persist hosted case user work with stable identities and conflict handling](https://linear.app/vaper/issue/GRS-117/persist-hosted-case-user-work-with-stable-identities-and-conflict) | src/lib/user-work/hosted/**; src/lib/local-case/user-work.server.ts |
| [Implement complete case export, backup recovery and approved deletion](https://linear.app/vaper/issue/GRS-118/implement-complete-case-export-backup-recovery-and-approved-deletion) | src/lib/recovery/hosted/**; src/lib/exports/case/** |
| [Unify document notes and annotations into contextual case Notes](https://linear.app/vaper/issue/GRS-119/unify-document-notes-and-annotations-into-contextual-case-notes) | src/lib/notes/**; src/routes/v/[vid]/registers/annotations_tab/** |
| [Implement the protected in-app viewer shell and PDF/image readers](https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers) | src/lib/viewers/core/**; src/lib/viewers/pdf/** |
| [Implement faithful Word and Excel viewing and prepared renditions](https://linear.app/vaper/issue/GRS-121/implement-faithful-word-and-excel-viewing-and-prepared-renditions) | src/lib/viewers/office/**; tests/viewers/office/** |
| [Implement Outlook and Gmail email-file and attachment viewing](https://linear.app/vaper/issue/GRS-122/implement-outlook-and-gmail-email-file-and-attachment-viewing) | src/lib/viewers/email/**; tests/viewers/email/** |
| [Implement accepted media and archive-contained viewing paths](https://linear.app/vaper/issue/GRS-123/implement-accepted-media-and-archive-contained-viewing-paths) | src/lib/viewers/media/**; src/lib/viewers/archive/** |
| [Implement represented-client KYC review and separate compliance access](https://linear.app/vaper/issue/GRS-124/implement-represented-client-kyc-review-and-separate-compliance-access) | src/lib/kyc/**; src/routes/admin/represented-clients/** |
| [Carry case costs, timesheets and disbursements into the hosted app](https://linear.app/vaper/issue/GRS-125/carry-case-costs-timesheets-and-disbursements-into-the-hosted-app) | src/lib/case-costs/**; src/routes/v/[vid]/costs/** |
| [Implement app-side email drafts and firm-managed templates](https://linear.app/vaper/issue/GRS-126/implement-app-side-email-drafts-and-firm-managed-templates) | src/lib/email-drafts/**; src/routes/v/[vid]/email-draft/** |
| [Require explicit privilege confirmation and disclosure scope review](https://linear.app/vaper/issue/GRS-127/require-explicit-privilege-confirmation-and-disclosure-scope-review) | src/lib/privilege/**; src/routes/v/[vid]/privilege-suggestions/** |
| [Persist PDF bundles with pinned inputs and protected version history](https://linear.app/vaper/issue/GRS-128/persist-pdf-bundles-with-pinned-inputs-and-protected-version-history) | src/lib/bundle-assets/**; src/routes/v/[vid]/bundles/** |
| [Notify uploaders of publication and required input without blocking access](https://linear.app/vaper/issue/GRS-129/notify-uploaders-of-publication-and-required-input-without-blocking) | src/lib/client-notifications/**; src/routes/client/notifications/** |
| [Edit and revalidate private results before exact-version approval](https://linear.app/vaper/issue/GRS-130/edit-and-revalidate-private-results-before-exact-version-approval) | src/lib/results-review/editor/**; src/routes/admin/results/[candidateId]/edit/** |
| [Migrate overview, chronology, evidence and analysis views to hosted contracts](https://linear.app/vaper/issue/GRS-131/migrate-overview-chronology-evidence-and-analysis-views-to-hosted) | src/routes/v/[vid]/overview/**; src/routes/v/[vid]/chronology/** |
| [Migrate quantum and case registers to hosted contracts](https://linear.app/vaper/issue/GRS-132/migrate-quantum-and-case-registers-to-hosted-contracts) | src/routes/v/[vid]/quantum/**; src/routes/v/[vid]/registers/** except annotations_tab |
| [Migrate litigation and existing bundle workspaces to hosted contracts](https://linear.app/vaper/issue/GRS-133/migrate-litigation-and-existing-bundle-workspaces-to-hosted-contracts) | src/routes/v/[vid]/litigation/**; src/routes/v/[vid]/bundles/** |
| [Adapt system help and Rescan & Update for hosted processing](https://linear.app/vaper/issue/GRS-134/adapt-system-help-and-rescan-and-update-for-hosted-processing) | src/routes/v/[vid]/system/rescan_tab/**; src/routes/v/[vid]/system/manual/** |
| [Implement the internal FIFO processing queue and audited operator claims](https://linear.app/vaper/issue/GRS-135/implement-the-internal-fifo-processing-queue-and-audited-operator) | src/lib/processing-queue/**; src/routes/admin/queue/** |

The production-integration aggregate now remains open until its alpha delivery owners and integrated route coverage are accepted; later mailbox scope is tracked separately. Native dependencies and serial path handoffs are recorded on the tickets. Check the live DAG before dispatch; parent aggregates must depend on their children without a reverse child dependency on that parent. Reconcile the JSON plan/view coverage, product brief, route map, operating docs and ADR drafts against the same live issue graph before requesting overall plan approval.

## Decisions and consolidation still open

- Bounded escalation and initial worker/test-pool roles are accepted (Linear decision comment `410c1a45-c3d6-4359-acb4-bc5281a69201`). Spend reporting-only and the shared Rescan & Update flow are accepted in decision comment `045279af-b2f6-4867-b17f-c9017593cae3`; Retry/runtime limits are now accepted: writing 90 minutes, review 30 minutes, stall assessment at 30 minutes, with bounded retry counts. Prove cancellation/checkpoint behavior before unattended execution.
- Live readback covered all 60 open project issues: no dependency cycles, all 32 new hosted issues are blocked by the planning gate. The JSON work-item/ticket snapshot and all 42 hosted-view owners are synchronized; product brief, route map and accepted ADR/glossary drafts still need consolidation. Four caller groups cover 16 evidence/analysis, 12 quantum/register, 10 litigation/bundle and two system views; Notes and backup/export each have a dedicated owner.
- Reconcile the obsolete workspace bans/runtime instructions with the accepted hosted stack, controlled swarm request and rare Fable/Astra roles. Prepare the exact changes before updating active instructions.
- Consolidate accepted ADR/glossary drafts and the alpha acceptance baseline, publish the navigation map/documents, then obtain approval of the full written plan. Pstack setup follows the reviewed role sheet; hosted implementation remains gated.


The source-only ownership check at the planning reference found 46 shared `app()` callers, synchronous results APIs, local filesystem import/rescan and absolute-path backup restore assumptions. Hosted storage owns the async seam before caller fan-out. Recovery must reject forged server paths and unscoped table restore/export; this is not a claim about current production. The check did not execute hosted workflows. Hosted Rescan & Update now uses the same upload/queue/private-review/publication flow for editor additions/replacements; current publication and user work stay intact. Spend is reporting only. Retry/runtime limits are now settled; pstack reasoning-preset/full-sheet choices and final document consolidation remain. Spend-triggered pauses are not part of the policy.

## Proposed complete pstack role sheet

Routine bug/performance/hillclimb work moves from Fable to Opus. Rename `strongest judgment` to `hardest tasks`; its default is Fable, used only after the escalation issue exists. Astra xhigh is the explicit alternative per task. Sonnet xhigh written-finding fixes use explicit coordinator launches because the sheet has no dedicated written-fix role. Existing panel targets are retained for other workflows; ClearCase panels remain unauthorized. No other retired or invalid rows were found.

```text
# pstack model configuration (T3). One line per role.
# budget: large (xhigh)
# ClearCase permits bounded partitioned swarm work; panel rows below do not authorize panels here.
feature, refactoring: claudeAgent/claude-opus-5-5 effort=xhigh
bug-fix: claudeAgent/claude-opus-5-5 effort=xhigh
perf-issue: claudeAgent/claude-opus-5-5 effort=xhigh
hillclimb: claudeAgent/claude-opus-5-5 effort=xhigh
judgment and prose: claudeAgent/claude-opus-5-5 effort=xhigh
hardest tasks: claudeAgent/claude-fable-5-1 effort=xhigh
how explorer: claudeAgent/claude-opus-5-5 effort=xhigh
how explainer: claudeAgent/claude-opus-5-5 effort=xhigh
why investigators: claudeAgent/claude-opus-5-5 effort=xhigh
why synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
reflect tooling: claudeAgent/claude-opus-5-5 effort=xhigh
reflect judgment, divergent, synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
arena runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh
arena cross-judge pool: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh
swarm workers: claudeAgent/claude-opus-5-5 effort=xhigh
architect runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh
interrogate reviewers: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh
session hook: on
```
