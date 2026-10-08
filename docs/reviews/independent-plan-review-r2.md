# Independent plan review, round 2

Reviewed 8 October 2026 by a fresh reviewer who wrote neither the plan nor round 1. This file is the only one written. I read one Linear issue (GRS-10) and made no Linear writes. I did not execute any archive or contact production. Timebox: six minutes, so this is a targeted check and not a full re-read of the 1,189-line delivery plan.

## Verdict

**PASS.** The kickoff can go to a new coordinator. One condition applies: the parent's fresh re-read of all 26 Linear issues must finish and close the last trail row ("fresh readback pending"). Nothing below blocks GRS-9. The low-severity notes can be handled with the coordinator's existing authority.

## Checks rerun locally

| Command | Result |
| --- | --- |
| `python3 scripts/planning/check.py` | exit 0. Output: "PASS: 26 issues, 7 milestones, 42 unique owned views, acyclic dependencies, six independent gates, disjoint concurrent scopes, owned test paths, 26 Linear mappings" |
| `check.py --require-linear-ids` | exit 0, same output |
| `check.py --linear-relations .audit/linear-readback.json` | exit 0. It prints that the snapshot was read at `2026-10-08T10:48:56Z` and that the command does not fetch live data |
| `generate.py --check` | exit 0. Output: "Verified 27 planning documents" |
| `poteto-mode/scripts/check-plan.mjs docs/delivery-plan.md` | exit 0. Output: "13 PR sections, 0 problems" |
| Linear GRS-10 (read only) | Updated `10:54:22Z`. Its scope includes `package.json`, `package-lock.json`, `tsconfig.json` and `vitest.config.*`. Its acceptance requires npm check, test and measure scripts. It is blocked by GRS-9 and blocks GRS-11 |
| Jove citations in `skill-alignment.md` | All four files exist. Their lengths (65, 17, 13 and 475 lines) match the cited line ranges |
| Private identifiers | No `authuser` or email address in tracked candidates. The only hit is round 1's description of F9 |

## Status of round-1 findings

| ID | Verified repair (artifact) | Status |
| --- | --- | --- |
| F1 | CC-02 scope holds the npm/TS/Vitest toolchain (`work-items.json` CC-02; Linear GRS-10). CC-03 extends it after CC-23 | Fixed |
| F2 | `testPath` added for each unit; `generate.py:51` uses it; `check.py` rejects a test path outside the `tests/` scope. CC-01 uses `python3 scripts/fixtures/inventory.py --verify` | Fixed |
| F3 | CC-03 freezes all 42 navigation entries (`delivery-plan.md:263`). Its scope adds `svelte.config.*`, `src/app.*`, `tsconfig.json`, `vitest.config.*` and `static/**`. `orchestration.md:18` makes the coordinator serialize shared configuration during M2 | Fixed |
| F4 | Each shared document passes to its later owner along a dependency path (CC-03→CC-11, CC-10→CC-11, CC-13→CC-17 via CC-25/CC-15/CC-26/CC-16). The checker passes concurrent-overlap. View coverage is coordinator-owned; CC-01 writes `docs/reference/view-checklist.md` | Fixed |
| F5 | Flag renamed to `--require-linear-ids`. `--linear-relations` compares a snapshot, and the kickoff says it does not fetch live data | Fixed |
| F6 | Concurrent-overlap and test-path ownership checks added (`check.py`). I did not mutation-test them | Fixed (not mutation-tested) |
| F7 | Eight numbered standing orders in the kickoff | Fixed |
| F8 | CC-11 acceptance requires a second reviewer from a different family; `orchestration.md` extends the rule to CC-20 | Fixed |
| F9 | Gmail URL replaced with "not linked" text (`evidence.md`) | Fixed |
| F10 | CC-08 now depends on CC-05 and CC-07; CC-09 and CC-10 depend on CC-07. CC-01 records data sources. The coordinator must resolve the Invoice Ledger edge before M2 | Fixed (deferred to evidence, by design) |
| F11 | Lane 1 compares against the accepted `phase-1/local-workspace` base, with a fallback when that base lacks the feature | Fixed |
| F12 | Reports go under `.orchestration/reports/<planning-key>/` everywhere | Fixed |
| F13 | "The user reviews…"; pstack's "operator review" is noted as its own term | Fixed |
| F14 | Transcripts accepted for CLI lanes; CC-01 records a baseline only | Fixed. See R2 for leftover wording |
| F15 | Research copied to the ignored `.local/research/`. The kickoff names the trail and requires backing up both | Fixed. The links are absolute and machine-local, which `evidence.md` acknowledges |
| F16 | `orch` described as "available but not used"; `package-lock.json`; `python3` | Fixed |

## Remaining findings (none block handoff)

**R1. Low. `scripts/planning/__pycache__/` is present and not in `.gitignore`.** The kickoff's planning checkpoint commit could include `.pyc` files. The kickoff's "inspect the diff first" step should catch this. Adding `__pycache__/` to `.gitignore` is a one-line fix.

**R2. Low. Generic perf boilerplate remains in CLI units.** Every unit's Probe box contains "For CC-01 use the inventory command…", including CC-02 through CC-13 (`generate.py:60`). CC-01's Probe still begins with `npm run measure`, while CC-01 has no npm toolchain and the same box says to use the inventory command. CC-02's `npm run measure` is satisfiable, because GRS-10's acceptance makes CC-02 supply the measure script. CC-02 has to place that script under its own `scripts/case-package/**`, since `scripts/measure/**` belongs to CC-03. The coordinator should state that in the GRS-10 brief. CC-02's "within 1.25× the accepted median" has no accepted median on its first run; the generic Baseline box (record N/A) covers this.

**R3. Low. The Linear snapshot predates the review edits.** `.audit/linear-readback.json` was read at 10:48:56Z. The F1–F16 edits and the description sync came later (GRS-10 updated at 10:54:22Z). The `--linear-relations` PASS proves that relations and milestones matched at 10:48. It says nothing about the synced descriptions. The parent's current re-read should refresh the snapshot, or the kickoff's own reconcile step will do it.

## Decision trail review

This review is based on artifacts only. I did not have the raw authoring transcript, so I cannot confirm that the trail is complete. I can only confirm that its rows match the files.

- The original five rows and the Linear readback row are supported by `product-brief.md`, `work-items.json`, the kickoff, `skill-alignment.md`, the passing checker and `.audit/linear-readback.json`.
- The retrospective rows now record the worktree move, the v5 META/NAV inspection, the Knap and route research, and the README change. They are labelled as retrospective, which addresses round 1's gap. The Jove delegation row now carries a retained T3 task reference, which corrects round 1's note that no task ID was retained.
- The review and Linear-update rows match `plan-review-response.md` and GRS-10's update time. The final row reads "fresh readback pending". It should be closed with the parent's readback result before handoff.

## Scope and skill alignment

These all match the user's instructions:

- Local V1 through M3 only, with the v5 reference (1,689 documents, 42 views) before the 2,131-document export.
- Hosted V2 (manual admin preview and human publication) and Pi Durable stay gated at M4 to M6.
- No Cursor. Every Opus agent at high effort, and not every agent has to be Opus.
- No main merge, push or deploy, and the existing operator endpoint stays unverified.
- `to-spec`, `to-tickets` and `implement-spec` are reported as not run.
- The Jove process rules are adopted without its project-specific constraints.

I found no reason to redesign any of this.
