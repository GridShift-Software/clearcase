---
name: goal
description: "Sprint loop for the hosted-demo sprint: `/goal finish tickets` claims the next claimable Linear issue (project P-GRS-21, label sprint-hosted-demo), builds it in a worktree, verifies it, opens a PR into sprint/hosted-demo-20261105, gets the one agent review, merges, then claims the next. Use on the sprint branch when asked to finish tickets, take the next ticket or run the sprint loop."
---

# goal: finish tickets

The rules live in the "Sprint mode" block of `AGENTS.md`; `docs/sprint/README.md` wins over everything else. This file is the loop. Run it until no ticket is claimable, then end with a one-line summary. Linear is reached through the Linear tools your harness has (`list_issues`, `get_issue`, `save_issue`, `save_comment`).

## 1. Claim (three writes and a re-read; Linear assignment is not atomic)
1. List issues in team GRS, project P-GRS-21, label `sprint-hosted-demo`, state Todo, no assignee. For each, `get_issue` with relations: every "blocked by" issue must be Done, and Done means its merge SHA (in its closing comment) is an ancestor of `origin/sprint/hosted-demo-20261105` (`git merge-base --is-ancestor <sha> origin/sprint/hosted-demo-20261105`).
2. Pick by priority (Urgent first), `journey-fail` bugs before features, then the lowest key. Nothing claimable: stop.
3. Write 1: `save_issue` assignee = me, state In Progress.
4. Write 2: `save_comment` exactly `claim: <model> via <Claude Code|Codex> on <hostname>, <UTC time>, branch sprint/grs-NNN-<slug>`.
5. Write 3: wait 15 seconds, then `get_issue` and `list_comments`. If the assignee is not you, or an earlier `claim:` comment names another machine, write nothing more and pick another ticket.
6. One ticket per agent at a time. A claim with no PR and no comment, commit or push on its branch for 2 hours (12 overnight) is stale: comment `reclaim: <same fields>, previous claim stale since <time>`, wait 10 minutes, re-read, then reassign. Never reuse the stale branch; cut a fresh one.

## 2. Build
1. `git fetch origin && git worktree add ../<slug> -b sprint/grs-NNN-<slug> origin/sprint/hosted-demo-20261105`. Work only inside that worktree.
2. Read `docs/sprint/README.md`, the whole ticket `docs/sprint/tickets/NN-*.md` and its "Read first" files. The ticket's reserved paths, acceptance, checks, decisions and forbidden list bind you.
3. Edit only the reserved paths. A path you need outside them is a comment `blocked: needs path <p>` on the issue, not an edit. If nobody answers in 30 minutes, unassign and stop. Shared files belong to the ticket that names them: add files, do not edit theirs.
4. Merge commits only; never rebase or force-push; never touch `dev`, `main`, or sandbox A or B. Synthetic fixtures only; real case material and secrets stay in ignored `.local/`.
5. Commit messages end with `Co-Authored-By: <your model name> <noreply@anthropic.com>` (or the harness's own trailer).

## 3. Verify
1. `bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor`.
2. The ticket's Checks block, exactly, at the final head. Record each command with PASS or FAIL. A skipped or mocked check is not a pass.
3. `scripts/preview.sh` (when the ticket's checks name it) and a 2-minute walk of the acceptance steps on the preview URL, with timings.
4. `git merge origin/sprint/hosted-demo-20261105` into your branch so the PR shows only your diff, and rerun what the merge touched.
5. Three failed attempts at the same check: label the issue `needs-human`, comment the three failures, unassign, stop.

## 4. PR
1. `gh pr create --base sprint/hosted-demo-20261105 --title "GRS-NNN: <ticket title>"`. The body gives the head SHA, each check command with PASS or FAIL, what did not run and why, and the preview URL. End it with the attribution line your harness requires.
2. Move the issue to In Review and link the PR. CI-lite (`check-lite`) starts on its own and should finish in under 5 minutes.

## 5. Review (one, by an agent of the other model family)
Claude built it, Codex reviews; Codex built it, Claude reviews. A Codex-only developer uses a fresh thread on a different Codex model. The builder's developer starts that fresh session and runs `/sprint-review <PR number>` (`.agents/skills/sprint-review/SKILL.md`). It posts one `review: <model>` PR comment with at most 5 findings.
- Fix every High and Medium in this same session and push once. No second round, no re-check.
- Lows go to the issue as one `follow-ups:` comment.
- A finding you dispute goes to the owner as a comment on the issue, not an argument in the PR.

## 6. Merge
When `check-lite` is green at the head, the review has posted with nothing High or Medium open, and `origin/sprint/hosted-demo-20261105` is merged into your branch: `gh pr merge --merge`. Comment the merge SHA on the issue and move it to Done. Staging deploys itself. Then go back to step 1.

## Stop and ask a human
Comment on the issue and mention the owner when: blocked over 30 minutes; the third attempt fails; a security-sensitive path (auth, tenancy, audit, sign-in routes, grant producers, R2 object serving) is touched by a ticket not flagged for it; a check needs a secret or Cloudflare spend; anything would change `dev`, `main`, A or B. Otherwise decide, note it in the PR body and continue.
