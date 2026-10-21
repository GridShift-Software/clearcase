# Reviewer handover

This page indexes everything an external reviewer needs, in one place. It is written for `dianbrown` and any other reader of `dev` who has only a clone.

## Update, 20 October 2026 (GRS-159)

The sections up to and including the state table record the review at SHA `ff0d5d31` on 17 October and stay as recorded. Since then: Greptile's check, CI and no unresolved finding at the exact head gate `dev`, and `dianbrown` approves only a release PR into `main`; GRS-141, GRS-142, GRS-138 and GRS-106 are Done, and the synthetic hosted gate exists while every real-provider check stays UNRUN; `dev` is at `b22680f5` with the last recorded dev-gate PASS at `442adb93` and no verdict at `b22680f5`.

## The review

- **Review SHA:** `ff0d5d31fa8b0dcc46b8062ca6e5fcdb91436bbd`. It is the content commit of branch `feature/grs-69-docs-consistency`, cut from `dev` at `8fc2058`; the next commit changes only this line. After the merge, review `dev` at the merge commit.
- **The opinion asked for:** is the plan, the verification model and the operating rules sound before kickoff? Say what you would change, and say which findings you would block on.
- **What this is not:** runtime acceptance. Every hosted implementation, runtime and provider check is UNRUN. The approval below approves the written plan only.

## Where the operative rules live

| Rule set | Location | In the clone? |
| --- | --- | --- |
| Workspace `AGENTS.md` (roles, models, loop, git, checks) | `/home/operator/Work/Active/MX-two/ClearCase/AGENTS.md` | No. Full 17 October text in Appendix A. |
| Workspace `ORCHESTRATOR.md` (waves, PRs, human gate, morning update) | `/home/operator/Work/Active/MX-two/ClearCase/ORCHESTRATOR.md` | No. Full 17 October text in Appendix B. |
| Repository instructions | `AGENTS.md` | Yes |
| Plan, owners and wave map | [operating plan](agent-delivery-operating-plan.md), [delivery plan](../delivery-plan.md) | Yes |
| Verification model, Cloudflare matrix, severity mapping | [verification and review](verification-and-review.md) | Yes |
| Acceptance baseline | [hosted-alpha acceptance](hosted-alpha-acceptance.md) | Yes |
| Decisions | [ADR index](../adr/README.md) | Yes |
| Domain words | [glossary](../../GLOSSARY.md) | Yes |

The workspace files hold no secrets and are reproduced unedited in the appendices. [`docs/orchestration.md`](../orchestration.md) is a historical record; its banner names the current entrypoints. The current pstack model sheet is `.orchestration/pstack-models.md`, written at `~/.config/t3-pstack/models.md`, and is quoted in the operating plan.

## Approvals and decisions

| Decision | Reference |
| --- | --- |
| The user approved the complete written plan, 17 October 2026 at 14:20 SAST | GRS-69 comment `45db4bdd-c268-4f6b-8658-cc2edb77bc6a`. GRS-69 and GRS-94 are Done. |
| Large/xhigh preset and session hook on | GRS-94 decision comment `68ef42c3-ac86-4a1c-b7f6-ef908922859e` |
| Final workflow scenarios, including the GRS-137 tracer bullet | GRS-136 decision comment `f9705162-0911-492f-8684-4db568edefa7` |
| Bounded escalation and initial roles | GRS-94 decision comment `410c1a45-c3d6-4359-acb4-bc5281a69201` |
| Spend reporting-only and shared Rescan & Update | `045279af-b2f6-4867-b17f-c9017593cae3` |
| Cloudflare pinned until the user unpins it | GRS-26 decision `d6367d1a` |

### The unpin decision

Cloudflare account, domain and provider work is pinned. The unpin is the user's decision alone. Until then local proof legs may run, and any leg that needs a real provider, a Paid plan or a credential is HOLD, never a mock PASS. Once unpinned, the ceiling is USD 25 a month with an alert at USD 10, and credentials reach a run only through the secret path designed under GRS-107. GRS-105 (PC2) is no-go. The matrix is in [verification and review](verification-and-review.md#4a-cloudflare-pin-and-proof-dispositions).

