# ClearCase agent instructions

Read `docs/product-brief.md`, `docs/delivery-plan.md`, `docs/orchestration.md` and `GLOSSARY.md` before work. The current repository contains planning artifacts, not an implemented app.

## Scope and evidence

- Match the v5 main HTML with 1,689 documents and 42 views first. Test the newer 2,131-document export afterwards.
- Keep `/home/operator/Work/Active/MX-two/ClearCase/RAWS/` and the hosted production system read-only.
- Keep original case files, extracted text, credentials and personal case analysis out of Git and external test services. Use local ignored fixtures and synthetic committed examples.
- The existing hosted results-import endpoint is unverified. Do not treat client upload APIs as that endpoint.
- A test that is skipped, mocked at the acceptance boundary or run against a different revision is not release evidence.

## Agent skills

Linear is the issue tracker. Read `docs/agents/issue-tracker.md`. The glossary is `GLOSSARY.md`; write ADRs under `docs/adr/` only for decisions that earn a permanent record.

Apply the installed Matt Pocock skill principles to the spec, task graph, domain language and behavior-focused tests. Apply pstack's multi-phase planning and Orchestrate disciplines with the T3 adaptations in `docs/orchestration.md`. The `to-spec`, `to-tickets` and `implement-spec` leaf skills were not found during planning; do not claim they were run or install replacements automatically.

Use the current user instructions ahead of defaults. No Cursor agents. Every Opus agent uses high reasoning effort. Other supported model families remain available for independent review; the user did not require every role to use Opus.

## Agent tooling

Start every worker or verifier session with `scripts/agent-tools/doctor`. Check the plan with `scripts/agent-tools/check-plan`, adding `--linear-relations PATH` when a Linear readback exists. Run any other check through `scripts/agent-tools/verify` or `scripts/agent-tools/receipt` so it leaves a receipt. These commands work from a clean non-interactive shell in any worktree and exit nonzero on a failure or a skipped required check. `docs/agent-tooling.md` documents sources, flags, exit codes and receipts.

## Git flow

`main` is release-only. `dev` is the integration branch. Each ticket is one `feature/<linear-id>-<slug>` branch in its own worktree, based on the accepted `dev` revision, and closes through a pull request into `dev` that an external reviewer approves. Workers commit and push their feature branch; the coordinator opens or checks the PR, links it to Linear and T3, and merges only after review. Pull requests form a stack on GitHub: the bottom PR targets `dev`, and a dependent ticket's branch is cut from its upstream ticket's accepted head with its PR targeting that upstream branch, so each layer is reviewed separately; GitHub retargets a layer to `dev` when the layer below merges. The coordinator links the layers with `gh stack link` (the official `github/gh-stack` extension) and never runs commands that rebase or force-push, such as `gh stack sync` or `gh stack rebase`; when a lower layer changes, it merges the updated upstream branch into the layers above and reruns affected checks. Everything lands in `dev`, and nothing merges into `dev` before the external reviewer approves. Nothing merges into `main`, which changes only through the user, and nobody pushes to it.

## Coordination

The coordinator owns briefs, file reservations, integration, review dispatch and Linear. Workers own one scoped ticket and one worktree each. Only the coordinator updates external issue status after checking evidence.

Use the T3 task tools for delegated agents and retain task IDs. A fresh review round gets a fresh agent and a consolidated brief. Do not launch new top-level conversations unless the user requests them.

This planning session authorizes docs, planning tools and Linear issues/milestones. It does not authorize app implementation, commits, merges, deployment or production changes. The user can grant execution authority by passing the prepared kickoff prompt to a new agent. Follow the scope of that prompt and any accompanying instructions; do not ask again for already-authorized actions.
