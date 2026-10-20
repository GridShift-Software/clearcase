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
