# ClearCase agent instructions

## Sprint mode: `sprint/hosted-demo-20261105` (28 October to 5 November 2026)
On this branch and branches cut from it, `docs/sprint/README.md` wins over everything below and over any workspace process files. Tickets are `docs/sprint/tickets/NN-*.md`, mirrored as Linear issues (project P-GRS-21, team GRS, label `sprint-hosted-demo`). `/goal finish tickets` runs the loop in `.agents/skills/goal/SKILL.md`; the rules are these.

Claim. Pick a Todo issue with the label, no assignee, every "blocked by" Done (merged into the sprint branch). Urgent first, `journey-fail` bugs before features. Assign yourself, move to In Progress, comment `claim: <model> via <harness> on <hostname>, <UTC>, branch sprint/grs-NNN-<slug>`, wait 15 s, re-read; if someone else holds it, take another. One ticket per agent. A claim with no PR and no activity for 2 hours (12 overnight) may be reclaimed with a `reclaim:` comment after a 10-minute wait. Agents write their own issue's state; the coordinator-only rule in docs/agents/issue-tracker.md is suspended for this label.

Build. Worktree on `sprint/grs-NNN-<slug>` from `origin/sprint/hosted-demo-20261105`. Edit only the ticket's reserved paths; a needed path outside them is a `blocked:` comment, not an edit. Shared files belong to the ticket that names them (docs/sprint/tickets/README.md has the table); add files, do not edit theirs. Merge commits only; never rebase, force-push, or touch `dev`, `main`, sandbox A or B. Synthetic fixtures only; real case material and secrets stay in ignored `.local/`. Commit messages end with `Co-Authored-By: <model>`.

Verify. `bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor`, then the ticket's Checks block exactly, then `scripts/preview.sh` and a 2-minute walk of the acceptance steps with timings. Paste SHA, commands, PASS or FAIL and the preview URL in the PR body. A skipped or mocked check is not a pass. Three failed attempts: label `needs-human`, comment the failures, unassign, stop.

