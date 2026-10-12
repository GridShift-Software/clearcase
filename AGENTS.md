# ClearCase agent instructions

The workspace `AGENTS.md` above this repository sets models, budgets, the build-review-fix-ship loop, Git and push rules, the Bun commands and the rules on case material; it overrides this file. This file adds what is specific to the repository.

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
- Write ADRs under `docs/adr/` only for decisions that earn a permanent record.

## Checks and local data

- A new worktree needs the coordinator's current `.local/v5-verification.json` (ignored; it locates the real v5 sample). The gate checks it before the first step and names the expected resultsVersion when it is stale.
- Start a worker or reviewer session with `scripts/agent-tools/doctor`. Run checks other than the gate through `scripts/agent-tools/verify` or `scripts/agent-tools/receipt`, so they leave a receipt.
- Stop your own gate with `bun run --bun gate --stop` and your own server with `bun run --bun start --stop` (same `PORT`). Never use `pkill` or `pkill -f`: other worktrees run the same scripts on this host.
- `bun upgrade --stable` moves Bun. Record the version it installs, then change `packageManager` in a reviewed commit. Older npm or Node instructions in planning artifacts and spike reports are superseded.
- The `to-spec`, `to-tickets` and `implement-spec` skills are not part of this project's process. Name in a report only the skills you invoked.

## Branches and stacks

- `dev` is the integration branch. `main` is release-only and changes only through the user.
- A dependent ticket's branch is cut from its upstream ticket's accepted head, and its PR targets that branch. GitHub retargets it to `dev` when the layer below merges.
- When a lower layer changes, merge the updated upstream branch into each layer above and rerun the affected checks. `gh stack link --base dev` links the layers. `gh stack sync` and `gh stack rebase` rebase, so they are not used.
- Nothing merges into `dev` before the external reviewer approves.
