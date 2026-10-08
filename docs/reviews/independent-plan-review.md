# Independent review of the ClearCase plan

Reviewed 8 October 2026 by a reviewer who did not author the plan. Read-only except for this file. Linear was read, not changed. No archives were executed and no production system was contacted. Ten-minute timebox.

## Verdict

**Ready, with three fixes due before the affected dispatch.** GRS-9 (CC-01) can start under the kickoff as written. Fix F1 before GRS-10 is dispatched. Fix F2 and F3 before the M2 fan-out after GRS-13. Each fix is a small edit to `work-items.json`, `generate.py` or the kickoff. None needs a new decision from the user. The plan's own rule in `docs/orchestration.md:28` ("A missing prerequisite or undefined command is resolved before the worker starts") would probably catch them. Fixing them now is cheaper than relying on the coordinator to notice.

Scope, authority and model rules match the user's instructions. The pass is V1 through M3, local commits only, no main merge, push or deploy, no Cursor, high effort for every Opus agent, and other model families allowed. The kickoff states the user's standing authorization accurately and does not ask for per-write Linear approval. The V2 and Pi Durable work is gated on purpose. That is not a defect.

## What was verified locally

| Check | Result |
| --- | --- |
| `python3 scripts/planning/check.py` and `--require-linear` | exit 0. Output: "PASS: 26 issues, 7 milestones, 42 unique owned views, acyclic dependencies, six independent gates, 26 Linear mappings" |
| `python3 scripts/planning/generate.py --check` | exit 0. Output: "Verified 27 planning documents" (generated files match their source) |
| `node …/poteto-mode/scripts/check-plan.mjs docs/delivery-plan.md` | exit 0. Output: "13 PR sections, 0 problems", the same as `.audit/pstack-plan-check.txt` |
| View coverage | 42 labels match the seven groups in `product-brief.md:31-39`. Owners: CC-03 2, CC-04 7, CC-05 7, CC-06 6, CC-07 7, CC-08 7, CC-09 3, CC-10 3 |
| GRS ↔ CC mapping in the kickoff | Matches `work-items.json` (GRS-11=CC-23, GRS-13=CC-24, GRS-21=CC-11, GRS-24=CC-25) |
| Live Linear spot check (read-only) | GRS-12 blockedBy GRS-11. GRS-18 blockedBy GRS-13, 15 and 17. GRS-30 blockedBy GRS-23 and 29. All three match the local `depends`, and all are in Backlog |
| Git | Only commit is `6edffe1`. No `src/` or `package.json`. Planning files are uncommitted. `README.md` is modified (docs index only) |
| `/tmp` evidence citations in `docs/evidence.md:13-16` | All four files exist now |

## Findings

### High: fix before the affected dispatch

**F1. CC-02 needs an npm toolchain that only its own downstream ticket creates.** CC-02's unit verification is `npm run check` and `npm run test -- --run tests/CC-02` (`docs/delivery-plan.md:165`). Its scope is `src/lib/case-package/**`, `scripts/case-package/**`, `tests/case-package/**` and `docs/results-package.md` (`work-items.json`, CC-02 at line 115). It has no `package.json`, lockfile, `tsconfig` or test-runner config. Those belong to CC-03 (`work-items.json:165-166`). CC-03 depends on CC-23, and CC-23 depends on CC-02. `program-intro.md:17` says "CC-02 establishes package tests", but its scope does not let it. This is a circular setup.
*Fix.* Move the minimal toolchain into CC-02's scope: `package.json`, the real lockfile name, `tsconfig.json` and `vitest.config.*`. CC-03 then extends those files serially. Alternatively, make CC-02 a standalone Node/TS CLI with its own documented command.

**F2. The unit test command points at paths no ticket owns.** `generate.py:51` emits `npm run test -- --run tests/{key}`, which gives `tests/CC-04`, `tests/CC-05` and so on. Every ticket's scope reserves a semantic directory instead, such as `tests/evidence/**` for CC-04 or `tests/case-package/**` for CC-02. A worker cannot create `tests/CC-04` without leaving its reservation. As written, the verification box cannot be satisfied.
*Fix.* Derive the test path from the ticket's `tests/...` scope entry, or add a `testPath` field per item, and regenerate.

