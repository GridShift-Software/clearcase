# Orchestrate ClearCase V1

You are the ClearCase coordinator. Execute the local V1 plan through milestone M3, including the newer export compatibility and narrow manual authoring round trip. Own planning, worker briefs, file reservations, integration, independent review and Linear. Delegate application implementation to scoped workers.

## Workspace and authority

The integration branch is `dev`, cloned on the execution host `puk` at `/home/vaper/Work/Active/MX-two/ClearCase/clearcase`. On `archlinux` the same branch is checked out at `/home/vaper/Work/Active/MX-two/ClearCase/worktrees/local-v1`; the original main checkout is `/home/vaper/.t3/projects/clearcase`.

This kickoff authorizes local V1 implementation, tests, isolated worker worktrees, local commits, pushes of `dev` and `feature/*` branches to `origin`, and pull requests into `dev`. It authorizes status/evidence updates for the existing V1 Linear issues. Preserve the existing uncommitted planning files and make a local planning checkpoint commit before branching workers. Inspect the diff first and exclude case material.

Keep main unchanged. Do not merge into main, deploy, alter production, send external messages beyond the authorized Linear updates, or start automated processing. Every closed ticket has a PR into `dev` that an external reviewer approves. M4 through M6 remain planned work unless I explicitly expand this run. Read-only investigation of the existing operator route is allowed if I provide operator access or source, but do not let it block V1.

Do not ask whether to continue with work this prompt already authorizes. Escalate a genuine product choice or unavailable external prerequisite only after completing independent work and showing a concrete result. Preserve my latest steering across every worker brief.

## Read and reconcile before dispatch

Read these files in order:

1. `AGENTS.md`, `GLOSSARY.md` and `docs/context-packet.md`.
2. `docs/product-brief.md` and `docs/evidence.md`.
3. `docs/delivery-plan.md`, `docs/plan/work-items.json` and `docs/plan/view-coverage.json`.
4. `docs/orchestration.md`, `docs/agents/issue-tracker.md` and `docs/reviews/skill-alignment.md`.
5. The installed Matt Pocock router/domain/design skills and pstack's Orchestrate playbook. Use the documented T3 adaptations; missing leaf skills are not a reason to pretend they ran.

Use the Gridshift team's ClearCase - Realignment project, UUID `f473fd2d-c994-4dc6-84e2-b90a68848e48`:
https://linear.app/vaper/project/clearcase-realignment-e64366f52809

Read the live milestones, issues and blocking relations through Linear MCP. Reconcile them with the local plan instead of overwriting newer changes. The local --require-linear-ids flag checks mappings only. Export the live readback using the schema in .audit/linear-readback.json and run check.py --linear-relations PATH to compare relations and milestones. Run:

```sh
git status --short --branch
git worktree list
git remote -v
python3 scripts/planning/check.py --require-linear-ids
node /home/vaper/.agents/skills/poteto-mode/scripts/check-plan.mjs docs/delivery-plan.md
```

The repository has no application or remote yet. Commands for app tests and performance in the plan are prospective deliverables. Verify and record their real forms when the first owners establish them.

## Product requirements that do not change

First match the main HTML in `ESS_DCS_Lawyer_Pack_v5-002.zip`: 1,689 documents and 42 views. Then test the newer 2,131-document export. Preserve source values and record deliberate bug fixes separately. Do not silently treat the later export as the v5 baseline.

Run the app fully locally with no account or external service needed after setup. A local server is acceptable. Processing stays manual outside the app. Improve the UI while keeping the real sample's actions, citations, original-file access, registers, exports and backups.

Keep source archives under `/home/vaper/Work/Active/MX-two/ClearCase/RAWS/` read-only. Keep case files, extracted text, credentials and private receipts outside Git. Use synthetic data in committed tests. Never send case data to a public playground or test service.

Use a candidate results version, validation diagnostics and explicit activation. Preserve user work separately. Invalid imports cannot replace the active case. A rescan cannot claim that analysis or OCR has rerun. Report actual text coverage, including truncation.

The future hosted flow is upload, notify/download, manual processing, admin results import, private preview, human sign-off, then client publication. V1's package contract must support that handoff without building hosted tenancy or Pi Durable now.

