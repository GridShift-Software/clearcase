# Run the ClearCase delivery queue

> Partly historical: the workspace `AGENTS.md` (11 October 2026) overrides this protocol. Sections marked historical below are superseded by it.

Use this protocol with pstack's `playbooks/orchestrate.md`. The coordinator owns the program and delegates implementation. Run checks with `bun run --bun gate`. Start with the V1 queue and leave hosted delivery and processing automation behind their phase gates.

## Establish authority and current state

> Historical: the execution authority has been granted. The coordinator's start-up is in the workspace `AGENTS.md` (Orchestrator).

Read the latest user instructions, `AGENTS.md`, the product brief, delivery plan, live Linear relations and the coordination checkpoint. Reconcile Git HEAD, branches, worktrees and active delegated task IDs before dispatch.

The planning session has not authorized implementation or commits. The kickoff prompt grants a new agent local V1 execution, local commits, pushes of `dev` and `feature/*` branches and stacked pull requests into `dev` when the user actually supplies it as an instruction. It does not grant merges into main, deployment, production writes or external messages beyond the authorized Linear updates. Never infer a new restriction from an unrelated project's old approvals.

## Dispatch one pilot before parallel work

> Historical: the pilot and the M1 gates passed. The worker limit is in the workspace `AGENTS.md` (Limits).

1. Complete the reference and package-contract work, then pass its independent gate.
2. Complete the local import-to-original workflow, then pass the pilot gate.
3. Open the feature queue only after the package interfaces, persistence ownership and layout conventions are recorded.
4. Use at most three concurrent writers initially. Dispatch only ready issues with disjoint file reservations. Revisit the cap from observed machine capacity rather than copying Jove's RAM thresholds.

The blocking first steps are the baseline, package contract and pilot. After the pilot, evidence browsing, narrative analysis, calculations and user-work registers can run independently where file ownership permits. Litigation and bundle workflows wait for the stores or analysis they consume. CC-03 freezes all 42 navigation extension points and shared contracts; CC-24 verifies them. During M2, the coordinator owns and serializes changes to dependencies, lockfiles, shared layout, configuration and schemas. Later tickets may extend a shared path only after the earlier owner has been accepted and released the reservation.

## Reserve files before dispatch

Create `feature/<linear-id>-<slug>` in a separate worktree based on the accepted integration revision, or on the upstream ticket's accepted head for a stacked ticket. The integration branch is `dev`; `main` is release-only and changes only through user-approved merges from `dev`. One writer owns each worktree. The coordinator records the issue, task ID, branch, worktree, base revision and allowed paths before work starts.

Workers cannot edit sibling worktrees, shared planning files, source archives or production. If a ticket needs a shared file owned elsewhere, return a precise request to the coordinator. Resolve overlaps before dispatch; a warning in a prompt is not isolation.

## Use a complete worker brief

> Historical: briefs now fit on one page and carry no standing orders (workspace `AGENTS.md`, Context).

Every brief states the goal, allowed paths, forbidden paths, upstream evidence, acceptance criteria, exact verification commands, timebox, report format and standing orders. A worker may inspect other files but cannot silently widen its write scope. A missing prerequisite or undefined command is resolved before the worker starts that dependent step.

Choose models from the live T3 catalog. No Cursor. Models, effort and budgets per role are the table in the workspace `AGENTS.md`, which overrides any effort named in a skill, brief or older text here. Do not change global model settings for this project.

Retain each delegated task ID. Read completion once, reconcile it with the reserved scope and reviewed revision, and start a fresh agent for a fix/review round. A callback is a queue event, not evidence of acceptance. Do not poll a completed worker or launch duplicate work because it is slow.

## Verify and integrate

> Historical: verification lanes are retired. Each ticket runs build, review, at most one fix round, then ship (workspace `AGENTS.md`, The loop for each ticket).

Require PASS, HOLD or FAIL with the exact revision or reproducible diff digest, commands, exit codes, output files and known limits. Preserve failure logs. Check actual artifacts rather than worker summaries. For browser behavior, prefer the T3 collaborative preview. Use another browser system only under the platform's documented fallback conditions.

Independent gate issues require a reviewer who did not author the implementation. For CC-11 and CC-20, a second reviewer checks any acceptance code written by the gate owner and issues the final verdict. A failed gate blocks downstream work and produces scoped repairs. Recheck evidence after any behavior-changing integration or conflict resolution. Do not mark a gate Done on a partial, skipped or mocked acceptance run.