**F3. No ticket owns navigation or the shared shell for the M2 views.** CC-03 reserves all of `src/routes/**` and `src/lib/components/**` (`work-items.json:168`). The M2 tickets then reserve subtrees such as `src/routes/evidence/**`. The 35 M2 views still have to be registered in the shared navigation and layout (`src/routes/+layout.*` or a view registry). Adding a dependency such as a diff or PDF library also touches `package.json`. No M2 ticket owns those files. `orchestration.md:18` says "navigation … one owner" but does not name the owner. With three parallel writers, each will need a request for the same shared file.
*Fix.* As part of CC-03, add a "frozen extension points" acceptance item. For example, a navigation registry driven by `view-coverage.json`, or one stub per view, so that M2 workers never edit the layout. CC-24 already checks "frozen package interfaces" (CC-24 acceptance), so extend that check to the navigation and view registry. State that the coordinator serializes `package.json` changes during M2.

### Medium

**F4. Overlapping and contradictory reservations.** `docs/development.md` is owned by both CC-03 and CC-11 (`work-items.json:172,514`). `docs/user-guide.md` is owned by both CC-10 and CC-11 (`:466,515`). `docs/manual-processing.md` is owned by both CC-13 and CC-17 (`:600,731`). CC-01 owns `docs/plan/view-coverage.json` (`:84`), but `orchestration.md:24` forbids workers from editing shared planning files, and `check.py` validates that file. These are sequential today, so they do not conflict at run time. They still contradict "exclusive path reservation" (`kickoff-prompt.md:56`).
*Fix.* Mark the later owner "append-only after X accepted", or keep a single owner. Make view-coverage.json coordinator-owned, with CC-01 writing a proposed `docs/reference/view-checklist.*` that the coordinator merges.

**F5. `check.py --require-linear` does not read Linear.** The flag only confirms that local JSON entries contain Linear IDs (`check.py:64-68`). The kickoff lists the flag under "Read the live milestones, issues and blocking relations" (`kickoff-prompt.md:28-34`), which suggests a live reconciliation that the script does not perform. The checker also cannot detect drift between `depends` and native `blockedBy`.
*Fix.* Rename the flag to `--require-linear-ids`, or say in the kickoff that the coordinator must read relations through the Linear MCP and diff them against `depends`. A `--linear-relations <json>` input that compares an exported relation dump would be a cheap way to make this mechanical.

**F6. The checker misses the most important orchestration invariant.** It does not check for overlapping write scopes between units that can run concurrently, meaning units with no dependency path between them. It also hard-codes six keys (`check.py:54-60`). F2 and F4 would have been caught by a glob-overlap check plus a check that each verification path falls inside the unit's own scope.
*Fix.* Add both checks. Each is about 15 lines.

**F7. The standing orders the kickoff requires are never listed.** `kickoff-prompt.md:58` says each brief contains "…REPORT and these standing orders", but no list follows. A new coordinator will improvise one.
*Fix.* List the orders explicitly: RAWS and production read-only; no case material in Git or external services; no Cursor; Opus at high effort; stay in the reserved paths; only the coordinator writes Linear; PASS, HOLD or FAIL at the exact revision; no main merge, push or deploy; preserve work on hold.

**F8. The gate that closes M2 also writes the acceptance suite it judges.** CC-11 (GRS-21) is `kind: gate`. Its scope includes `tests/e2e/acceptance/**`, `scripts/verify/**` and product docs (`work-items.json:497-515`). It also has delivery-style live lanes and a review-gate block. The plan never says who independently reviews the CC-11 author's harness.
*Fix.* Split CC-11 into a delivery item (acceptance harness and docs) and a gate item, or require the coordinator to assign a second reviewer from a different model family to the CC-11 output.

**F9. Private identifier in a file that will be committed.** `docs/evidence.md:28` embeds a Gmail URL containing `authuser=<user email>` and a message ID. The kickoff's first action is a planning commit (`kickoff-prompt.md:9`), and `AGENTS.md` keeps personal material out of Git.
*Fix.* Replace the URL with "the reviewed comments email (Gmail, 8 Oct 2026; not linked)".

**F10. Possible missing dependencies between M2 tickets.** These need confirmation from the CC-01 inventory, not a guess:
- CC-06 owns Invoice Ledger but does not depend on CC-07, which owns Timesheet and Disbursements.
- CC-08 owns Conflict Check but does not depend on CC-04, which owns People and Entities.
- CC-09 owns Court Bundle and CaseLines but does not depend on CC-04 for document selection.

If v5 computes these from user-work registers or from evidence state, workers on parallel tickets will build against stores that do not exist yet.
*Fix.* Add an acceptance item to CC-01: "record each view's data sources (imported dataset vs user-work store)". The coordinator then adds the edges before M2 dispatch.

### Low

