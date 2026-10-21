# Verification and review model

Written 17 October 2026 after a read-only review of the project, the repository checks and the installed Pocock and pstack skills. The reference is the user-supplied article "Agents Write the Code. Your System Has to Prove It.", recorded on [GRS-94](https://linear.app/vaper/issue/GRS-94/define-the-fable-and-swarm-delivery-operating-plan). The operative rules live in the workspace `AGENTS.md` and `ORCHESTRATOR.md`; this page records the model behind them and the state of the pre-kickoff checklist. The [operating plan](agent-delivery-operating-plan.md) holds the full agent procedure and [handover](handover.md) indexes the review for an external reader.

State on 17 October 2026: the user approved the plan at 14:20 SAST (GRS-69 comment `45db4bdd-c268-4f6b-8658-cc2edb77bc6a`), and GRS-69 and GRS-94 are Done. Approval is not runtime acceptance, which stays UNRUN for the real providers. The dev gate was FAIL at `c89d405` at strict parity; the repair, GRS-141 with GRS-143 and GRS-142, is Done. Reconciled on 20 October 2026 (GRS-159): `dev` is at `b22680f5` (the hosted-bootstrap wave), the last recorded dev-gate PASS is at `442adb93`, and the dev-gate run at `b22680f5` recorded no verdict.

## 1. The pyramid, mapped to ClearCase

An agent's "done" is a claim. Work counts as verified when checks the agent did not write and cannot alter confirm the acceptance criteria, and the results are saved for inspection. Deterministic layers run first and guide the model layers, never the reverse.

| Layer | Local app today | Hosted work after [GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before) | Human involvement |
| --- | --- | --- | --- |
| 1. Contract: acceptance criteria and a test plan reviewed before code | Linear acceptance checklists. The brief names the verify command. | Same, plus the worker's first commit is its test plan: one line per test with actor, action, checkable result and what makes it fail. | The user approves acceptance at the five checkpoints. The reviewer reads the test diff before the implementation diff. |
| 2. Types, lint, static | `check`: tsc, svelte-check, schema export check, link check | Same, plus the hosted import-boundary negative test that [GRS-112](https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers) reserves | None |
| 3. Unit | vitest, `--maxWorkers=2` | Same, plus `tests/hosted-foundation/**` | None |
| 4. Integration against real services | SQLite is real. The offline namespace proves no egress. | workerd with local D1 and R2 bindings, synthetic data, no credentials ([GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before)). Real Clerk, D1, R2 and email appear only in the proof tickets [GRS-106](https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime) to [GRS-111](https://linear.app/vaper/issue/GRS-111/prove-minimal-cloudflare-transactional-notifications-for-alpha) and the release gate, and each summary names which boundary was real. | None |
| 5. End to end on a running app | `test:e2e`, strict `parity --all`, `verify:pilot:v5`, `verify-clearcase` (about 7 s) | `verify-clearcase-hosted` drives Chromium against the workerd app: sign in, open a case, open an original, deny a wrong client ([GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before)). [GRS-137](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view) extends it to upload, claim, import, approve, publish and view. | The user drives the skill once at each checkpoint. |
| 6. Model judge, thin, only what code cannot check | A fresh Opus reviewer with the `REVIEW.md` probes, findings tagged high, medium or low, one fix round and a fresh recheck | Same, plus hosted probe classes: wrong client, wrong case, stale version, draft asset, and a failed preview that holds publication | The external reviewer at wave boundaries (section 3). |

**Guards that keep the pyramid honest.** Already present: evidence stamps per exact SHA, stale-build and reduced-run refusal, receipts, a ledger keyed by SHA, a fresh reviewer that never saw the implementer's transcript, capped fix rounds and the leak scan before push. Added by [GRS-104](https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery) (`docs/agent-tooling.md`): a deterministic guard, in the receipts and in CI, that fails a fix diff which deletes, skips, loosens or renames a test the findings named, and an approval record decided in code (no P0 or P1 in the fresh review and the deterministic checks green at the same SHA) that a repo-side pre-push check reads instead of a chat summary. The coordinator's hook does not call that check yet.

**Severity mapping.** A review reports high, medium and low findings, and highs and mediums must be fixed before approval. For the approval record one schema applies: a review's high maps to P0, medium to P1 and low to P2. A row is `approved` only when no P0 or P1 finding is unresolved and the deterministic checks passed at the same SHA. A P2 never blocks approval and becomes a Linear follow-up. A finding that the fix round did not resolve keeps its original level.

**What stays with humans.** Writing and approving the contract. Reading the test diff before the implementation diff. Any fleet-wide or irreversible action: deploy, delete, `main` merge. The question the article keeps for people: do the criteria describe what users need.

## 2. Where the plan was weak and what changed

The local app has layers 1 to 6. Hosted work had layers 1 to 3 and 6. It said "or its independently reviewed hosted replacement" for layers 4 and 5 and gave that replacement no owner. [GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before) now owns it and runs before the foundation fan-out, so every hosted ticket from [GRS-113](https://linear.app/vaper/issue/GRS-113/implement-clerk-invitations-sessions-and-hosted-access-checks) onward verifies against a real gate. [GRS-141](https://linear.app/vaper/issue/GRS-141/dev-gate-fail-at-8ab9ef4-overview-and-documents-subtitles-differ-from) repairs the local dev gate first, because it blocks [GRS-22](https://linear.app/vaper/issue/GRS-22/verify-newer-2131-document-and-json-export-compatibility) and [GRS-104](https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery). The graph restructure is recorded on [GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha).

## 3. Human steps: before and after the restructure

| Step | Before 17 October | Now |
| --- | --- | --- |
| User approval | [GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha) once, then nothing until [GRS-32](https://linear.app/vaper/issue/GRS-32/verify-hosted-isolation-recovery-and-release-readiness) | Five `checkpoint` tickets: [GRS-27](https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation) (design), [GRS-36](https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work) (foundation), [GRS-137](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view) (first hosted case), [GRS-66](https://linear.app/vaper/issue/GRS-66/accept-hosted-production-integrations-and-page-coverage) (integrations) and [GRS-32](https://linear.app/vaper/issue/GRS-32/verify-hosted-isolation-recovery-and-release-readiness) (release candidate). One sitting each: read the aggregate report, drive the verification skill once, approve or send one written finding list. |
| External reviewer (`dianbrown`) | Every PR into `dev` (until 20 October 2026): 39 PRs, changes requested 23 times, median 7.6 h from open to merge | One review per wave, by Greptile since 20 October 2026; `dianbrown` now approves only a release PR into `main`. Each wave's tickets land on a wave branch (the membership is in the map below). Inside the wave the agent loop merges each layer into the wave branch: gate, fresh Opus review, one Sonnet fix, fresh recheck, leak scan. One PR from the wave branch into `dev` is what he reviews, in his hours, in one sitting. His findings become one fix round per owner on the wave branch, then one re-request. `main` stays the user's. |
| Night-time pings | Any PR can wait on a human at any hour | Nothing pings a human. A scheduled task at 08:30 SAST on weekdays posts one project status update: wave PRs awaiting the external reviewer, checkpoints awaiting the user, blocked units and spend to date. Agents keep working on every unit that is not checkpoint-blocked. When only checkpoint-blocked work remains, the orchestrator writes status and stops. |
| Escalation | A rare Fable or Astra round after a linked issue | Unchanged. It batches into the morning update unless a stop line is raised. |
| Manual processing ([GRS-137](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view), [GRS-29](https://linear.app/vaper/issue/GRS-29/notify-operators-and-download-a-complete-submission)) | Not decided | Human gate. The worker stops at `AWAITING MANUAL RESULTS` after the operator download. The user runs the processing recipe in their own chat and supplies the package path. A fresh session resumes from import. The same stop applies to the release gate [GRS-32](https://linear.app/vaper/issue/GRS-32/verify-hosted-isolation-recovery-and-release-readiness): its acceptance needs human-produced results, being the verifier grants no processing exception, and the worker stops with `AWAITING MANUAL RESULTS`, the manifest and the download path. Expect this to be the long pole of the [GRS-137](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view) checkpoint. |

**Cost of the change.** A wave review can cascade into several owners if a low layer is wrong. Waves are capped at seven tickets, and the review checklist already encodes the reviewer's nine earlier P1 and P2 classes as probes, so the agent loop catches his known classes before he sees the wave. Nothing merges into `dev` without his approval. The rule is relaxed only for wave branches.

## 4. Applied on 17 October

The workspace `AGENTS.md` and `ORCHESTRATOR.md` now carry the following. They sit outside the repository and are the operative copies; the [operating plan](agent-delivery-operating-plan.md#waves-and-checkpoints) records them.

- Wave branches, the five checkpoints and the morning update.
- The hosted-checks rule: `gate:hosted` is the required check for hosted tickets once [GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before) lands.
- The test-protection rule: a fix diff that deletes, skips, loosens or renames a test named in the findings fails its recheck.
- A Codebase discovery section: the development guide, the glossary, the generated ticket brief, the ADRs, `graphify-out/` when present, the `fff` MCP tools for search, and `Map notes` in every report.
- The human gate for manual processing.
- The effort table: Opus xhigh for builds and reviews, high for rechecks and research, Sonnet high for written fixes, and Fable or Astra at xhigh only after a linked escalation issue. Spend targets are reporting only.

The pstack model sheet is written at `~/.config/t3-pstack/models.md`: budget large (xhigh), routine roles on Opus, hardest tasks on Fable, session hook on. It is the one current sheet; the operating plan quotes it, and its panel rows do not authorize panels here.

## 4a. Cloudflare pin and proof dispositions

Cloudflare account, domain and provider work is pinned until the user unpins it (GRS-26 decision `d6367d1a`, recorded 17 October 2026). Real-provider acceptance stays mandatory; the pin only decides what may run now. A local result never certifies a provider boundary.

| Proof leg | While pinned | Disposition |
| --- | --- | --- |
| Local build, workerd with local D1 and R2 bindings, synthetic data | May run | PASS or FAIL at an exact SHA, labelled local |
| Test-mode identity, email sink | May run | Labelled test double; no Clerk or email provider evidence |
| Anything that needs a real Cloudflare account, a Paid plan, a real Clerk instance, a real mail provider or any credential | Does not run | HOLD, never a mock PASS |
| Release gate real-provider legs | Does not run | HOLD until unpinned |

Once unpinned, the ceiling is USD 25 a month with an alert at USD 10. The unpin is the user's decision alone, and a credential reaches a run only through the secret path (step 8 below). GRS-105 (PC2) is no-go.

## 4b. Waves and checkpoints

A wave is a set of tickets on one branch `wave/<name>`, at most seven writers. The checkpoint ticket is reviewed with its wave PR. Membership is coordinator-owned; this is the map on 17 October 2026.

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

Ticket PRs target their wave branch. A dependent branch may be cut from its upstream ticket's branch for ancestry, but its PR still targets the wave. Only wave PRs target `dev`. On 17 October `dianbrown` reviewed the wave PR; since 20 October 2026 Greptile's check, CI and no unresolved finding at the exact head gate `dev`, and `dianbrown` approves only release PRs into `main` (workspace `AGENTS.md`). The internal fresh review of every ticket and the independent review of gate-authored verification code (CC-20) stay. These are separate decisions: the internal ticket review, the independent gate-code review, the user's checkpoint and the wave's merge into `dev` on Greptile's check, CI and no unresolved finding. `dianbrown`'s approval is the release decision for `main`.

## 5. Pre-kickoff checklist and state on 17 October

The rows record the state on 17 October 2026 and stay as recorded. Reconciled on 20 October 2026 (GRS-159): row 3 is done by the 20 October snapshot of `docs/plan/work-items.json`; row 12 is superseded (Greptile gates `dev`; `dianbrown` approves only release PRs into `main`); row 14 is closed (GRS-141 is Done).

| # | Step (human only) | State |
| --- | --- | --- |
| 1 | Approve the complete written plan and close [GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha) and [GRS-94](https://linear.app/vaper/issue/GRS-94/define-the-fable-and-swarm-delivery-operating-plan) | Done: approved 17 October at 14:20 SAST, both issues Done. The sheet is written. |
| 2 | Merge the planning branch into `dev` | Done: PR #45, `c89d405` |
| 3 | Refresh `docs/plan/work-items.json` from live Linear so [GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before) to [GRS-141](https://linear.app/vaper/issue/GRS-141/dev-gate-fail-at-8ab9ef4-overview-and-documents-subtitles-differ-from) and the new edges are in the snapshot | Done in [GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha)'s plan sync |
| 4 | Reset the root checkout to `origin/dev` | Done |
| 5 | Decide [GRS-64](https://linear.app/vaper/issue/GRS-64/compare-the-local-app-with-the-live-production-deploy-page-by-page) and [GRS-65](https://linear.app/vaper/issue/GRS-65/tag-the-v1-demo-release-and-merge-it-into-main) (demo comparison and main tag): do them now or cancel them | Open |
| 6 | Cloudflare: an account with Workers Paid, a zone, subdomains for two synthetic clients and the staff app, a scoped API token, a spend alert, and the South Africa or EU placement decision recorded. Disposable resource naming so the workers and the janitor can tell runs apart. | Pinned (see the Cloudflare matrix below). Deferred until the local-first proof plan on [GRS-26](https://linear.app/vaper/issue/GRS-26/prove-the-hosted-architecture-and-cloudflare-deployment) says it is required |
| 7 | Clerk: two client applications and one staff application in development mode, test users, keys delivered through the secret path in step 8 | Deferred, same condition |
| 8 | Secret path: tokens live only on the workstation outside every worktree, reached through a narrow wrapper command. [GRS-107](https://linear.app/vaper/issue/GRS-107/prove-cf-and-void-deployment-migration-and-credential-boundaries) designs it. Decide the storage location before [GRS-108](https://linear.app/vaper/issue/GRS-108/prove-clerk-sessions-and-explicit-case-authorization-on-workers), [GRS-109](https://linear.app/vaper/issue/GRS-109/prove-d1-and-r2-integrity-layout-and-poc-workload-performance) and [GRS-111](https://linear.app/vaper/issue/GRS-111/prove-minimal-cloudflare-transactional-notifications-for-alpha) start. | Open |
| 9 | cf and Void CLIs installed on the workstation, with Wrangler as fallback | Open |
| 10 | PC2 test pool: go or no-go for [GRS-105](https://linear.app/vaper/issue/GRS-105/prove-a-disposable-synthetic-test-pool-on-pc2-while-preserving-pc1-ci) (optional, not a product gate) | Decided: no-go. |
| 11 | Email sending domain, DNS and DMARC for [GRS-111](https://linear.app/vaper/issue/GRS-111/prove-minimal-cloudflare-transactional-notifications-for-alpha), or decide that the proof uses a sink only. A sink cannot certify the real provider boundary. | Pinned with Cloudflare |
| 12 | External reviewer: agree the wave cadence, his review hours and the five checkpoints, and hand him `REVIEW.md` | Open |
| 13 | Tailscale re-login so agents reach pc1 | Done 17 October. pc1 headroom is measured (see [CI runner](../ci-runner.md)). |
| 14 | Fix the dev gate ([GRS-141](https://linear.app/vaper/issue/GRS-141/dev-gate-fail-at-8ab9ef4-overview-and-documents-subtitles-differ-from)) before any ticket cuts a branch from `dev` | Open and in flight on `wave/preflight-parity`. This is the one recorded exception: the repair tickets (GRS-141, GRS-143, GRS-142) are cut from the red `dev` at `8fc2058`, and every other ticket waits for a green base. |

## 6. Things the plan may still be missing

- **Observability and alerting** in Workers has no owner: error logs, a health endpoint per client, and an alert route to the operator. Add a small ticket after [GRS-137](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view), or fold it into [GRS-116](https://linear.app/vaper/issue/GRS-116/implement-permission-scoped-audit-events-and-audit-views) and [GRS-118](https://linear.app/vaper/issue/GRS-118/implement-complete-case-export-backup-recovery-and-approved-deletion).
- **A synthetic corpus at POC scale.** [GRS-109](https://linear.app/vaper/issue/GRS-109/prove-d1-and-r2-integrity-layout-and-poc-workload-performance) and the release gate need a case the size of the 1,689-document v5 sample. [GRS-137](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view) does not: it proves one small synthetic PDF case. The full-scale synthetic corpus belongs to GRS-144, GRS-109 and [GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before), with a leak-scan needle that refuses the real sample's hashes outside the local gate. Without a generator, an agent will be tempted to push the real v5 sample to Cloudflare.
- **Cloud janitor.** Parallel workers create disposable D1 and R2 resources. They need a cleanup after every job and a nightly sweep. Put it in [GRS-107](https://linear.app/vaper/issue/GRS-107/prove-cf-and-void-deployment-migration-and-credential-boundaries).
- **Effort and spend.** Tickets at xhigh cost more than the M2 run at high (484 USD across 197 T3 units since 12 October, about 2,100 USD before that). Plan on 2,000 to 3,000 USD for the hosted wave and watch the spend line in the morning update.
- **Mobile check.** No agent holds a phone. Drive the hosted skill from a real device at the [GRS-137](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view) and [GRS-32](https://linear.app/vaper/issue/GRS-32/verify-hosted-isolation-recovery-and-release-readiness) checkpoints.
- **Client onboarding is not alpha done.** POPIA processing terms, the data placement statement and support hours belong before the first real client, not before kickoff. List them in the [GRS-32](https://linear.app/vaper/issue/GRS-32/verify-hosted-isolation-recovery-and-release-readiness) runbook.
- **Dependency single writer.** The viewer owners ([GRS-121](https://linear.app/vaper/issue/GRS-121/implement-faithful-word-and-excel-viewing-and-prepared-renditions) to [GRS-123](https://linear.app/vaper/issue/GRS-123/implement-accepted-media-and-archive-contained-viewing-paths)) need parsers in the lockfile. [GRS-112](https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers) pre-adds what [GRS-97](https://linear.app/vaper/issue/GRS-97/evaluate-viewer-components-and-freeze-alpha-file-coverage) selects, so keep [GRS-97](https://linear.app/vaper/issue/GRS-97/evaluate-viewer-components-and-freeze-alpha-file-coverage) ahead of [GRS-112](https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers).
