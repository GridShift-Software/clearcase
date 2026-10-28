# Agent operating protocol for the hosted-demo sprint (research, 28 October 2026, Fable 5.1)

Read: `docs/sprint/README.md`, `state-and-process.md`, `postmortem.md`, the worktree `AGENTS.md`, the workspace `AGENTS.md`, `ORCHESTRATOR.md`, `REVIEW.md`, `orch-bin/factory` and `factory-worker/{README,SKILL}.md`, `docs/agents/issue-tracker.md`, `docs/agent-tooling.md`, `.github/workflows/ci.yml`, the `software-factory`, `to-tickets` and `implement-spec` skills, the 17 sprint issues (GRS-227 to 243) and the GRS statuses. Nothing was edited, committed or posted.

## Findings that shape the design
1. **`/goal` does not exist in T3 Code, Claude Code or Codex.** It is a Cursor command; the t3-pstack port notes "Cursor's `/goal` has no Claude Code equivalent" and substitutes standing orders plus a todolist. Ship it as a repo skill, `.agents/skills/goal/SKILL.md` (Codex reads `.agents/skills`; the repo already keeps `verify-clearcase` there), with `.claude/skills/goal` as a symlink to it so Claude Code offers `/goal` too. The skill is the loop in section 2.
2. **CI today runs `check`, the full tests and `gate:hosted` on every PR, on the owner's single pc1 runner, 30-minute timeout.** That alone breaks the 2-hour target with three developers. S0 must add a `pull_request` filter: base `sprint/**` runs `check` plus targeted tests only (CI-lite, about 6 minutes); `gate:hosted` stays for PRs into `dev`.
3. **The repo pre-push hook (`scripts/agent-tools/pre-push`) blocks only `refs/heads/feature/*`**, so `sprint/*` pushes pass with no ledger. The leak scan, `base-guard`, `REVIEW.md` and `ORCHESTRATOR.md` live only on the owner's machine. Colleagues have no leak scan: the owner runs `leak-scan.py <sprint worktree> origin/dev <sha>` on the sprint head once a day and before the sprint-to-dev PR, and the four kept hosted review classes move into the repo text (section 5).
4. **Linear state:** GRS has Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate; no Blocked. No custom views exist. `docs/agents/issue-tracker.md` says only the coordinator writes Linear status, which the sprint section must override. Linear's `gitBranchName` is `vaperizer2/grs-NNN-...`; the sprint uses `sprint/grs-NNN-<slug>`, so the PR title must carry `GRS-NNN` for Linear to link it. Confirm in S0 that the GitHub integration moves an issue to Done on a merge into a non-default branch; if not, the merger does it.
5. **Existing tickets (GRS-233 checked) already have Goal, Reserved paths, Acceptance, Size, Depends on and Read.** Missing: exact commands, the journey step and timing target, the forbidden list, the security flag and the definition of done. Section 3 adds them.
6. `orch-bin/factory` (Pi Durable, Luna to Sol, Astra review, exit 2 on needs-orchestrator) is owner-only and GPT-only; keep it as the owner's tool for Lows and integration breaks, not part of the shared protocol.

## 1 and 2. Tasks, with the software-factory questions
Services: ticket tracker Linear (project P-GRS-21, label `sprint-hosted-demo`); git host GitHub `GridShift-Software/clearcase`; orchestrator is the `/goal` loop inside each developer's T3 thread plus Linear state; runner is that developer's worktree; observability is Linear comments, the PR and the staging URL.

