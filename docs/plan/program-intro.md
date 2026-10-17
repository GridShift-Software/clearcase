# ClearCase delivery plan

Carry the accepted local proof of concept into the hosted alpha, preserving the v5 workspace while verifying newer and JSON exports.
The first baseline contains 1,689 documents and 42 views. The second contains 2,131 documents.
This is a plan, not an implementation or a completed verification report. Every hosted implementation, runtime and provider check it names is UNRUN, and the hosted-alpha planning gate ([GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha)) is closed: the user approved the complete written plan on 17 October 2026.
Stable planning keys map to real Linear issues in the milestone and issue graph and `docs/plan/work-items.json`.
This document is generated from `docs/plan/program-intro.md` and `docs/plan/work-items.json`.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. Check a box only when its evidence exists. Generated boxes represent acceptance obligations; execution status and evidence live in Linear and the coordinator's ledger.

The program follows the workspace `AGENTS.md` loop and the hosted-alpha delivery operating plan of [GRS-94](https://linear.app/vaper/issue/GRS-94/define-the-fable-and-swarm-delivery-operating-plan). The canonical pstack workflow is the t3-pstack plugin; [GRS-104](https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery) aligns the repository tooling with it. The earlier `/home/operator/.agents/skills/poteto-mode/playbooks/orchestrate.md` path and the historical sections of `docs/orchestration.md` are superseded. The coordinator integrates accepted local work. The user controls main-branch merges and deployment. The remote is `origin`; every ticket closes through a stacked PR that lands in `dev`.

Verification follows the change: deterministic checks and one independent review throughout, with real hosted and end-to-end acceptance at the relevant gates. Perf and mutation runs belong to milestone gates. A required skipped, mocked, stale or weakened check never counts as a pass.

The local baseline and its tooling already exist; accepted historical issues remain recorded. Before a new dispatch, pin the actual upstream SHA, live blockers, reserved paths and a verified test recipe. Gate and discovery owners verify their real outputs; they do not invent UI evidence.

## Program checklist

### Arm the program

- [ ] Treat this session as planning only. Start implementation when the user supplies the kickoff as an execution instruction.
- [ ] Run `scripts/agent-tools/doctor` and `scripts/agent-tools/check-plan` from the worktree before each dispatch; see `docs/agent-tooling.md`. Read the current local skills and record their paths. `origin/dev` is the integration base; use `git show origin/main:<path>` only to compare against the release branch, which changes only through user-approved merges.
- [ ] Read the orchestration, swarm, verification and relevant implementation skills before each phase. The user's no-Cursor rule and large/xhigh pstack choice override earlier high-effort defaults; Fable/Astra remain rare escalators.
- [ ] Do not arm `/loop 1h` during planning. If later authorized, use the app scheduler for an hourly audit with a status message only for material changes; T3 task completion already supplies wakeups.
- [ ] On hold, send every active writer a zero-writes instruction and preserve their artifacts.
- [x] The user approved the complete plan in GRS-69 on 17 October 2026. Hosted work now follows its native blockers, the checkpoints and the human gates; every hosted issue stays natively blocked by GRS-69.
- [ ] Use Fable or Astra only as a rare escalator for a documented blocker: create the linked Linear escalation issue before dispatch and update it after. Spend targets are reporting only. Keep bounded retries and the accepted 90-minute writing, 30-minute review and 30-minute stall-assessment controls, with declared long tests and checkpoint/cancellation evidence.

### Spawn owners

- [ ] Use one owner per implementation ticket, one worktree per writer and a complete brief. Keep the coordinator responsible for Linear and integration.
- [ ] Preserve the accepted CC-27/CC-01/CC-02/CC-23/CC-03/CC-24 local history. Do not rerun completed implementation solely to recreate the old kickoff. Reconcile remaining compatibility and evidence follow-ups against the actual accepted head.
- [ ] Hosted alpha, after GRS-69 approval: the proofs GRS-106 to GRS-111 (aggregated by GRS-26) wait for the GRS-104 tooling and the export compatibility gate GRS-24; the viewer evaluation GRS-97 waits for GRS-104. The hosted design gate GRS-27 follows them. Every implementation stage follows GRS-27: the foundation GRS-112 to GRS-118 (aggregated by GRS-36), then viewers GRS-120 to GRS-123 and Notes GRS-119. The first complete hosted PDF case workflow comes before the broad view migration: intake GRS-28, the queue GRS-135 and download GRS-29, import and editing GRS-30 and GRS-130 with the PDF/image viewer GRS-120, publication GRS-31, then the end-to-end proof GRS-137. The view groups GRS-131 to GRS-134 follow GRS-137. Notices GRS-129 and the integrations GRS-116 and GRS-124 to GRS-128, accepted by GRS-66, follow their own blockers. GRS-32 is the full-format hosted release gate and keeps all its prerequisites. Follow the native blockers, not this summary.
- [ ] Keep later work behind the alpha: standalone Markdown GRS-23 and live mailbox integration GRS-99 are later; the eval harness GRS-63 and automation GRS-33 and GRS-34 follow GRS-32.
- [ ] Follow every native Linear blocking edge and reconcile it with the local graph. A gate is not satisfied by a worker's self-report.
- [ ] Reserve actual file paths before dispatch. Limit initial writers to three; serialize shared config, schemas, navigation and persistence changes.
- [ ] Retain delegated task IDs. Fix rounds use fresh agents with the original scope, prior report and unresolved findings.

### PR mechanics, for every PR

- [ ] Push each `feature/<linear-id>-<slug>` branch to `origin` and open its PR when the ticket's evidence is complete, against `dev` at the bottom of the stack or the upstream ticket's branch for a dependent ticket, as `AGENTS.md` describes. Register every PR with T3.
- [ ] When a remote and PR workflow are authorized, use the available forge and register every PR with T3. Do not require `gt` or a nonexistent repository script.
- [ ] During authorized implementation, run lint/typecheck and relevant behavior tests before each reviewable commit. Cut unnecessary comments and prose before review.
- [ ] Keep the reviewed base revision stable through a fix round. Delegate conflicts and recheck affected evidence after integration.

### Verdict and merge, for every PR

- [ ] Record PASS, HOLD or FAIL with exact revision, commands, exit codes and artifacts. A skipped, stale or mocked acceptance check is not PASS.
- [ ] Use independent reviewers for CC-23, CC-24, CC-11, CC-25, CC-26 and CC-20. A reviewer must not approve their own implementation.
- [ ] Reconcile new heads against prior receipts. Run fresh checks for behavior changes and integration conflicts.
- [ ] Merge accepted, externally reviewed PRs serially into `dev` only under the kickoff's execution authority. Keep main unchanged.
- [ ] Collect screenshots and a video for interaction changes. The user reviews the concrete release candidate before a main merge.

### Boot recipe for real workflow verification

- [ ] Check out the exact reserved local candidate revision. Record `git rev-parse HEAD` and any uncommitted diff digest.
- [ ] Read the ticket's fixture and input-version identity. Set the documented local fixture path and fixed clock; keep case material outside Git.
- [ ] Install from the accepted lockfile and run the documented build/boot command for the target runtime. Bun/local evidence and real Workers evidence are distinct; use the appropriate environment and record readiness before driving the workflow.
- [ ] Use T3 `preview_status`, then `preview_open` if needed, followed by the available navigation and interaction tools. Follow platform fallback rules if the preview is unavailable.
- [ ] Drive controlled inputs and name the observed pass predicate. Keep private case material/screenshots in ignored local evidence only; committed/shared fixtures are synthetic. CLI work records terminal evidence; screenshots are used when they demonstrate behavior.
- [ ] Disable outbound networking for local acceptance. Use synthetic data for committed tests and keep case-bearing receipts ignored.
