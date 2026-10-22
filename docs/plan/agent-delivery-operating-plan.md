# Hosted alpha agent delivery plan

Updated 17 October 2026; policy and state reconciled 20 October 2026 (GRS-159), provider guidance corrected 22 October. The user approved this plan on 17 October 2026 at 14:20 SAST (GRS-69 comment `45db4bdd-c268-4f6b-8658-cc2edb77bc6a`). GRS-69 and [GRS-94](https://linear.app/vaper/issue/GRS-94/define-the-fable-and-swarm-delivery-operating-plan) are Done in Linear. Approval is not runtime acceptance. The hosted synthetic gate (GRS-138) is Done. The earlier blanket UNRUN statement described the planning state; incoming proof records now include local and real Clerk-development results, with separate production/cloud HOLDs. They do not establish product-level hosted acceptance. Use [current provider dispositions](verification-and-review.md#4a-cloudflare-pin-and-proof-dispositions) and subsequent live GRS-26 decisions.

The workspace `AGENTS.md` and `ORCHESTRATOR.md` are the operative rules. The sections up to "Snapshot of the earlier proposal" are current and agree with them. The snapshot at the end is archived history. [Verification and review](verification-and-review.md) holds the verification model, and [handover](handover.md) indexes the lot for an external reviewer.

## Dated state and current provider disposition

- Historical gate state captured on 20 October: the dev gate was FAIL at `c89d405` at strict parity (17 October); GRS-141, GRS-143 and GRS-142 were Done. The last recorded dev-gate PASS in that capture was at `442adb93` (19 October). `dev` was at `b22680f5`, the merge of the hosted-bootstrap wave PR #75, and that gate run recorded no verdict. The capture said the delivery-controls wave (GRS-157) was not on `dev`. Read the current head and its evidence before dispatch; this history is not today's gate verdict.
- Cloudflare account/domain work remains pinned. Follow [section 4a of verification and review](verification-and-review.md#4a-cloudflare-pin-and-proof-dispositions) and subsequent live GRS-26 decisions for the authorized local/Clerk-development exception, the named provisioning decision owner and the approved secret path. Cloud and release legs stay HOLD while pinned; a mock PASS never replaces them. The USD 25 monthly ceiling, USD 10 alert and GRS-105 (PC2) no-go remain.
- GRS-24 no longer gates the proof tickets GRS-106 to GRS-111. It still gates GRS-26 and so the design gate GRS-27.

## Models and effort

Set model and effort explicitly on every launch, including subagents. Nothing inherits the orchestrator's settings. Never effort `max`.

| Role | Model | Effort | Target USD |
| --- | --- | --- | --- |
| Orchestrator (T3 thread) | `claude-opus-5-5` | high | none |
| First implementation of a ticket | `claude-opus-5-5` | xhigh | 20 |
| Diff review | `claude-opus-5-5` | xhigh | 6 |
| Recheck of a fix round's diff | `claude-opus-5-5` | high | 2 |
| Fix round from a written defect list; merges; PR and Linear text | `claude-sonnet-5-5` | high | 8 |
| A high that survived the fix round | `claude-opus-5-5` with `diagnosing-bugs` | xhigh | 12 |
| Rare escalation, only with a linked Linear escalation issue | `claude-fable-5-1`, or `gpt-6-astra` by explicit per-task choice | xhigh | 12 |
| Research and decision sessions with the user | `claude-opus-5-5` | high | 6 |
| Running checks, reading logs | a script | none | 0 |

Targets are reporting only. Overspend never pauses or cancels work by itself. Attempts are bounded instead: one fix round, one recheck, one escalation and one transient infrastructure retry. The same failure twice without a new diagnosis stops the unit. The T3 task API has no spend cap, and the prepared headless resume scripts carry `--max-budget-usd` caps from the M2 run that are not policy.

Not used: the `swarm`, `arena`, `interrogate` and `reflect` skills, verification lanes, adversarial swarms, critic panels, brief drafters and the Workflow tool. At most three workers and two browser jobs at once is capacity, not permission to fan out. A model or harness the user chooses for a session or task, Codex included, takes precedence for that session or task (workspace `AGENTS.md`, 20 October 2026). Otherwise Codex runs only as `gpt-6-astra`, the recorded rare escalator.

### The one current pstack sheet

The sheet written on 17 October at `~/.config/t3-pstack/models.md` is the one current sheet. `.orchestration/pstack-models.md` is its copy in the coordination folder (ignored by Git) and is quoted under "Pstack sheet as written" below. It sets budget large (xhigh) and session hook on. Its panel rows (arena, architect, interrogate, reflect, swarm) serve other projects and are not authority to run panels here. Launch settings in the table above override any sheet row. Any earlier candidate sheet, including the block in the archived snapshot, is superseded.

### Escalation rule

Accepted escalation rule: first use the normal build/review/written-fix/recheck process. Escalate a remaining substantive blocker or a clearly documented technical impasse with the exact failure, attempted fixes, evidence and a bounded question. Before dispatch, create a linked Linear escalation issue recording the source issue, exact SHA, reproduction, prior attempts, evidence, bounded question, selected model/effort, spend target and completion predicate. Choose one escalator and add its T3 task ID to that issue. After the attempt, update the same issue with findings, outcome, resulting SHA and checks. Keep the source blocked if unresolved; after one bounded escalation, return the unresolved blocker or design decision to the user. Do not create an escalation issue or dispatch a model when no blocker exists. Missing access, unavailable infrastructure and simple editorial corrections do not by themselves justify an expensive escalation.

The user permits Astra in this rare role despite the older blanket workspace ban on Codex. This is a scoped exception; it does not enable all Codex roles or recurring model panels. A harness the user names for a session or task takes precedence for that task only (workspace `AGENTS.md`, 20 October 2026). Keep the existing restriction on `max` and unrequested modes.

## Work loop and controls

1. Pick a native Linear issue whose blockers are accepted. The coordinator pins its upstream base, scope, reserved paths, acceptance and test recipe in a one-page brief; workers do not draft briefs for other workers.
2. Use one `feature/<linear-id>-<slug>` branch and worktree per writing ticket, cut from the wave branch its brief names. A dependent ticket's branch may be cut from its upstream ticket's branch for ancestry, but its PR still targets the wave branch. For T3 children, request `isolation: worktree` and check the actual checkout and base before any writes.
3. Build once, run the checks scaled to the change, then obtain one fresh internal diff review. App changes run `bun run --bun gate`; a hosted ticket also runs `gate:hosted` once it exists; documentation and research get `check` and `test` plus `check-plan`.
4. Apply one bounded written-finding fix round on Sonnet and obtain a fresh recheck of that fix diff. Highs and mediums are fixed; lows become a Linear follow-up. A high that survives gets one Opus xhigh round with `diagnosing-bugs`. Use the rare escalator only for a justified remaining blocker.
5. A required check that is skipped, mocked at its boundary, weakened or run at a different revision is not a pass. Code that authors gate or acceptance verification is independently reviewed (CC-20); an author cannot approve their own final acceptance suite.
6. Leak-scan and push only the reviewed revision. The ticket PR targets its wave branch and the orchestrator merges it (merge commit) when the fresh recheck approves and the gate is green at the head. Only a wave PR targets `dev`; it merges when Greptile's check and CI pass at its exact head and no finding is unresolved. `dianbrown` approves only release PRs into `main`, which the user merges. Never rebase, force-push or touch `main`.
7. After an upstream change, merge it into dependent branches and rerun affected checks. A worktree isolates files; it is not a security boundary.

Accepted limits: at most three worker jobs in total and two browser jobs. This is capacity, not fan-out permission. PC1 keeps its CI role; PC2 (GRS-105) is no-go. KVM access and spare RAM are capacity inputs, not VM boot, isolation or concurrency proofs. Provisioning, allocations and job cleanup/reset behavior need their own bounded work.

Shared agent/test pools use synthetic data and have no production/account tokens. Keep trusted deployment credentials outside those pools and outside app builds. Use reviewed target manifests/configuration for credentialed steps; the cf/Void research proofs still apply. A local pass does not substitute for real hosted isolation, storage, provider or recovery acceptance.

Existing USD targets are build 20, review 6, written fix 8, recheck 2 and escalation 12. The user chose reporting only: exceeding a target does not automatically pause, cancel or escalate work. Report actual/unknown spend and variance. These are not a T3-enforced cap; the historical headless runner could enforce caps for the finished M2 sessions, but those are not policy and the T3 task API has none. Bound repeated attempts and excessive runtime independently of spending using the accepted controls below. A delegate_task wait timeout is not a child runtime limit; explicit task cancellation or a proven runner deadline is required. Keep briefs to one page, reports under 40 lines and one fresh session per stage.

## Accepted retry and runtime controls

- Keep one written-review fix round plus fresh recheck and at most one justified rare escalation. Allow one transient infrastructure retry; stop when the same failure repeats twice without a new diagnosis.
- Count attempts against the original issue/stage. Restarting, renaming or redispatching a task does not reset its budget of attempts or silently create another repair round.
- Default writing-task runtime is 90 minutes; review runtime is 30 minutes. Assess a stall after 30 minutes without meaningful progress. Declare legitimate bounded long tests and justified per-task deadlines in the brief before dispatch; a quiet agent alone is not evidence of a stall.
- Give a short checkpoint grace period, then explicitly cancel an overlong/stalled job. Retain its branch/diff, completed checks, failure evidence and cancellation result; clean up only that job's processes/resources. Do not mark interrupted verification as PASS or automatically respawn the same failing job.
- These are agent-run limits, not application restrictions. The tooling/test-pool owners must prove deadline/cancellation failure paths; this planning record does not install a watchdog. A T3 wait timeout alone is not runtime enforcement.

## Waves and checkpoints

A wave is a set of tickets on one branch `wave/<name>`, at most seven writers, reviewed together in one wave PR into `dev`. The checkpoint ticket is reviewed with its wave PR. Coordinator-owned membership, 17 October 2026:

| Wave branch | Tickets | Checkpoint |
| --- | --- | --- |
| `wave/preflight-parity` | GRS-141, GRS-143, GRS-142 (in flight) | none |
| `wave/compat` | GRS-22, GRS-24, GRS-48, GRS-49, GRS-61, GRS-68 | none |
| `wave/tooling` | GRS-104, GRS-139, GRS-140, GRS-144, GRS-145 | none |
| `wave/proofs` | GRS-106 to GRS-111 and GRS-97 | GRS-27 |
| `wave/foundation-bootstrap` | GRS-112, GRS-138 | none |
| `wave/foundation` | GRS-113 to GRS-118 | GRS-36 |
| `wave/first-workflow` | GRS-137 and GRS-120 | GRS-137 |
| `wave/widen-1` | GRS-28, GRS-135, GRS-29, GRS-30, GRS-130, GRS-31, GRS-129 | none |
| `wave/widen-2` | GRS-121, GRS-122, GRS-123, GRS-131, GRS-132, GRS-133, GRS-134 | none |
| `wave/widen-3` | GRS-119, GRS-124 to GRS-128 | GRS-66 |
| `wave/release` | GRS-32 | GRS-32 |

At each checkpoint the user reads the aggregate report and drives the verification skill once. Agents run unattended between checkpoints and stop, with `status.md` written, when only checkpoint-blocked work remains. When the aggregate is accepted, the orchestrator opens one PR from the wave branch into `dev`. Greptile reviews it and each new commit on it; its findings get one fix round per owner on the wave branch. The wave merges into `dev` through `merge-check --merge` when Greptile's check passes at the exact head (required confidence 4 of 5), CI passes there and no finding is unresolved. End-of-sprint human review replaces per-wave review: only a release PR from `dev` into `main` requests `dianbrown`, who must approve it at the release head, and the user merges `main`. A scheduled task at 08:30 SAST on weekdays posts one Linear project status update; it is the only routine human notification.

## The first workflow and the human gate

[GRS-137](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view) is the tracer bullet. It runs directly after GRS-36 and [GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before) and before the thick intake, queue, download, import, editing and publication owners (GRS-28, GRS-135, GRS-29, GRS-30, GRS-130, GRS-31). It builds the minimal version of each stage itself and proves one small synthetic PDF case, not a POC-scale case. The thick owners then take over their stages from its accepted head, and GRS-131 to GRS-134 follow it. A PDF-only first case does not permit missing required sections, missing required previews or unsafe publication.

The processing recipe, which is the prompts run over case documents, is never run by an agent. A worker stops with `AWAITING MANUAL RESULTS`, names the submission manifest and the download path in its report, and lets the user run the recipe in their own chat. A fresh session resumes from the import step once the user names the package path. This applies to GRS-137, GRS-29 and the release gate GRS-32 alike.

GRS-138 builds `gate:hosted` and the `verify-clearcase-hosted` skill before the foundation fan-out. Its first version uses fixture identity/storage/assets and leaves user work unavailable. GRS-113 and GRS-115 then extend the skill's feature map to the real boundaries, and every summary names each boundary as real or a double. A summary that names a test double for a boundary is not evidence for that boundary. Provider evidence comes from the bounded proof tickets and release checks under the [current provider disposition](verification-and-review.md#4a-cloudflare-pin-and-proof-dispositions): explicitly authorized Clerk-development proof does not require a Cloudflare unpin; cloud/production legs still require their owner decision and provisioning. Neither proves the other's boundary.

## Test protection and approval in code

A fix diff that deletes, skips, loosens or renames a test named in the findings fails its recheck, so the fix writes the failing test first and the sequence reads red then green. [GRS-104](https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery) turns this into a deterministic guard in the receipt tooling and in CI, and adds a review-verdict record. A ledger row is `approved` only when the fresh reviewer's report has no high or medium finding and the deterministic checks passed at the same SHA. For the approval record a review's high and medium findings map to P0 and P1 and its lows to P2, so a row with no P0 or P1 finding is exactly a row with no high or medium.

## Codebase discovery

Workers do not re-derive the architecture. In order: `docs/development.md` and `GLOSSARY.md`; the ticket's generated brief under `docs/plan/tickets/`, the Linear issue and the upstream report; the ADRs for the area and `docs/results-package.md` for the package or import; then `graphify-out/` when it exists. Every file or content search in the repository uses the `fff` MCP tools. Whole files are read only when the worker will edit them. What a worker learns that the map lacks goes into a `Map notes` section of its report, at most 10 lines, and the orchestrator folds accepted notes into `docs/development.md` at the wave boundary.

## Concrete delivery owners

The plan snapshot of 20 October holds 77 items, of which 34 are hosted delivery owners and 32 are accepted historical work. Its Linear capture (2026-10-20T19:21:49Z) holds 132 project issues, 59 of them open, 14 of those outside the plan. The 17 October readbacks (114 and 115 issues) are superseded. The owners carry bounded scope, acceptance, evidence recipes and native prerequisites. Exact paths and the accepted upstream SHA are pinned again at pickup. The table lists the initial scope of each delivery owner.

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
| [Prove the first complete hosted PDF case workflow before broad view migration](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view) | tests/hosted-smoke/**; scripts/verify/hosted-smoke.mjs; docs/acceptance/hosted-smoke.md; src/routes/v/[vid]/overview/** for a minimal read path until the GRS-131 handoff |

The production-integration aggregate remains open until its alpha delivery owners and integrated route coverage are accepted; later mailbox scope is tracked separately. Native dependencies and serial path handoffs are recorded on the tickets. Check the live graph before dispatch: parent aggregates depend on their children without a reverse dependency.

The source-only ownership check at the planning reference found 46 shared `app()` callers, synchronous results APIs, local filesystem import/rescan and absolute-path backup restore assumptions. Hosted storage owns the async seam before caller fan-out. Recovery must reject forged server paths and unscoped table restore and export; this is not a claim about current production. Hosted Rescan & Update uses the same upload, queue, private-review and publication flow for editor additions and replacements, and current publication and user work stay intact.

## Decisions and approvals

- Bounded escalation and the initial worker roles are accepted (Linear decision comment `410c1a45-c3d6-4359-acb4-bc5281a69201`). Spend reporting-only and the shared Rescan & Update flow are accepted in `045279af-b2f6-4867-b17f-c9017593cae3`. Retry and runtime limits: writing 90 minutes, review 30 minutes, stall assessment at 30 minutes, with bounded retry counts.
- The final workflow-scenario answers of GRS-136 are accepted (decision comment `f9705162-0911-492f-8684-4db568edefa7`): the primary lawyer journeys with all 42 views and the current processing prompts; the first complete workflow GRS-137; retrievable originals before publication; requested supplements linked to the same processing job; and cases that exist without a publication.
- The large/xhigh preset and session hook on were chosen (decision comment `68ef42c3-ac86-4a1c-b7f6-ef908922859e`) and the sheet was written on 17 October.
- The user approved the complete written plan on 17 October at 14:20 SAST. That approval was not runtime acceptance. Later component evidence and remaining provider HOLDs follow the current disposition linked above; the hosted product still needs its integrated acceptance evidence.
- Since 20 October 2026 (user decision, workspace `AGENTS.md`): Greptile's check, CI and the absence of unresolved findings at the exact head gate `dev`, and `dianbrown` approves only a release PR into `main`; a model or harness the user chooses for a session or task, Codex included, takes precedence for that task.
- Planning-tool limits, recorded as follow-ups: the readback file is coordinator-supplied and unauthenticated, so `--linear-relations` shows agreement with that file, not that it is live; a reserved test path names where a test lives, not that a runner collects it; `check-plan` now checks the delivery plan against its own generated format contract (`scripts/planning/plan_format.py`, GRS-159) and reports `NOT RUN: linear-relations` unless a readback is supplied; pstack's generic plan-format template stays available as `verify pstack-plan-format --plan PATH`. Eleven open tickets still carry the older "every Opus agent uses high" boundary wording in their Linear text; the workspace `AGENTS.md` table overrides it, and the next readback refresh normalizes it.

## Pstack sheet as written

The sheet at `~/.config/t3-pstack/models.md` was written on 17 October with budget large (xhigh). Its own comment reads: "ClearCase: routine work is Opus, written-finding fixes are Sonnet (set in the brief), Fable only after a linked escalation issue. Panel rows serve other projects; ClearCase does not run panels." The role lines:

```text
feature, refactoring: claudeAgent/claude-opus-5-5 effort=xhigh
bug-fix: claudeAgent/claude-opus-5-5 effort=xhigh
perf-issue: claudeAgent/claude-opus-5-5 effort=xhigh
hillclimb: claudeAgent/claude-opus-5-5 effort=xhigh
judgment and prose: claudeAgent/claude-opus-5-5 effort=high
hardest tasks: claudeAgent/claude-fable-5-1 effort=xhigh
how explorer: claudeAgent/claude-opus-5-5 effort=high
how explainer: claudeAgent/claude-opus-5-5 effort=high
why investigators: claudeAgent/claude-opus-5-5 effort=high
why synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
reflect tooling: claudeAgent/claude-opus-5-5 effort=high
reflect judgment, divergent, synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
arena runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh
arena cross-judge pool: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh
swarm workers: claudeAgent/claude-opus-5-5 effort=xhigh
architect runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh
interrogate reviewers: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh
session hook: on
```

The arena, architect, interrogate, reflect and swarm rows serve other projects. The workspace `AGENTS.md` does not allow those skills here.

## Snapshot of the earlier proposal (superseded, kept as history)

Archived 17 October 2026. Everything in this section is the pre-approval proposal as it stood on the morning of 17 October. It is superseded by the sections above and by the sheet as written. It is kept only so a reader can see what was proposed and changed.

- The proposal listed a role table that set implementation, review, recheck and written fixes all to xhigh, and a rare-escalation row with Fable or Astra. The table above replaces it.
- The proposal said the canonical machine model sheet was absent and proposed a sheet with every Opus role at xhigh and the comment "ClearCase permits bounded partitioned swarm work". The sheet as written has mixed high and xhigh roles, and swarm work is not permitted. The proposed block is not reproduced here.
- The proposal assumed the user permitted Astra "despite the older blanket workspace ban on Codex" as a scoped exception. The exception stands: `gpt-6-astra` as the recorded rare escalator, plus scoped per-task user authorizations such as the 17 October Codex design and review jobs, which do not enable routine Codex work.
- The proposal asked for external review of every PR before it merged into `dev`. The wave rule above replaces it.
- The proposal said hosted work waited for the planning gate and counted 32 owners, then 33, in a 73-item snapshot over 110 project issues. The snapshot now holds 76 items and 34 hosted owners.
- It chained the first workflow after the thick owners (GRS-28 to GRS-135 to GRS-29 to GRS-30 to GRS-130 to GRS-31, then GRS-137). The graph now runs GRS-137 first.
