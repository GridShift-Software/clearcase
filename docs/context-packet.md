# ClearCase execution context

Planning checkpoint, 8 October 2026.

## Current state

| Item | State |
| --- | --- |
| Integration branch | `dev`, pushed to `origin` |
| Execution host | `puk`; `dev` clone `/home/vaper/Work/Active/MX-two/ClearCase/clearcase`, worktrees under `/home/vaper/Work/Active/MX-two/ClearCase/worktrees/` |
| Coordinator host | `archlinux`; `dev` checkout `/home/vaper/Work/Active/MX-two/ClearCase/worktrees/local-v1` |
| Base commit | `977dc85`, the planning checkpoint on top of `6edffe1` |
| Main checkout | `/home/vaper/.t3/projects/clearcase`, unchanged |
| Remote | `origin`, GitHub `GridShift-Software/clearcase`; PRs into `dev` |
| App code and runtime | Not implemented; no app dev server is running from this repository |
| Planning files | Committed on `dev` |
| Linear | 28 issues, seven milestones, six independent gate issues; all begin in Backlog |
| First executable work | GRS-35, pstack and verification CLI setup, then GRS-9 |
| External dependency | GRS-25, the current hosted operator results-import contract remains unverified |

The [Linear master plan](https://linear.app/vaper/document/clearcase-delivery-plan-and-acceptance-gates-518b0c44b87a) links all milestones and issues. The earlier browser audit remains a historical input and now points to that plan.

## Read first

1. `AGENTS.md` and `GLOSSARY.md`.
2. `docs/product-brief.md` and `docs/evidence.md`.
3. `docs/delivery-plan.md`, `docs/plan/work-items.json` and live Linear issue relations.
4. `docs/orchestration.md` and `docs/reviews/skill-alignment.md`.
5. The specific generated ticket brief under `docs/plan/tickets/`.

## Do not redo the completed research

The user selected the v5 main HTML as the first product reference, with 1,689 documents and 42 views. The newer September export has 2,131 rows and is tested later. The v5 manual contains stale counts.

The supplied results already contain much of the analysis shown in the current hosted frontend. The offline September HTML's final data merge matches its export. The complete processing pipeline and hosted import adapter were not recovered. Do not promise identical model-generated analysis from the prompts alone.

Knap generates Markdown from data and templates. A separate parser is needed to convert edited analysis back to structured data. The first authoring ticket proves one risk-analysis round trip; it does not build a general editing application.

The current firm-admin account exposes client intake and results viewing. `/admin` redirected to `/cases`. Public chunks and the reviewed email did not reveal the operator results-upload route. Do not guess paths or bypass roles. Local work does not depend on finding it.

Jove supplied the orchestration pattern, not ClearCase product rules. Use a coordinator, isolated writers, path reservations, independent gates, exact-revision evidence and a short recovery checkpoint. Do not import Jove's old approvals, hardware thresholds or scientific constraints.

## Preserve the working materials

RAWS is `/home/vaper/Work/Active/MX-two/ClearCase/RAWS/`. Read it without modifying it. Generate case-bearing fixtures and receipts in ignored local storage. Do not commit originals, extracted case text, credentials or private screenshots.

Referenced research aids have been preserved under ignored `.local/research/`. Their exact paths are in `docs/evidence.md`; keep them and `.audit/planning-decisions.tsv` in local backups. They are optional evidence pointers, not required runtime inputs. The implementation must be reproducible from the designated original archive and repository instructions.

## Exact next steps

Run `scripts/agent-tools/doctor` and `scripts/agent-tools/check-plan --linear-relations PATH` (see `docs/agent-tooling.md`) and inspect current Git and Linear state. CC-28 (GRS-36) now sits between the hosted design gate GRS-27 and client intake GRS-28. The planning commit exists on `dev`. Under the kickoff, initialize the coordinator's ignored state on `puk`, reserve GRS-35 and dispatch its worker, then GRS-9.

Do not start broad feature work before GRS-11 and GRS-13 pass. Do not start V2 or Pi Durable under the V1 kickoff. Keep main and production unchanged.
