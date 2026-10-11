# ClearCase agent instructions

Read `docs/product-brief.md`, `docs/delivery-plan.md`, `docs/orchestration.md` and `GLOSSARY.md` before work. The workspace `AGENTS.md` above this repository (models and effort, budgets, the build-review-fix-ship loop, git and push rules) overrides this file and `docs/orchestration.md` where they conflict.

## Scope and evidence

- Match the v5 main HTML with 1,689 documents and 42 views first. Test the newer 2,131-document export afterwards.
- Keep `/home/vaper/Work/Active/MX-two/ClearCase/RAWS/` and the hosted production system read-only.
- Keep original case files, extracted text, credentials and personal case analysis out of Git and external test services. Use local ignored fixtures and synthetic committed examples.
- The existing hosted results-import endpoint is unverified. Do not treat client upload APIs as that endpoint.
- A test that is skipped, mocked at the acceptance boundary or run against a different revision is not release evidence.

## Checks

`bun run --bun gate` is the one command that runs the checks (details in `docs/development.md`). Run it until it is green, and report PASS or FAIL at the exact SHA it printed.

## App toolchain

Use Bun for application dependency installation, scripts, builds and the local server. The user selected Bun on 8 October 2026. The verified stable version on this host is 1.4.2. Pin `packageManager` to `bun@1.4.2`, commit `bun.lock`, install with `bun install --frozen-lockfile` and run app scripts with `bun run --bun <script>`. Launch the production entry point with Bun. Verify SQLite and server compatibility under Bun before accepting the pilot. Update Bun with `bun upgrade --stable` and record the installed version before changing its pin. This supersedes older npm/Node toolchain instructions in planning artifacts and spike reports.

## Agent skills

Linear is the issue tracker. Read `docs/agents/issue-tracker.md`. The glossary is `GLOSSARY.md`; write ADRs under `docs/adr/` only for decisions that earn a permanent record.

Apply the installed Matt Pocock skill principles to the spec, task graph, domain language and behavior-focused tests. Apply pstack's multi-phase planning and Orchestrate disciplines with the T3 adaptations in `docs/orchestration.md`. The `to-spec`, `to-tickets` and `implement-spec` leaf skills were not found during planning; do not claim they were run or install replacements automatically.

Use the current user instructions ahead of defaults. No Cursor agents. Models, effort and budgets per role come from the table in the workspace `AGENTS.md`; set them explicitly on every launch.

## Agent tooling

Start every worker or verifier session with `scripts/agent-tools/doctor`. Check the plan with `scripts/agent-tools/check-plan`, adding `--linear-relations PATH` when a Linear readback exists. Run any other check through `scripts/agent-tools/verify` or `scripts/agent-tools/receipt` so it leaves a receipt. These commands work from a clean non-interactive shell in any worktree and exit nonzero on a failure or a skipped required check. `docs/agent-tooling.md` documents sources, flags, exit codes and receipts.

## Git flow

Nothing merges into `main`, which is release-only and changes only through the user. `dev` is the integration branch, and everything lands there. Each ticket is one `feature/<linear-id>-<slug>` branch in its own worktree and closes through a pull request that an external reviewer approves. Workers commit and push their feature branch; the coordinator opens or checks the PR, links it to Linear and T3, and merges only after review. Pull requests form a stack on GitHub: the bottom branch is based on the accepted `dev` revision and its PR targets `dev`; a dependent ticket's branch is cut from its upstream ticket's accepted head and its PR targets that upstream branch, so each layer is reviewed separately. GitHub retargets a layer to `dev` when the layer below merges. The coordinator links the layers with `gh stack link --base dev` (the official `github/gh-stack` extension) and never runs commands that rebase or force-push, such as `gh stack sync` or `gh stack rebase`; when a lower layer changes, it merges the updated upstream branch into the layers above and reruns affected checks. Nothing merges into `dev` before the external reviewer approves. Nobody pushes to `main`.

## Coordination

The coordinator owns briefs, file reservations, integration, review dispatch and Linear. Workers own one scoped ticket and one worktree each. Only the coordinator updates external issue status after checking evidence.

Use the T3 task tools for delegated agents and retain task IDs. A fresh review round gets a fresh agent and a consolidated brief. Do not launch new top-level conversations unless the user requests them.

This planning session authorizes docs, planning tools and Linear issues/milestones. It does not authorize app implementation, commits, merges, deployment or production changes. The user can grant execution authority by passing the prepared kickoff prompt to a new agent. Follow the scope of that prompt and any accompanying instructions; do not ask again for already-authorized actions.