## Waves and checkpoints

At most seven writers per wave. Ticket PRs target their wave branch; only wave PRs target `dev`. Since 20 October 2026 Greptile reviews each wave PR, which merges when Greptile's check and CI pass at its exact head with no finding unresolved; `dianbrown` approves only release PRs into `main`. Appendix A keeps the 17 October rules as they were. At each checkpoint the user reads the aggregate report and drives the verification skill once.

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

GRS-137 is the tracer bullet. It runs directly after GRS-36 and GRS-138 and before the thick workflow owners, and proves one small synthetic PDF case. The human processing gate applies to GRS-137, GRS-29 and the release gate GRS-32 alike: the worker stops with `AWAITING MANUAL RESULTS` and names the submission manifest and download path, the user runs the recipe in their own chat, and a fresh session resumes.

## Evidence ledger

The ignored `.orchestration/` folder holds the artifacts named below. Ask the coordinator for any of them; none contains case material.

| Area | State | Exact revision and source |
| --- | --- | --- |
| Local runtime, planning documents | `check`, `test`, `generate.py --check` and the graph fixtures PASS on this branch | The content commit above; run by the author of this branch, with the commands in its report |
| Local runtime, pilot harness | PASS: gate green at `73025c3` (GRS-143), pilot 18/18 | `.orchestration/reports/GRS-143/report.md` |
| Local runtime, parity repair | PASS at `78c0516` (GRS-141), parity 0 unregistered; the full gate there failed only at `verify:pilot:v5`, which GRS-143 repairs | `.orchestration/reports/GRS-141/report.md` |
| Wave review | APPROVE WITH P2s, no P0 or P1, at wave head `2117c37` (`wave/preflight-parity`); not a gate run | `.orchestration/reports/WAVE-PREFLIGHT-REVIEW-CODEX/review.md` |
| Dev gate | FAIL at `c89d405` at strict parity (two demo-merge subtitles). App code is unchanged at `8fc2058`, which has no gate receipt. The repair, GRS-141, GRS-143 and GRS-142, is in flight on `wave/preflight-parity` | `.orchestration/dev-gate/8ab9ef40ebe95ff4f8fc2665ffc85e4d941c1fd6` |
| Test doubles | None built yet. GRS-138 will land the workerd gate with local D1 and R2 bindings, a test-mode identity and an email sink, each named as a double in its summary | UNRUN |
| Real providers (Clerk, D1, R2, email, Cloudflare account) | UNRUN and HOLD while Cloudflare is pinned | Owners GRS-106 to GRS-111 and GRS-32 |
| Hosted runtime acceptance | UNRUN | GRS-32 |

### Codex reports

All are ignored files under `.orchestration/reports/`, written on 17 October 2026 against `dev` at `8fc2058` under the user's scoped authorization for Codex that day. None changed the repository.

| Path | One-line summary |
| --- | --- |
| `CODEX-DOCS-CONSISTENCY-20261017/report.md` | Documentation consistency review: FAIL, 19 contradictions (C01 to C19) and stale statements; this branch is the repository-side fix. |
| `CODEX-HOSTED-GATE-DESIGN-20261017/design.md` | GRS-138 hosted gate design: DESIGN READY; implementation and acceptance UNRUN. |
| `CODEX-HOSTED-THREAT-MODEL-20261017/report.md` | Hosted threat model: HOLD for security-design closure; all probes UNRUN. |
| `CODEX-LOCAL-WORKERD-20261017/report.md` | Local workerd toolchain spike on synthetic data: PASS for the toolchain; GRS-106, GRS-112 and GRS-138 acceptance stays HOLD. |
| `CODEX-PONYTAIL-AUDIT-20261017/report.md` | Whole-repository over-engineering audit: worthwhile simplifications; no fixes applied. |
| `CODEX-REVIEW-MD-HOSTED-20261017/review-md-hosted-section.md` | Draft hosted section for the `REVIEW.md` bug classes; proposals only, probes unrun. |
| `CODEX-SECRET-PATH-DESIGN-20261017/design.md` | Secret path design (`orch-bin/cloud-guard`): design delivered; implementation and credential-boundary proofs HOLD. |
| `CODEX-SYNTHETIC-CORPUS-20261017/report.md` | Synthetic corpus generator spike: PASS as a local proof against the exported app at `8fc2058`; not a gate run. |
| `WAVE-PREFLIGHT-REVIEW-CODEX/review.md` | Review of the preflight wave head `2117c37`: APPROVE WITH P2s. |

