# 01: Sprint operating kit
**Wave:** 0 · **Size:** 0.5 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
A colleague opens a fresh Claude Code or Codex thread on the sprint branch, types `/goal finish tickets`, and the agent claims a ticket in Linear, builds it in a worktree, opens a PR into `sprint/hosted-demo-20261105`, and CI-lite on that PR finishes in under 5 minutes. The repo text tells every agent the rules without the owner's workspace files. The hard-coded test-count guards stop failing sprint PRs that add test files. Follow-ups are comments on the Linear issue, not a shared file. The owner has a boat.dev script for heavy checks; colleagues check locally.

How: replace the short sprint block at the top of `AGENTS.md` with the full block below. Write `.agents/skills/goal/SKILL.md` (the claim → build → verify → PR → review → merge loop from `research/agent-protocol.md` sections 1–2 and 4) and symlink `.claude/skills/goal` to it, so both harnesses load `/goal`. In `.github/workflows/ci.yml` add a `check-lite` job keyed on `startsWith(github.base_ref, 'sprint/')` (steps in `research/delivery-speed.md` section 3: install, `tsc`, `svelte-check`, `check:hosted-imports`, `vitest run --changed origin/sprint/hosted-demo-20261105` plus `tests/hosted-smoke tests/publication src/lib`, `build:hosted`; `gate:hosted` only when `deploy/` or `src/lib/server` changed) and make the existing `check` job skip for those PRs. Add `.github/workflows/deploy-staging.yml` on `push` to the sprint branch that runs `scripts/deploy-staging.sh` if it exists (02 writes it) with repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and prints "no deploy script yet" otherwise. Update `tests/ci/workflow.test.ts` and `workflow-admission.test.ts` for the new triggers. Sprint mode for the count guards: `tests/parity/m2-base.test.ts` "vitest includes" and `tests/ci/pc1-vm-split-inventory.test.ts` become `it.skip` when `CLEARCASE_SPRINT=1`, which CI-lite sets; `scripts/ci/summary.ts` and `tests/ci/test-collection.test.ts` keep working (new tests go under existing globs, README table). Branch protection on `sprint/**` through `gh api`: require the `check-lite` status, block force-push and deletion, no required approvals. Add `package.json` script aliases `journeys` (`bun tests/journeys/run-all.mjs`) and `publish:shards` (`bun scripts/publish/cli.ts`) now, so 05 and 06 never edit `package.json`. Write `scripts/boat/build-golden.sh` and `scripts/boat/run-checks.sh` from `research/boat-fleet.md` sections 2 and 4, owner-only, one $20 seat, snapshot `clearcase-golden`. Create the Linear views "Sprint board", "Needs a human", "Stale claims" and the documents "Staging status" and "Human log" (`research/agent-protocol.md` section 6).
## Reserved paths (edit only these; new files under them are fine)
- `.github/workflows/`
- `AGENTS.md` (repo root), `.agents/skills/goal/`, `.claude/skills/`
- `tests/ci/`, `tests/parity/m2-base.test.ts`, `scripts/ci/summary.ts`
- `scripts/boat/`, `package.json` (scripts block only)
Shared files this ticket owns, which others must not edit until it merges: `package.json`, `.github/workflows/*`, `AGENTS.md`.
## Blocked by
- None: can start immediately
## Acceptance
- [ ] A PR into `sprint/hosted-demo-20261105` runs only `check-lite`, green in under 5 min on the pc1 runner (link the run).
- [ ] A PR into `dev` still runs the full `check` job (`tests/ci/workflow.test.ts` proves both).
- [ ] `CLEARCASE_SPRINT=1 bun run --bun test tests/parity/m2-base.test.ts tests/ci` passes with a new `tests/hosted-foundation/budget/x.test.ts` present; without the variable the counts still fail as before.
- [ ] `/goal` is listed by `claude` and by `codex` in a fresh thread at the repo root; the skill text names the claim comment format and the three-write claim.
- [ ] `gh api repos/GridShift-Software/clearcase/rules` shows the `sprint/**` rule.
- [ ] `scripts/boat/run-checks.sh --only check` exits 0 or 2 (not silently 0 without a key) on the owner's machine.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bun run --bun test tests/ci tests/parity/m2-base.test.ts
CLEARCASE_SPRINT=1 bun run --bun test tests/ci tests/parity/m2-base.test.ts
```
## Read first
`docs/sprint/README.md`; `research/agent-protocol.md` (all); `research/delivery-speed.md` sections 2–4; `research/boat-fleet.md` sections 2, 4, 5; `docs/ci-runner.md` (allowed actions, admission hook).
## Decisions already made (don't re-decide)
- Ordinary tickets get one Greptile review on PRs into `sprint/**`; security-sensitive tickets get one cross-family agent review against the four hosted classes instead. No second round.
- boat.dev: the owner alone, one seat; colleagues check locally. No org, no shared keys.
- Fonts: system stack only (not this ticket's work, but the AGENTS block must not promise Montserrat).
- Lows are `follow-ups:` comments on the issue; no `follow-ups.md`.
- `cloudflare/wrangler-action` is not an allowed action; deploy uses `bunx wrangler`.
- Paste this block into `AGENTS.md`, replacing the existing sprint block (adjusted from `research/agent-protocol.md` section 5):

```
## Sprint mode: `sprint/hosted-demo-20261105` (28 October to 5 November 2026)
On this branch and branches cut from it, `docs/sprint/README.md` wins over everything below and over any workspace process files. Tickets are `docs/sprint/tickets/NN-*.md`, mirrored as Linear issues (project P-GRS-21, team GRS, label `sprint-hosted-demo`). `/goal finish tickets` runs the loop in `.agents/skills/goal/SKILL.md`; the rules are these.

Claim. Pick a Todo issue with the label, no assignee, every "blocked by" Done (merged into the sprint branch). Urgent first, `journey-fail` bugs before features. Assign yourself, move to In Progress, comment `claim: <model> via <harness> on <hostname>, <UTC>, branch sprint/grs-NNN-<slug>`, wait 15 s, re-read; if someone else holds it, take another. One ticket per agent. A claim with no PR and no activity for 2 hours (12 overnight) may be reclaimed with a `reclaim:` comment after a 10-minute wait. Agents write their own issue's state; the coordinator-only rule in docs/agents/issue-tracker.md is suspended for this label.

Build. Worktree on `sprint/grs-NNN-<slug>` from `origin/sprint/hosted-demo-20261105`. Edit only the ticket's reserved paths; a needed path outside them is a `blocked:` comment, not an edit. Shared files belong to the ticket that names them (docs/sprint/tickets/README.md has the table); add files, do not edit theirs. Merge commits only; never rebase, force-push, or touch `dev`, `main`, sandbox A or B. Synthetic fixtures only; real case material and secrets stay in ignored `.local/`. Commit messages end with `Co-Authored-By: <model>`.

Verify. `bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor`, then the ticket's Checks block exactly, then `scripts/preview.sh` and a 2-minute walk of the acceptance steps with timings. Paste SHA, commands, PASS or FAIL and the preview URL in the PR body. A skipped or mocked check is not a pass. Three failed attempts: label `needs-human`, comment the failures, unassign, stop.

PR and review. `gh pr create --base sprint/hosted-demo-20261105`, title `GRS-NNN: ...`. Move the issue to In Review and link the PR. Exactly one review: Greptile for ordinary tickets. For `Security-sensitive: yes` (auth, tenancy, audit, sign-in routes, grant producers, R2 object serving) one agent of the other model family reads the diff against these four classes, probing at most 3 in a scratch checkout: wrong client (another client's Worker, bucket or database reachable); wrong case (a case without a grant reachable by id, asset URL, ticket, cache or export); capability outlives authority (ticket, cookie or URL works after expiry, revocation or sign-out); secret in a log, receipt or report. Fix Highs and Mediums in the same session and push once. No second round, no re-check. Lows go to the issue as a `follow-ups:` comment. A disputed finding goes to the owner on the issue.

Merge. When CI-lite is green at the head, the review has posted with nothing High or Medium open, and `origin/sprint/hosted-demo-20261105` is merged into your branch: `gh pr merge --merge`. Comment the merge SHA on the issue and move it to Done. Staging deploys itself; the journey check files `journey-fail` issues.

Stop and ask a human (comment on the issue, mention the owner) when: blocked over 30 minutes; the third attempt fails; a security-sensitive path is touched by a ticket not flagged for it; a check needs a secret or Cloudflare spend; anything would change `dev`, `main`, A or B. Otherwise decide, note it in the PR body, and continue.
```
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files beyond the goal skill; a second review round; loosening a test other than the two named count guards under `CLEARCASE_SPRINT=1`; redeploying sandboxes A or B; a `CLAUDE.md` that double-loads `AGENTS.md`; touching `deploy/` or `scripts/deploy-staging.sh` (02's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA (once 02 exists); CI-lite green on the PR itself; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