The detailed V1 plan names ten behavioral scenarios per implementation unit. These are coverage lanes, not ten simultaneous writers. Run them in bounded batches or reuse a verifier for independent scenarios. Gates read those receipts and rerun the critical paths. Pure planning/discovery tasks use direct artifact checks; they do not invent UI or performance tests.

Integrate clean, accepted commits serially into the integration branch under the kickoff's local execution authority. Delegate conflict resolution. Keep main unchanged. The remote is `origin`, GitHub `GridShift-Software/clearcase`. Every ticket closes when the pull request from its `feature/<linear-id>-<slug>` branch, registered with T3, lands in `dev`; the user's external reviewer approves before merge, and the coordinator merges only accepted, reviewed PRs. PRs form a stack on GitHub: the bottom PR targets `dev`, and a dependent ticket's branch is cut from its upstream ticket's accepted head with its PR targeting that upstream branch, so each layer is reviewed separately; GitHub retargets a layer to `dev` when the layer below merges, and everything lands in `dev`. Link the layers with `gh stack link --base dev` (the official `github/gh-stack` extension), never with commands that rebase or force-push, such as `gh stack sync` or `gh stack rebase`; when a lower layer changes, merge the updated upstream branch into the layers above and rerun affected checks. Push feature branches early so a worktree is never the only copy. Do not fabricate PR URLs or require Graphite.

## Execution hosts

> Historical: workers run as T3 tasks or headless Claude resumes; Codex is not used (workspace `AGENTS.md`).

The coordinator thread runs in T3 on `puk`. Workers and verifiers run on the host `puk` (reachable over Tailscale as `puk`) as headless Claude Code or Codex CLI sessions inside tmux, one session per ticket. The `dev` clone on puk is `/home/operator/Work/Active/MX-two/ClearCase/clearcase`; worker worktrees live under `/home/operator/Work/Active/MX-two/ClearCase/worktrees/<branch-slug>`. `archlinux` remains a supported developer host; RAWS is mirrored read-only at the same absolute path on both hosts. The coordinator's ignored `.orchestration/` state lives in the puk `dev` clone. A worker reports by writing its report file; the coordinator reads it locally after the tmux session exits.

## Keep one coordination record

> Historical: `.orchestration/status.md` is the coordination record (workspace `AGENTS.md`, Orchestrator).

The coordinator alone writes `.orchestration/units.tsv`, `.orchestration/ledger.tsv`, `.orchestration/reservations.tsv` and `.orchestration/checkpoint.md`. Workers write per-ticket reports under `.orchestration/reports/<planning-key>/`. Keep case-bearing screenshots, exports and logs local and ignored.

A ledger row records the issue, exact revision, reviewer, verdict and evidence path. A checkpoint records accepted HEAD, active issues/worktrees/task IDs, blockers, authorization limits, safe shutdown and exact next steps. Keep it short and link detailed reports. Read live Linear relations again on resume.

The local graph checker is `python3 scripts/planning/check.py`. It verifies the plan and coverage; it is not an orchestration daemon. `scripts/agent-tools/check-plan` runs it with pstack's `check-plan.mjs` and writes receipts; `scripts/agent-tools/doctor` is the preflight for every worker and verifier session. T3 owns agent dispatch and completion delivery. Pstack's `orch` CLI is available in the installed skill bundle but is not used here. Jove's custom runner is not a prerequisite. Add runtime bookkeeping automation only when the repeated work justifies it.

No scheduler is armed by this planning task. At execution, an app-owned audit schedule may implement pstack's hourly review if the active user authorization permits ongoing work. Never build a polling watcher or let a timer start V2 or automated processing past a closed gate.

## Stop and resume safely

> Historical: fix rounds and escalation follow the workspace `AGENTS.md` (The loop for each ticket); handoff follows its Hand off rule.

On a user hold, send all active writers a zero-writes instruction, collect their state and update the checkpoint. Do not delete their worktrees or uncommitted work. For a failed task, preserve its artifacts, diagnose the failure mode and retry at most twice with smaller scope or a different supported model before replanning.

At the end of each milestone, reconcile every spawned task to a terminal state, check the independent gate and update Linear and local docs together. At V1 completion, hand back the working app, evidence, exact start command and remaining V2 decisions. Do not silently start the parked automation queue.