## Known open items

- The generated delivery plan still prints a few sentences from the generator (`scripts/planning/generate.py`), such as "each Backlog and natively blocked by GRS-69". The status columns are the morning readback and are refreshed with the next one. The coordinator owns both.
- Eleven open ticket briefs carry the old "every Opus agent uses high" boundary line in their Linear text. The workspace table overrides it; the next readback refresh normalizes it.

## Appendix A. Workspace `AGENTS.md`, 17 October 2026

~~~~markdown
# ClearCase workspace instructions

Updated 17 October 2026. Every session under this directory loads this file: the orchestrator, and every worker and reviewer in `worktrees/`. Where they conflict, it overrides `clearcase/AGENTS.md`, `clearcase/docs/orchestration.md`, the archived standing orders in `clearcase/.orchestration/preferences.md`, and any brief, resume text or handoff written before 11 October, such as "effort xhigh" or "subagents at xhigh".

The repository is `clearcase/`. Otherwise follow its own instructions and path reservations.

## Rules for everyone

- `RAWS/` and the hosted production system are read-only.
- Case material, extracted case text, private screenshots and secrets stay out of Git and external services. Committed fixtures are synthetic.
- Bun 1.4.2 builds and runs the app (user requirement, 8 October):
  - `packageManager: bun@1.4.2`, `bun.lock` and `bun install --frozen-lockfile`;
  - app scripts run as `bun run --bun <script>`;
  - the local product's supported entry point is `bun run --bun start` (the built `build/index.js` refuses to run directly by design, see `docs/development.md`), with SQLite verified under Bun; the hosted product runs on Cloudflare Workers per ADR 0008, built with Bun and served by workerd, with Wrangler hosted by Node.

  Node evidence is not Bun evidence.