| Task | Trigger | Reads and writes | Triggers next | Human re-enters |
| --- | --- | --- | --- | --- |
| Claim | `/goal finish tickets`, or the previous ticket merged | Reads Todo issues with the label, unassigned, every `blockedBy` Done; picks Urgent first, then lowest key; bugs labelled `journey-fail` before features. Writes assignee, In Progress, claim comment | Implement | Never, unless no ticket is claimable (loop ends with a one-line summary) |
| Implement | Claim confirmed | Reads the ticket, `docs/sprint/README.md`, port-map sections named in the ticket. Writes a worktree on `sprint/grs-NNN-<slug>` cut from `origin/sprint/hosted-demo-20261105`, commits | Self-verify | A path outside the reserved list is needed: stop, comment `blocked: needs path <p>`, unassign after 30 min silence |
| Self-verify | Commits exist | Runs the ticket's Checks block; `wrangler preview`; a 2-minute walk of the acceptance steps on the preview URL with timings. Writes a results block (SHA, command, PASS/FAIL, URL, ms) | Open PR, or back to Implement (attempt counter +1) | Attempt 3 fails: label `needs-human`, comment the three failures, unassign, stop |
| Open PR | Verify PASS | `gh pr create --base sprint/hosted-demo-20261105`, title `GRS-NNN: <title>`, body = results block plus reserved-path diff check (`git diff --name-only origin/sprint...HEAD` all inside the list). Writes In Review, PR link on the issue, T3 `link_pull_request` | Review (CI-lite and Greptile start on their own) | None |
| Review | PR opened or pushed | Greptile reads the diff (the one review for ordinary tickets). Security tickets: one cross-family agent review against the four hosted classes instead. Writes PR comments | Fix (same session, Highs and Mediums only) then Merge; or Merge | A reviewer finding the builder disputes: comment on the issue, the owner decides |
| Merge to sprint | CI-lite green at head, the one review posted with no open High or Medium, sprint tip contained in the head | Builder's agent merges `origin/sprint` into the branch if behind (re-runs CI-lite), then `gh pr merge --merge`. Writes Done, closing comment with merge SHA | Deploy staging, then Claim | Conflict in a hot-spot file the ticket does not reserve: `fix-merge-conflicts`, and comment what moved |
| Deploy staging | Push to `sprint/hosted-demo-20261105` | GitHub Action (S0) runs `wrangler deploy` to `clearcase-staging` and re-applies the London pin. Writes the SHA to the Linear document "Staging status" | Journey check | Deploy fails: Action opens or comments a `journey-fail` issue, Urgent |
| Journey check | Staging deployed; also a 06:00 SAST clock | Astra on the owner's machine runs J1-short (sign in, case, 3 views, original, note; about 3 min) after each deploy and J1-full (with the 20-minute idle) nightly, from a South African network. Writes times and SHA to "Staging status"; on FAIL files or reopens one `journey-fail` issue naming the step | Claim picks the bug first | Owner reads the two lines each morning |

**What stops two runs doing the same work.** Linear assignment is not atomic, so the claim is three writes and one re-read: (1) `save_issue` assignee = me, state In Progress; (2) `save_comment` exactly `claim: <model> via <Claude Code|Codex> on <hostname>, <UTC time>, branch sprint/grs-NNN-<slug>`; (3) wait 15 s and `get_issue`: if the assignee is not me, or an earlier `claim:` comment names another machine, write nothing more and pick another ticket. One claim per agent at a time, and T3 `t3_thread_list` in the project shows a second local thread on the same key, which also stops a duplicate on one machine. **Stale claim:** In Progress with no linked PR and no comment, commit or push on its branch for 2 hours in working hours (12 hours overnight) may be reclaimed: post `reclaim: <same fields>, previous claim stale since <time>`, wait 10 minutes, then reassign. Never reuse the stale branch; cut a fresh one and cherry-pick only if the stale commits are pushed. **Blockers:** `get_issue includeRelations`; every `blockedBy` must be Done, and Done means merged into the sprint branch (the merger writes the merge SHA in the closing comment, so the claimer can `git merge-base --is-ancestor <sha> origin/sprint/hosted-demo-20261105`).