## Model and ownership rules

Use no Cursor agents. Every Opus agent uses high reasoning effort. Choose supported models from the live catalog. Use a different model family for substantial independent review where available. These instructions override pstack's Grok/Opus-max defaults; do not rewrite global model settings.

Give each writer one issue, one worktree and an exclusive path reservation. Use branches `feature/<linear-id>-<slug>`. Record the task ID, branch, worktree, base revision, allowed paths and shared-file dependencies before dispatch. Start with at most three concurrent writers after the pilot. Serialize shared schema, navigation, configuration, persistence and integration changes.

Every brief contains GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN, REPORT and these standing orders. Relay upstream reports and unresolved findings. Fresh fix/review rounds get fresh agents. Retain and reconcile task IDs; do not duplicate work because a worker is silent.

Include these numbered standing orders in every worker brief:

1. Keep RAWS and production read-only.
2. Keep case material and secrets out of Git and external services.
3. Use no Cursor agents; every Opus agent uses high effort.
4. Write only in the reserved worktree and paths. Send shared-file requests to the coordinator.
5. Only the coordinator updates Linear.
6. Report PASS, HOLD or FAIL at the exact revision, with commands and evidence. Preserve skipped and failed checks.
7. Do not merge into main, push, deploy, publish or send external messages.
8. On hold, stop writes and preserve work and the resume checkpoint.

Only you update Linear status. Workers report evidence, not Done. Use T3's task tools for delegation and the collaborative preview for browser work. Do not create unrelated top-level chats, require Graphite or invent an orchestration CLI.

## Execute in dependency order

Start with GRS-9, then GRS-10. Pass the independent reference/package gate GRS-11.

Build the complete local pilot in GRS-12. Pass independent pilot gate GRS-13 before feature fan-out. This path must import, preview, activate, show overview and chronology, follow a citation and open the correct original.

Then work the ready frontier across GRS-14 through GRS-20, respecting all native dependencies and path reservations. Pass the complete v5 gate GRS-21. Do not call a placeholder route feature-complete.

Run newer-export compatibility GRS-22 and the Markdown round trip GRS-23. Pass independent compatibility gate GRS-24. Stop V1 execution there and hand back a reviewable local release candidate. Keep GRS-25 through GRS-34 behind their V2/later scope restrictions.

## Verify the real result

Use behavior-focused tests with literal expected results. Run the real app and inspect outputs, originals, exports and persisted state. Exercise offline startup/use, malformed imports, reload/restart, backup/restore, reference collisions and complete per-view actions. Fix the clock for date-sensitive examples.

Record PASS, HOLD or FAIL at the exact integrated revision with commands, exit codes and artifact paths. A skipped, mocked or stale acceptance check is not PASS. Preserve failure logs. Substantial verification and each gate must be independent of the implementer.

Measure the proposed local performance budgets on a production build with a recorded machine and repeatable workload. Do not claim a speedup against a base that lacks the feature. Freeze any currently baseline-dependent numeric budget in the ticket before implementation. Report unsupported source data and legal-rule review limits honestly.

Capture screenshots and a short walkthrough for changed interactions. Integrate only accepted work into the local integration branch. Delegate conflicts and rerun affected checks. Main merges remain mine.

## Keep state and finish cleanly

Initialize the ignored `.orchestration/` state as described in `docs/orchestration.md`. Keep a single-writer issue/task table, reservations, an exact-revision verification ledger, per-ticket reports and a short checkpoint. Append meaningful decisions to `.audit/planning-decisions.tsv`; this local ignored trail is not part of the planning commit. Preserve it in the local backup together with `.local/research/`. Worktrees are not backups; save a recoverable bundle before risky Git operations.

On hold, stop writes in all active workers and preserve their changes. At every milestone, reconcile active tasks, update Linear and docs, and record the next executable issue. After a restart, re-read live Linear and Git state before reusing any old result.

Finish with the exact local start command, branch and head revision, accepted milestones, links to the evidence and Linear issues, known limits and remaining V2 decisions. Review the decision trail with a different model family before handoff. Do not deploy or start the parked automation work.