**F11. The regression lane compares against "trunk", which never gains the app.** Every Lane 1 is a "Regression lane against trunk" (`generate.py:54-55`). Main stays unchanged for the whole run, so from M2 on this compares against nothing.
*Fix.* Compare against the accepted integration base, `phase-1/local-workspace` at its last accepted revision.

**F12. The report path disagrees between documents.** `orchestration.md:46` uses `.orchestration/reports/<linear-id>/`. `generate.py:43` and `program-intro.md:58` use the planning key (`CC-xx`).
*Fix.* Choose one. The planning key is stable and is what the generator emits.

**F13. "Operator" has two meanings.** `GLOSSARY.md:43` defines Operator as service-team staff. The generated review gate says "The operator reviews changed interactions before merge into main" (`delivery-plan.md:281` and so on), where it means the user or approver. Elsewhere the plan says "the user reviews".
*Fix.* Change the generated phrase to "the user".

**F14. Uniform pstack boilerplate inflates small units.** Each unit gets 10 live lanes, 20-sample interleaved performance runs and a 30-60 s video. CC-01 and CC-02 are CLI units, yet their lanes demand `lane-NN.png`, and CC-01's performance rule compares the first run with itself. This is the multi-phase-plan skeleton applied literally. The cost is coordinator time, not correctness.
*Fix.* Allow a transcript instead of a screenshot for CLI lanes. Accept "record baseline only" as CC-01's performance box.

**F15. Two pieces of evidence may not survive.** The `/tmp/clearcase-*` evidence (`evidence.md:13-16`) is probably on tmpfs and lost at reboot. `.audit/` is gitignored, so the decision trail the kickoff asks the coordinator to "append" (`kickoff-prompt.md:84`) is excluded from the planning commit, and no remote exists.
*Fix.* Copy the research aids into the ignored `.local/research/` and repoint the links. Name the trail path in the kickoff, or commit a sanitized `docs/decisions.tsv`.

**F16. Minor stale statements.**
- `orchestration.md:50` says pstack's `orch` CLI is not installed. `poteto-mode/scripts/orch/` exists. Reword to "available but not used".
- `"lockfile"` in CC-03's scope is not a real path. Use `package-lock.json` or `pnpm-lock.yaml` once CC-03 chooses the package manager.
- The kickoff uses `python`. It exists on this machine (`/usr/bin/python`), so this is fine here, but `python3` is more portable.

## Decision trail cross-check

This check is based on artifacts only. No raw transcript for the authoring session was available to this reviewer, so the trail was compared against the files and the run summary provided.

| Trail row (`.audit/planning-decisions.tsv`) | Artifact evidence | Status |
| --- | --- | --- |
| scope: v5 first, newer second, hosted later | `product-brief.md:7-10,83-89`, kickoff:42 | Supported |
| structure: 26 issues, six gates, seven milestones | `work-items.json`, checker PASS, Linear spot check | Supported |
| authority: planning only | No commits after `6edffe1`, no app files, `orchestration.md:9` | Supported |
| models: no Cursor, Opus at high effort, not Opus-only | `skill-alignment.md:36`, `kickoff-prompt.md:54`, `orchestration.md:30` | Supported, and the correction is explicit |
| verification: checker passing | Rerun here, exit 0 | Supported, but see F5 and F6 on what it proves |

The run summary contains steps that the trail does not record. They are worktree creation through T3, the v5 NAV/META inspection, the Knap reading, the bounded route inspection, the single Jove Opus reader dispatch (no task ID retained) and the README change. `evidence.md` substantiates the NAV/META, Knap and route findings. The Jove dispatch and its overstated model restriction are visible only through the correction in `skill-alignment.md:36`. All five rows share one timestamp (`10:42:34Z`), so they were written together afterwards rather than as each decision was made. Their content is consistent with the artifacts. Add rows for the omitted steps, including the reader's task ID if it is still known.

## Attention

- F1 blocks GRS-10 verification as written. Fix it before GRS-10 is dispatched.
- F2 and F3 make M2 parallel work collide or fail its verification boxes. Fix them before the post-GRS-13 fan-out.
- F9 must be removed before the kickoff's first planning commit.
- The checker's PASS proves that the graph and generated files are consistent. It does not prove that live Linear relations match, that reservations are disjoint, or that commands are runnable (F5, F6).
- GRS-25, the hosted operator contract, remains unverified on purpose and does not block V1. Do not let any worker infer the endpoint from client upload APIs.
- Linear descriptions were being synced during this review. Re-read them after the sync, because the ticket text checked here came from the local generator.
- No remote exists. The worktree, `.audit/` and the `/tmp` evidence are single copies until a bundle or backup is made.