PR and review. `gh pr create --base sprint/hosted-demo-20261105`, title `GRS-NNN: ...`. Move the issue to In Review and link the PR. Exactly one review, by an agent: no Greptile on sprint PRs (it runs only on the final sprint-to-dev PR). The builder's developer starts a fresh session on the other model family (Claude built it → Codex reviews; Codex built it → Claude reviews; Codex-only developers use a fresh thread on a different Codex model from the builder) and runs `/sprint-review <PR number>` (`.agents/skills/sprint-review/SKILL.md`). It reads the diff against the ticket's Acceptance and Forbidden sections, at most 5 findings rated High, Medium or Low, about 30 minutes, and posts them as one PR comment headed `review: <model>`. For `Security-sensitive: yes` (auth, tenancy, audit, sign-in routes, grant producers, R2 object serving) the same review also checks these four classes, probing at most 3 in a scratch checkout: wrong client (another client's Worker, bucket or database reachable); wrong case (a case without a grant reachable by id, asset URL, ticket, cache or export); capability outlives authority (ticket, cookie or URL works after expiry, revocation or sign-out); secret in a log, receipt or report. Fix Highs and Mediums in the same session and push once. No second round, no re-check. Lows go to the issue as a `follow-ups:` comment. A disputed finding goes to the owner on the issue.

Merge. When CI-lite is green at the head, the review has posted with nothing High or Medium open, and `origin/sprint/hosted-demo-20261105` is merged into your branch: `gh pr merge --merge`. Comment the merge SHA on the issue and move it to Done. Staging deploys itself; the journey check files `journey-fail` issues.

Stop and ask a human (comment on the issue, mention the owner) when: blocked over 30 minutes; the third attempt fails; a security-sensitive path is touched by a ticket not flagged for it; a check needs a secret or Cloudflare spend; anything would change `dev`, `main`, A or B. Otherwise decide, note it in the PR body, and continue.

The workspace `AGENTS.md` above this repository sets models, budgets, the build-review-fix-ship loop, Git and push rules, the Bun commands and the rules on case material; it overrides this file. This file adds what is specific to the repository.

In a clone without that workspace file, record its absence and follow this repository's available instructions and the user's current authorization. Historical references to an external hook, model sheet or run do not prove it is installed or current on this host.

## Read on demand

- `GLOSSARY.md`: the domain words. Use them in code, tests, reports and Linear text.
- `docs/development.md`: before changing the app, adding a view, or reading a gate failure. It covers the scripts, configuration and shared contracts.
- `docs/results-package.md`: before touching the converter, the package schemas or import.
- `docs/reference/parity/README.md`: before running parity or proposing an intentional-differences register entry.
- `docs/product-brief.md`: when a scope question is not answered by the ticket.
- `docs/agent-tooling.md`: when `scripts/agent-tools/` fails or a receipt is in question.
- `docs/agents/issue-tracker.md`: before writing to Linear.

`docs/kickoff-prompt.md`, `docs/context-packet.md` and the sections of `docs/orchestration.md` marked historical record the 8 October planning state. Act on the workspace `AGENTS.md` instead.

## Scope

- Match the v5 main HTML, with 1,689 documents and 42 views, first. Test the newer 2,131-document export afterwards.
- The hosted results-import endpoint is unverified. Client upload APIs are a different thing; do not treat them as that endpoint.
- Before hosted route work, reconcile the ticket's initial reservations with `deploy/client/hosted-files.json`, which currently selects `deploy/client/routes`. Resolve exact paths and shared-file ownership in the dispatch brief; a route implemented only under `src/routes` is not thereby part of the hosted artifact. Keep live scopes and their generated snapshot synchronized through the coordinator.
- Write ADRs under `docs/adr/` only for decisions that earn a permanent record.

## Case data and evidence

These hold in a clean clone, where the workspace `AGENTS.md` is absent.

- `RAWS/` (the original case archives) and the hosted production system are read-only.
- Original case files, extracted case text, private screenshots and credentials stay out of Git and out of external services, including test services. Committed fixtures are synthetic; real data stays in ignored `.local/` files.
- A test that is skipped, mocked at the acceptance boundary or run against a different revision is not evidence. Report PASS or FAIL at an exact SHA.

## Checks and local data

- A new worktree needs the coordinator's current `.local/v5-verification.json` (ignored; it locates the real v5 sample). The gate checks it before the first step and names the expected resultsVersion when it is stale.
- Start a worker or reviewer session with `scripts/agent-tools/doctor`. Run checks other than the gate through `scripts/agent-tools/verify` or `scripts/agent-tools/receipt`, so they leave a receipt.
- Stop your own gate with `bun run --bun gate --stop` and your own server with `bun run --bun start --stop` (same `PORT`). Never use `pkill` or `pkill -f`: other worktrees run the same scripts on this host.
- `bun upgrade --stable` moves Bun. Record the version it installs, then change `packageManager` in a reviewed commit. Older npm or Node instructions in planning artifacts and spike reports are superseded.
- The `to-spec`, `to-tickets` and `implement-spec` skills are not part of this project's process. Name in a report only the skills you invoked.

## Branches and stacks

- `dev` is the integration branch. `main` is release-only and changes only through the user.
- A ticket branch is cut from the wave branch `wave/<name>` its brief names, or from the upstream ticket's branch while that is unmerged. A ticket PR targets its wave branch. A wave PR targets `dev`, and nothing else targets `dev` directly.
- When a lower layer changes, merge the updated upstream branch into each layer above and rerun the affected checks. `gh stack link --base dev` links the layers. `gh stack sync` and `gh stack rebase` rebase, so they are not used.
- A wave PR merges into `dev` only when Greptile's check and CI pass at its exact head and no review finding is unresolved. Only a release PR from `dev` into `main` needs `dianbrown`'s approval, and only the user merges `main`.
