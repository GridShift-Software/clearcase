# Response to the independent plan review

All findings from `independent-plan-review.md` were addressed before handoff. These are planning repairs; no application implementation or commits have started.

| Finding | Resolution |
| --- | --- |
| F1 | CC-02 owns the initial npm, TypeScript and Vitest toolchain. CC-03 extends it after CC-23. |
| F2 | Each executable unit has an explicit semantic testPath inside its scope. The generator uses it and the checker verifies ownership. |
| F3 | CC-03 freezes all 42 navigation extension points; CC-24 checks them. The coordinator owns shared dependencies, layout and configuration during M2. |
| F4 | Later shared-document owners have explicit sequential ownership transfers. CC-01 proposes view changes in docs/reference; the coordinator owns view-coverage.json. |
| F5 | The flag is --require-linear-ids. --linear-relations PATH compares an exported live snapshot. The kickoff separately requires fresh MCP reads. |
| F6 | The checker rejects overlapping scopes for dependency-independent units and test paths outside reservations. Required gate keys remain explicit product invariants. |
| F7 | The kickoff supplies eight numbered standing orders for every brief. |
| F8 | CC-11 requires a second reviewer from a different model family for its acceptance code and final verdict. CC-20 follows the same no-self-approval rule. |
| F9 | Removed the private Gmail account/message URL. |
| F10 | CC-01 records view data sources; CC-24 requires the coordinator to resolve consumer edges before M2. No unobserved dependencies were guessed. |
| F11 | Regression lanes use the last accepted integration revision and identify missing-feature baselines honestly. |
| F12 | Reports consistently use the stable planning key. |
| F13 | The user performs visual review. The checklist notes pstack's operator terminology separately from the service-team role. |
| F14 | CLI transcripts replace screenshots for CLI lanes. CC-01 records an initial performance baseline without a comparison run. |
| F15 | Referenced research files were copied to ignored .local/research. The kickoff names the local decision trail and requires preserving both in backups. |
| F16 | The docs say the available orch CLI is not used. Toolchain paths use package-lock.json. Commands use python3. |

The first review's trail audit was artifact-based; it did not independently inspect the author's raw conversation. Historical missing steps are now marked retrospective in the local trail with their evidence and retained task IDs.

## Round 2 closure

The fresh reviewer returned PASS with a condition that the full Linear readback finish. The readback completed at 10:56:31 UTC and replaced the earlier snapshot. All 26 descriptions match after Markdown formatting normalization; all 37 native blocker links and seven milestone assignments match. All issues remain Backlog. This closes R3 and the review condition.

R1 is fixed by ignoring Python caches. R2 is fixed in the generator: CC-01 now uses only its inventory CLI for the performance probe; the special-case note no longer appears in other units, and CC-02 places its measure script in its owned scripts/case-package directory. Generated documents and the pstack checker pass after these edits.

The parent also exercised three rejection cases in a temporary fixture. The checker rejects concurrent path overlap, an unowned test path and a mismatched Linear blocker. The reviewer's trail audit remains artifact-based, without a raw-transcript completeness claim. Consumer data-source edges are intentionally settled from CC-01 evidence before M2 dispatch.