## 3. Ticket template (the body of every `sprint-hosted-demo` issue)
```
## Goal
One paragraph: what a client or operator can do on staging when this is done, and why the demo needs it.
## Reserved paths (edit only these; a new file under them is fine)
- `deploy/client/routes/cases/[caseId]/v/[rv]/chronology/` ...
Shared files this ticket may touch (one line each, or "none"): view registry, ViewNav, layouts, test inventory.
## Blocked by
GRS-NNN (merged SHA required before claiming). "none" otherwise.
## Acceptance (each line checkable on the preview URL or by a command)
- [ ] Journey J1 step 3 (open the chronology, click a citation): under 2 s p95 from South Africa, 1 click.
- [ ] At most 1 D1 query and 1 R2 read per page (`bun run --bun test tests/budget/<file>`).
- [ ] <behaviour>, proven by `<test file>`.
## Checks (run exactly these, paste the results block in the PR)
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bun run --bun check
bun run --bun test <paths>            # the tests this ticket adds or changes
bun run --bun check:hosted-imports    # when anything under deploy/ or src/lib/*/hosted changes
npx wrangler preview --config deploy/client/wrangler.toml   # then walk the acceptance steps, note ms
## Read first
docs/sprint/README.md; docs/sprint/port-map.md sections n; docs/adr/00xx; the Linear document "Sprint plan (read first)".
## Forbidden
Editing outside the reserved paths; touching `dev` or `main`; real case material or secrets in Git; new guards, receipts or
process files; a second review round; skipping or loosening an existing test; redeploying sandboxes A or B.
## Security-sensitive: yes | no
Yes for `src/lib/auth/`, `src/lib/tenancy/`, `src/lib/audit/`, sign-in routes, grant producers, `objects.ts`. Yes means the one
review is a cross-family agent review against the four hosted classes, not Greptile.
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J1-short passed; this issue Done
with the merge SHA in the closing comment; Lows written to `follow-ups` as a comment on this issue.
## Size
0.5 to 3 days. Larger than 3 days: split before claiming.
```

## 4. Review brake
- **One review per PR, no re-check rounds.** Ordinary tickets: Greptile on PRs into `sprint/**` (switch its dashboard on for the branch pattern in S0; it answers in minutes and needs no coordination across three machines). The builder's agent fixes anything Greptile rates high or medium in the same session, pushes once, and does not wait for a second pass; the confidence score is advisory and never gates. Security-sensitive tickets (S2, S3, and any `yes` flag): one agent of the other family reads the diff against the four hosted classes in the sprint section, up to 3 probes in a scratch checkout, at most 5 findings, 60 minutes; Carlo (Codex only) asks Dion or the owner to run it, or uses a second Codex model with a fresh thread. That review is the one review; Greptile's comments on those PRs are read but do not add a round.
- **Who merges:** the builder's own agent, once CI-lite is green at the head, the one review has posted, no High or Medium is open, and `origin/sprint` is contained in the head. Branch protection on `sprint/**`: require the `check` status, block force-push and deletion, no required approvals. Humans merge nothing by hand except the sprint-to-dev PR (owner) and `main` (user, after dianbrown).
- **Hot spots.** S5 lands the shell first and makes the registry, ViewNav and layout additive: one `view.ts` beside each route (or one line per view in a block marked by ticket key), so S6, S7a and S7b add files and never edit the shared ones. Until S5 merges, nobody else touches `src/lib/components/view-registry.ts`, `ViewNav.svelte`, `src/routes/+layout*` or `deploy/client/routes/+layout.svelte`. `tests/ci/pc1-vm-test-inventory.json` and `declared.mjs` are append-only lists; the test guards that read them are parked, so a conflict there is a one-line fix by whoever merges second. Every PR merges `origin/sprint` into its branch before opening and again before merging, so the sprint tip is always a fast-forward of a tested head. A dependent ticket (S6 on S5) may cut from S5's branch while unmerged, but its PR still targets the sprint branch and merges after S5.
- Target: ticket to merge under 2 hours. Budget: claim 2 min, build 60 to 90 min, verify 10 min, CI-lite 6 min, Greptile 5 to 10 min, fix 10 min, merge 1 min.

