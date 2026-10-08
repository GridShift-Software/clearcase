# ClearCase delivery plan

Build a local case workspace against the v5 sample, then verify the newer export and prepare hosted client delivery.
The first baseline contains 1,689 documents and 42 views. The second contains 2,131 documents.
This is a plan, not an implementation or a completed verification report.
Stable planning keys map to real Linear issues in the appendix and `docs/plan/work-items.json`.
This document is generated from `docs/plan/program-intro.md` and `docs/plan/work-items.json`.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. Check a box only when its evidence exists. Generated boxes represent acceptance obligations; execution status and evidence live in Linear and the coordinator's ledger.

The program runs `/home/vaper/.agents/skills/poteto-mode/playbooks/orchestrate.md` with the local T3 adaptations in `docs/orchestration.md`. The coordinator integrates accepted local work. The user controls main-branch merges and deployment. The remote is `origin`; every ticket closes through a PR into `dev`.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

The implementation test commands below are required deliverables, not existing runnable commands. CC-01 supplies its inventory CLI. CC-02 establishes package tests; CC-03 establishes app/build/browser commands. Before dispatch, replace any affected command with the verified repository command and keep the acceptance behavior unchanged. Gate and discovery issues verify their real output without invented UI tests.

## Program checklist

### Arm the program

- [ ] Treat this session as planning only. Start implementation when the user supplies the kickoff as an execution instruction.
- [ ] Read the current local skills and record their paths. `origin/dev` is the integration base; use `git show origin/main:<path>` only to compare against the release branch, which changes only through user-approved merges.
- [ ] Read the orchestration, swarm, verification and relevant implementation skills before each phase. The user's no-Cursor and Opus-high settings override default model choices.
- [ ] Do not arm `/loop 1h` during planning. If later authorized, use the app scheduler for an hourly audit with a status message only for material changes; T3 task completion already supplies wakeups.
- [ ] On hold, send every active writer a zero-writes instruction and preserve their artifacts.

### Spawn owners

- [ ] Use one owner per implementation ticket, one worktree per writer and a complete brief. Keep the coordinator responsible for Linear and integration.
- [ ] Run CC-01 and CC-02, then independent gate CC-23. Run the complete pilot CC-03, then independent gate CC-24 before feature fan-out.
- [ ] Follow every native Linear blocking edge and reconcile it with the local graph. A gate is not satisfied by a worker's self-report.
- [ ] Reserve actual file paths before dispatch. Limit initial writers to three; serialize shared config, schemas, navigation and persistence changes.
- [ ] Retain delegated task IDs. Fix rounds use fresh agents with the original scope, prior report and unresolved findings.

### PR mechanics, for every PR

- [ ] Push each `feature/<linear-id>-<slug>` branch to `origin` and open a PR into `dev` when the ticket's evidence is complete. Register every PR with T3.
- [ ] When a remote and PR workflow are authorized, use the available forge and register every PR with T3. Do not require `gt` or a nonexistent repository script.
- [ ] During authorized implementation, run lint/typecheck and relevant behavior tests before each reviewable commit. Cut unnecessary comments and prose before review.
- [ ] Keep the reviewed base revision stable through a fix round. Delegate conflicts and recheck affected evidence after integration.

### Verdict and merge, for every PR

- [ ] Record PASS, HOLD or FAIL with exact revision, commands, exit codes and artifacts. A skipped, stale or mocked acceptance check is not PASS.
- [ ] Use independent reviewers for CC-23, CC-24, CC-11, CC-25, CC-26 and CC-20. A reviewer must not approve their own implementation.
- [ ] Reconcile new heads against prior receipts. Run fresh checks for behavior changes and integration conflicts.
- [ ] Merge accepted, externally reviewed PRs serially into `dev` only under the kickoff's execution authority. Keep main unchanged.
- [ ] Collect screenshots and a video for interaction changes. The user reviews the concrete release candidate before a main merge.

### Boot recipe, for every live lane

- [ ] Check out the exact reserved local candidate revision. Record `git rev-parse HEAD` and any uncommitted diff digest.
- [ ] Read the ticket's fixture and input-version identity. Set the documented local fixture path and fixed clock; keep case material outside Git.
- [ ] Once CC-03 provides the app, install from its lockfile, run the documented local server on loopback and wait for its readiness check. Use `npm run build` and the production preview for performance measurements.
- [ ] Use T3 `preview_status`, then `preview_open` if needed, followed by the available navigation and interaction tools. Follow platform fallback rules if the preview is unavailable.
- [ ] Drive real inputs, save screenshots and logs under `.orchestration/reports/<planning-key>/`, and name the observed pass predicate. CLI units save terminal transcripts; no screenshot is required.
- [ ] Disable outbound networking for local acceptance. Use synthetic data for committed tests and keep case-bearing receipts ignored.