- Git:
  - one `feature/<linear-id>-<slug>` branch per ticket, each in its own worktree under `worktrees/`, cut from the wave branch your brief names (or from the upstream ticket's branch while that is unmerged);
  - a ticket's PR targets its wave branch `wave/<name>`; the wave branch's PR targets `dev`; nothing targets `dev` directly except a wave branch;
  - merge commits only, and never rebase, force-push or touch `main`;
  - end commit messages with a `Co-Authored-By:` line naming your own model.
- Don't edit another active worker's worktree or files.
- A skipped or mocked check, or one run at a different revision, is not a pass. Report PASS or FAIL at an exact SHA.
- Product-visible register entries keep `approvedBy: null` until the user approves them in a PR.
- No Cursor, no UltraCode, and never effort `max`. No Codex, except `gpt-6-astra` as the recorded rare escalator (see the table).
- Never run the processing recipe (the prompts over case documents) under any ticket. It is a human gate: stop with `AWAITING MANUAL RESULTS`, name the submission manifest and download path in your report, and let the user run it in their own chat.

## Models and budgets

| Role | Model | Effort | Target USD |
| --- | --- | --- | --- |
| Orchestrator (T3 thread) | `claude-opus-5-5` | high | – |
| First implementation of a ticket | `claude-opus-5-5` | xhigh | 20 |
| Diff review | `claude-opus-5-5` | xhigh | 6 |
| Re-check of a fix round's diff | `claude-opus-5-5` | high | 2 |
| Fix round from a written defect list; merges; PR and Linear text | `claude-sonnet-5-5` | high | 8 |
| A high that survived the fix round | `claude-opus-5-5` with `diagnosing-bugs` | xhigh | 12 |
| Rare escalation after that, only with a linked Linear escalation issue | `claude-fable-5-1`, or `gpt-6-astra` by explicit per-task choice | xhigh | 12 |
| Research and decision sessions with the user | `claude-opus-5-5` | high | 6 |
| Running checks, reading logs | a script | – | 0 |

Targets are reporting-only (user decision, 16 October): overspend never pauses or cancels work by itself. Attempts are bounded instead: one fix round, one re-check, one escalation, one transient infrastructure retry; the same failure twice without a new diagnosis stops the unit.

Set model and effort explicitly on every launch, including subagents. Nothing inherits the orchestrator's settings.

## Context

- Every session compacts at 200k tokens. `.claude/settings.json` at the workspace root sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` for the orchestrator and its T3 tasks, and the headless resume scripts set it themselves.
- One session per stage. New work starts a fresh session from a one-page brief plus `git log` and `git diff`. Resume an old session only to finish a stage that depends on its state, such as the prepared R2f, r3 and SPINDOWN resumes. Under the 200k window it should compact on its first turn.
- Never read screenshots, full test logs or whole reports into context. Use `tail -40`, `grep` and the summary lines.
- Briefs fit on one page: the Linear issue, branch and base SHA, what to change, when it's done, and the report path. Don't paste standing orders; this file is already loaded.
- Reports stay under 40 lines: verdict, SHA, check summary, findings and follow-ups.

## Checks

- **One command runs the checks:** `bun run --bun gate`. It prints a short pass/fail summary. It runs `check`, `test`, `test:e2e`, strict `parity --all` and `verify:pilot:v5`, in that order. Mutation and perf runs are for milestone gates only. Scale checks to the change: a ticket that touches `src/`, `scripts/`, `tests/` or `static/` runs the gate; a docs-only or planning-only ticket runs `check` and `test` plus `check-plan`; a hosted ticket also runs `gate:hosted` once it exists.
- **Browser jobs** take one of two slots through `orch-bin/browser-lock <command>`, which also waits for free memory. Use `browser-lock --exclusive` to take both slots for an evidence run.
- **Stop your own runs** with `gate --stop` or `start --stop`. Never `pkill` by command line, because other worktrees run the same scripts.
- **User paths:** `clearcase/.agents/skills/verify-clearcase` drives the real app offline on synthetic data in about 7 seconds. Use it to prove a user path works.
- **Bug classes:** `REVIEW.md` lists the server-side and UI classes that reviews kept missing, with a probe for each. Before you hand in, check your forms, registers and write paths against it.
- **Hosted checks:** once GRS-138 lands, `bun run --bun gate:hosted` is the required check for any ticket touching hosted paths, and `clearcase/.agents/skills/verify-clearcase-hosted` proves a hosted user path. A summary that names a test double for a boundary is not evidence for that boundary; real Clerk, D1, R2 and email evidence comes only from the proof tickets and the release gate.
- **Test protection:** a fix diff that deletes, skips, loosens or renames a test named in the findings fails its re-check. Write the failing test first, then the fix, so the sequence reads red then green.

## The loop for each ticket

1. **Build.** One worker implements in a fresh session, runs `gate` until it is green, commits and writes its report.
2. **Review.** One fresh reviewer reads only the diff against the base, the Linear issue and `REVIEW.md`, using the `code-review` skill. It runs up to 3 throwaway probe tests, and returns high, medium and low findings on one page.
3. **Fix.** At most one fix round, on Sonnet, for highs and mediums. It fixes each finding's whole class across the branch (see `REVIEW.md`), and a fresh reviewer re-checks only the fix diff. Lows become a Linear follow-up comment. A high that survives the fix round gets one Opus xhigh round with `diagnosing-bugs`; if it still fails, it goes to the user.
4. **Ship.** Leak scan, push, PR into the wave branch. The orchestrator merges it when the fresh re-check approves and the gate is green at the head. When the wave's aggregate ticket is accepted, the orchestrator opens one PR from the wave branch into `dev`, links it on the aggregate and requests `dianbrown`. His findings get one fix round per owner on the wave branch, then he is re-requested. The wave merges into `dev` when his latest review on the wave head approves. Nobody is pinged outside the morning update.

Waves and checkpoints: a wave is the set of tickets under one `checkpoint` aggregate in Linear (GRS-27, GRS-36, GRS-137, GRS-66, GRS-32), at most seven tickets, on one branch `wave/<name>`. At a checkpoint the user reads the aggregate report and drives the verification skill once; the external reviewer reviews the wave PR in one sitting. Agents run unattended between checkpoints and stop, with `status.md` written, when only checkpoint-blocked work remains.

Not allowed:
- verification lanes, adversarial swarms and critic panels;
- brief drafters, or any agent writing briefs for other agents;
- the `swarm`, `arena`, `interrogate` and `reflect` skills, and the Workflow tool.

Each of these fans out many agents.

## Codebase discovery

Workers kept re-deriving the architecture from scratch, and that re-reading was 60% of the 8–10 October spend. Don't. In order:

1. `clearcase/docs/development.md` (stack, commands, architecture, shared contracts, adding a view) and `clearcase/GLOSSARY.md`. These are the map; trust them over your own exploration unless a check contradicts them.
2. Your ticket's generated brief under `clearcase/docs/plan/tickets/<planning-key>.md`, the Linear issue, and the upstream ticket's report that your brief points at.
3. The ADRs under `clearcase/docs/adr/` for the area you touch, and `clearcase/docs/results-package.md` if you touch the package or import.
4. When `clearcase/graphify-out/` exists, query it (`graphify` skill) before grepping.

Search with the `fff` MCP tools (`ffgrep`, `fffind`, `fff-multi-grep`) for every file or content search in the repository; they are faster and cheaper than the built-in tools. Read whole files only when you will edit them.

What you learn that the map lacks goes in a `Map notes` section of your report (at most 10 lines: where a contract lives, a gotcha, a wrong sentence in the docs). The orchestrator folds accepted notes into `docs/development.md` at the wave boundary, so the next worker does not pay for the same discovery.

## Workers and reviewers

- Do only your brief. Stay in your worktree and reserved paths. Put shared-file requests in your report.
- T3 tasks start at the workspace root. `cd` to the worktree your brief names before you do anything else.
- Only the orchestrator updates Linear, opens PRs and merges.
- Run subagents in the foreground: headless `claude -p` kills background subagents 10 minutes after the last turn.
- Write the report at the path the brief names before you exit, even on failure or when the budget runs out. End with a final message of at most 10 lines: verdict, head SHA, check summary and the report path.

## Orchestrator

The orchestrator reads `ORCHESTRATOR.md` at start-up.

## Skills

- **Invoke directly:**
  - `code-review` for the diff review;
  - `diagnosing-bugs`;
  - `ponytail` and `ponytail-review` for the smallest change;
  - `simplify`;
  - `security-review` on hosted tickets;
  - `grilling` for decision sessions with the user;
  - `prototype`, `research`, and `graphify` for a codebase map.
- **Slash-only:** read `~/.claude/skills/<name>/SKILL.md` and follow it when needed:
  - `correct`, to turn a bug class into a test;
  - `tdd`;
  - `handoff` and `recall` for spin-down and restart;
  - `unslop` and `technical-writing` for PR bodies and Linear text;
  - `principle-attack-the-premise`, after two failed fixes on the same premise.
~~~~

## Appendix B. Workspace `ORCHESTRATOR.md`, 17 October 2026

~~~~markdown
# Orchestrator instructions

Read at start-up by the orchestrator thread only. Workers and reviewers don't need it. Moved out of `AGENTS.md` on 12 October 2026 so that worker sessions don't load it. Updated 17 October 2026 for waves, checkpoints and the morning update.

Why the rules are strict: the 8–10 October runs cost about $2,100 at API list prices for about 23k lines of app code. About three quarters went on verification lanes, fix rounds and coordination, and 60% on re-reading 200k–960k-token contexts on every turn. So: build once, let scripts check, review the diff once.

You coordinate. You don't implement, verify or read raw logs. Linear (project "ClearCase - Realignment") holds the remaining work. `clearcase/.orchestration/status.md` holds what is running, what is next, open decisions and blockers. Read it at start-up, and overwrite it when you hand off.

- **Launch work with T3 `delegate_task`:**
  - mode async, runtimeMode full-access, role implementation or review;
  - a `target` with `claudeAgent`, the model and the effort from the `AGENTS.md` table (`{"id":"effort","value":"xhigh"}` for builds and reviews, `high` for re-checks, fixes and research);
  - a one-page brief that names the worktree's absolute path.

  Then end your turn: completion wakes you. Don't use the Agent or Workflow tools, because T3 runs their children at this thread's effort.
- **Budgets:** targets are reporting-only (user decision, 16 October). T3 tasks have no spend cap. The historical headless resume scripts carry `--max-budget-usd` caps from the M2 run; those caps are not policy.
- **Headless resumes (historical):** the prepared M2 sessions in `clearcase/.orchestration/logs/*.resume.sh` continue a `claude -p` session by id. They are finished; do not resume them for hosted work.
- **Limits:** at most 3 workers at once, because of RAM and the two browser slots. When the usage window is nearly used, launch nothing new, let running work finish, write `status.md` and stop until the reset.
- **Fix rounds:**
  - Brief template: `clearcase/.orchestration/briefs/PRFIX.md`.
  - After each fix round, launch one fresh re-check of the fix diff only, against `REVIEW.md`.
- **Push:**
  1. `python3 -I orch-bin/leak-scan.py <worktree> origin/dev <sha>` must print CLEAN.
  2. `touch clearcase/.orchestration/push-approved/<sha>`.
  3. Push. The pre-push hook blocks feature branches without that approval.
- **Waves:** before a wave starts, cut `wave/<name>` from `dev` at the accepted head and name it in every brief of that wave (`wave/proofs` for GRS-26 and GRS-97, `wave/foundation` for GRS-36, `wave/first-workflow` for GRS-137, `wave/widen` for GRS-66, `wave/release` for GRS-32). At most seven tickets per wave.
- **Ticket PRs:**
  - base the wave branch. A dependent ticket's branch may be cut from its upstream ticket's branch for ancestry, but its PR still targets the wave branch, never the upstream branch or `dev`;
  - `link_pull_request`, and link the PR in Linear;
  - merge into the wave branch (merge commit) when the fresh re-check approves and the gate is green at the head. No external review at this level.
- **Wave PRs:**
  - when the aggregate ticket is accepted, open one PR `wave/<name>` into `dev`, link it on the aggregate, request `dianbrown`, then `watch_pull_request`;
  - his findings become one fix round per owner on the wave branch (PRFIX brief), then one re-request;
  - merge into `dev` when his latest review on the wave head approves.

  Stacked merges follow memory `gh-stack-merge-rebases`.
- **Checkpoints:** GRS-27, GRS-36, GRS-137, GRS-66 and GRS-32 carry the `checkpoint` label. At each: write `status.md`, post the aggregate report and the wave PR link in the morning update, and stop dispatching new work once only checkpoint-blocked units remain. Do not ping the user or the reviewer directly.
- **Human gate in GRS-137 and GRS-29:** the processing recipe is the user's own run. When a worker reports `AWAITING MANUAL RESULTS`, record the manifest and download path on the ticket, put it in the morning update, and resume with a fresh session once the user names the package path.
- **Morning update:** a scheduled task at 08:30 SAST on weekdays posts one Linear project status update: wave PRs awaiting the external reviewer, checkpoints and human gates awaiting the user, blocked or stalled units, spend to date from `spend.tsv`. That is the only routine human notification. A stop line (standing orders) is the only exception.
- **Map maintenance:** at each wave boundary, fold the accepted `Map notes` from worker reports into `clearcase/docs/development.md` in one Sonnet docs ticket, and regenerate `graphify-out/` on `dev` if it exists.
- **After each merge to dev:** run `orch-bin/dev-gate <sha>` (verdict in `clearcase/.orchestration/dev-gate/<sha>`) and cite it in the next briefs. Run `orch-bin/spend-t3` to append T3 costs to `spend.tsv`.
- **Linear:** the morning update replaces per-event status updates. Post an extra one only for a stop line or a checkpoint that opened.
- **Hand off** at each phase end: write `status.md` and tell the user to start a fresh orchestrator thread.
~~~~