## 5. Repo text (replaces the current sprint block at the top of `clearcase/AGENTS.md`; 48 lines)
```
## Sprint mode: `sprint/hosted-demo-20261105` (28 October to 5 November 2026)
On this branch and branches cut from it, `docs/sprint/README.md` wins over everything below and over any workspace
process files. Tickets are Linear project P-GRS-21, team GRS, label `sprint-hosted-demo`. `/goal finish tickets`
runs the loop in `.agents/skills/goal/SKILL.md`; the rules are these.

Claim. Pick a Todo issue with the label, no assignee, every "blocked by" Done (merged into the sprint branch).
Urgent first, `journey-fail` bugs before features. Assign yourself, move to In Progress, comment
`claim: <model> via <harness> on <hostname>, <UTC>, branch sprint/grs-NNN-<slug>`, wait 15 s, re-read; if someone
else holds it, take another. One ticket per agent. A claim with no PR and no activity for 2 hours (12 overnight)
may be reclaimed with a `reclaim:` comment after a 10-minute wait. Agents write their own issue's state here; the
coordinator-only rule in docs/agents/issue-tracker.md is suspended for this label.

Build. Worktree on `sprint/grs-NNN-<slug>` from `origin/sprint/hosted-demo-20261105`. Edit only the ticket's
reserved paths; a needed path outside them is a `blocked:` comment, not an edit. Shared files (view registry,
ViewNav, layouts, test inventories) belong to the ticket that names them; add files, do not edit theirs.
Merge commits only; never rebase, force-push, or touch `dev` or `main`. Synthetic fixtures only; real case
material and secrets stay in ignored `.local/`. Commit messages end with `Co-Authored-By: <model>`.

Verify. `bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor`, then the
ticket's Checks block exactly, then `wrangler preview` and a 2-minute walk of the acceptance steps with timings.
Paste SHA, commands, PASS or FAIL and the preview URL in the PR body. A skipped or mocked check is not a pass.
Three failed attempts: label `needs-human`, comment the failures, unassign, stop.

PR and review. `gh pr create --base sprint/hosted-demo-20261105`, title `GRS-NNN: ...`. Move the issue to
In Review and link the PR. Exactly one review: Greptile for ordinary tickets; for `Security-sensitive: yes`
(auth, tenancy, audit, sign-in routes, grant producers, R2 object serving) one agent of the other model family
reads the diff against these four classes and probes at most 3 in a scratch checkout:
- Wrong client: data from another client's Worker, bucket or database reachable.
- Wrong case: a case the user has no grant for reachable by id, asset URL, alias, cache or export.
- Capability outlives authority: an asset ticket, cookie or URL still works after expiry, revocation or sign-out.
- Secret in a log, receipt or report: cookie, token, ticket or password visible in output.
Fix Highs and Mediums in the same session and push once. No second round, no re-check. Lows go to the issue as a
`follow-ups:` comment. A finding you dispute goes to the owner on the issue; do not argue in the PR.

Merge. When CI-lite is green at the head, the review has posted with nothing High or Medium open, and
`origin/sprint` is merged into your branch: `gh pr merge --merge`. Comment the merge SHA on the issue and move
it to Done. Staging deploys itself; the journey check runs itself and files `journey-fail` issues.

Stop and ask a human (comment on the issue, @mention the owner) when: blocked over 30 minutes; the third
attempt fails; a security-sensitive path is touched by a ticket not flagged for it; a check needs a secret or
Cloudflare spend; anything would change `dev`, `main`, sandbox A or B. Otherwise do not ask; decide, note it in
the PR body, and continue.
```
Claude Code already loads `AGENTS.md` in this workspace (both files appear as project instructions). If a colleague's build does not, add a one-line `CLAUDE.md`: `@AGENTS.md`. Do not add it where `AGENTS.md` loads on its own; it would load twice.

## 6. Status and visibility
- **Linear, created in S0 (none exist today):** shared views "Sprint board" (label, grouped by status, assignee shown), "Needs a human" (label `needs-human` or a `blocked:` comment in 24 h) and "Stale claims" (In Progress, updated more than 2 h ago). A project document "Staging status" with URL, deployed SHA, last J1-short and J1-full times, kept to 10 lines and overwritten by the journey check. The human log moves from the owner-only `.orchestration/human-log.md` to a Linear document "Human log", three lines per person per day.
- **Daily digest:** a scheduled T3 task on the owner's machine at 06:30 SAST posts a Linear project status update: merged yesterday (keys and SHAs), in progress (key, who, since), needs-human, staging SHA and journey times, spend. Under 20 lines. The owner reads that and the human log; nothing else is required reading.
- **What triggers a human:** `blocked:` over 30 minutes (Linear notification to the owner), a third failed attempt (`needs-human` label, unassigned), a security-sensitive path touched outside S2 or S3, a `journey-fail` issue older than 2 hours unclaimed, a reserved-path breach, any request for a secret or Cloudflare spend, and anything that would touch `dev`, `main`, A or B. Everything else is pre-approved by `docs/sprint/README.md`.

## Next step
S0 (GRS-227) carries the mechanics: CI-lite filter, `deploy-staging.yml`, Greptile on `sprint/**`, branch protection, the three Linear views and two documents, the `goal` skill, the ticket template applied to GRS-228 to 240 and the `Security-sensitive` flag on 229, 230. The AGENTS.md sprint block above is a separate 1-file PR into the sprint branch so colleagues' agents pick it up before S1 starts.
