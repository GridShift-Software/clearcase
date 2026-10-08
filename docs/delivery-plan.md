# ClearCase delivery plan

Build a local case workspace against the v5 sample, then verify the newer export and prepare hosted client delivery.
The first baseline contains 1,689 documents and 42 views. The second contains 2,131 documents.
This is a plan, not an implementation or a completed verification report.
Stable planning keys map to real Linear issues in the appendix and `docs/plan/work-items.json`.
This document is generated from `docs/plan/program-intro.md` and `docs/plan/work-items.json`.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. Check a box only when its evidence exists. Generated boxes represent acceptance obligations; execution status and evidence live in Linear and the coordinator's ledger.

The program runs `/home/vaper/.agents/skills/poteto-mode/playbooks/orchestrate.md` with the local T3 adaptations in `docs/orchestration.md`. The coordinator integrates accepted local work. The user controls main-branch merges and deployment. The remote is `origin`; every ticket closes through a PR into `dev`.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

The implementation test commands below are required deliverables, not existing runnable commands. CC-01 supplies its inventory CLI. CC-02 establishes package tests; CC-03 establishes app/build/browser commands. Before dispatch, replace any affected command with the verified repository command and keep the acceptance behavior unchanged. Gate and discovery issues verify their real output without invented UI tests.

## Program checklist

### Arm the program

- [ ] Treat this session as planning only. Start implementation when the user supplies the kickoff as an execution instruction.
- [ ] Run `scripts/agent-tools/doctor` and `scripts/agent-tools/check-plan` from the worktree before each dispatch; see `docs/agent-tooling.md`. Read the current local skills and record their paths. `origin/dev` is the integration base; use `git show origin/main:<path>` only to compare against the release branch, which changes only through user-approved merges.
- [ ] Read the orchestration, swarm, verification and relevant implementation skills before each phase. The user's no-Cursor and Opus-high settings override default model choices.
- [ ] Do not arm `/loop 1h` during planning. If later authorized, use the app scheduler for an hourly audit with a status message only for material changes; T3 task completion already supplies wakeups.
- [ ] On hold, send every active writer a zero-writes instruction and preserve their artifacts.

### Spawn owners

- [ ] Use one owner per implementation ticket, one worktree per writer and a complete brief. Keep the coordinator responsible for Linear and integration.
- [ ] Run CC-27 first; its agent tooling and doctor are the setup prerequisite for CC-01. Then run CC-01 and CC-02, then independent gate CC-23. Run the complete pilot CC-03, then independent gate CC-24 before feature fan-out.
- [ ] Follow every native Linear blocking edge and reconcile it with the local graph. A gate is not satisfied by a worker's self-report.
- [ ] Reserve actual file paths before dispatch. Limit initial writers to three; serialize shared config, schemas, navigation and persistence changes.
- [ ] Retain delegated task IDs. Fix rounds use fresh agents with the original scope, prior report and unresolved findings.

### PR mechanics, for every PR

- [ ] Push each `feature/<linear-id>-<slug>` branch to `origin` and open a PR into `dev` when the ticket's evidence is complete. Register every PR with T3.
- [ ] When a remote and PR workflow are authorized, use the available forge and register every PR with T3. Do not require `gt` or a nonexistent repository script.
- [ ] During authorized implementation, run lint/typecheck and relevant behavior tests before each reviewable commit. Cut unnecessary comments and prose before review.
- [ ] Keep the reviewed base revision stable through a fix round. Delegate conflicts and recheck affected evidence after integration.

### Verdict and merge, for every PR

- [ ] Record PASS, HOLD or FAIL with exact revision, commands, exit codes and artifacts. A skipped, stale or mocked acceptance check is not PASS.
- [ ] Use independent reviewers for CC-23, CC-24, CC-11, CC-25, CC-26 and CC-20. A reviewer must not approve their own implementation.
- [ ] Reconcile new heads against prior receipts. Run fresh checks for behavior changes and integration conflicts.
- [ ] Merge accepted, externally reviewed PRs serially into `dev` only under the kickoff's execution authority. Keep main unchanged.
- [ ] Collect screenshots and a video for interaction changes. The user reviews the concrete release candidate before a main merge.

### Boot recipe, for every live lane

- [ ] Check out the exact reserved local candidate revision. Record `git rev-parse HEAD` and any uncommitted diff digest.
- [ ] Read the ticket's fixture and input-version identity. Set the documented local fixture path and fixed clock; keep case material outside Git.
- [ ] Once CC-03 provides the app, install from its lockfile, run the documented local server on loopback and wait for its readiness check. Use `npm run build` and the production preview for performance measurements.
- [ ] Use T3 `preview_status`, then `preview_open` if needed, followed by the available navigation and interaction tools. Follow platform fallback rules if the preview is unavailable.
- [ ] Drive real inputs, save screenshots and logs under `.orchestration/reports/<planning-key>/`, and name the observed pass predicate. CLI units save terminal transcripts; no screenshot is required.
- [ ] Disable outbound networking for local acceptance. Use synthetic data for committed tests and keep case-bearing receipts ignored.

## Freeze the v5 fixture and behavior baseline (CC-01)

**Depends on.** [GRS-35](https://linear.app/vaper/issue/GRS-35/set-up-pstack-and-verification-skills-for-agent-cli-access).

**Files.**

- [ ] Own `scripts/fixtures/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/fixtures/README.md` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/reference/**` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Read the original archive without modifying it. Fingerprint the archive and main HTML; record the build date and exactly 1,689 chronology records and 42 navigation entries.

- [ ] Produce a local reference-to-path inventory, duplicate and missing-file reports, and a per-view action/export/state checklist. Keep case documents and extracted text outside Git.

- [ ] Record literal expected examples for filters, citations, calculations and mutable workflows. Fix the clock for date-sensitive examples. Classify source defects separately from rewrite defects.

- [ ] Document a fresh-machine setup and a local fixture location. Capture representative v5 screens safely with networking disabled; no execution of archive processing scripts.

- [ ] Record each view's data sources and distinguish imported datasets from user-work stores in docs/reference/view-checklist.md. Propose view-coverage changes for the coordinator; before M2 dispatch, the coordinator resolves consumer dependencies for Invoice Ledger, Conflict Check, Court Bundle and CaseLines from this evidence.

- [ ] Create `docs/reference/audit-dispositions.md` from the BA-01 to BA-21 disposition table in the delivery plan. Record each finding's owner, applicable fixture/view, correction or disclosure, explicit deferral and evidence requirement. A deferred source repair must not be reported as fixed.

- [ ] Map the 42 v5 navigation entries against the production audit's 55 routes without equating the counts. Identify production-only capabilities as V2-owned or explicitly deferred, and list any newer-export dataset that remains unsupported. Browser-agent product behavior is deferred; no browser agent is implied by local parity.

**You see.**

- [ ] A new worker can reproduce the sample inventory and identify every expected behavior without relying on chat history.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Deliver and run `python3 scripts/fixtures/inventory.py --verify` against the designated local archive. Preserve its JSON inventory and literal fixture assertions in the unit report.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Rebuild the inventory twice and compare outputs. Save `.orchestration/reports/CC-01/lane-01.png` for browser behavior or `.orchestration/reports/CC-01/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Detect a deliberately missing source file. Save `.orchestration/reports/CC-01/lane-02.png` for browser behavior or `.orchestration/reports/CC-01/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Detect duplicate legacy refs in a synthetic fixture. Save `.orchestration/reports/CC-01/lane-03.png` for browser behavior or `.orchestration/reports/CC-01/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Resolve paths containing spaces and non-ASCII characters. Save `.orchestration/reports/CC-01/lane-04.png` for browser behavior or `.orchestration/reports/CC-01/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Reject paths escaping the case folder. Save `.orchestration/reports/CC-01/lane-05.png` for browser behavior or `.orchestration/reports/CC-01/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Separate the main HTML from the bundles-only variant. Save `.orchestration/reports/CC-01/lane-06.png` for browser behavior or `.orchestration/reports/CC-01/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Count all 42 view actions without using the stale manual. Save `.orchestration/reports/CC-01/lane-07.png` for browser behavior or `.orchestration/reports/CC-01/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Capture a citation and its original file. Save `.orchestration/reports/CC-01/lane-08.png` for browser behavior or `.orchestration/reports/CC-01/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Fix the clock for a deadline example. Save `.orchestration/reports/CC-01/lane-09.png` for browser behavior or `.orchestration/reports/CC-01/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Keep generated case material out of Git. Save `.orchestration/reports/CC-01/lane-10.png` for browser behavior or `.orchestration/reports/CC-01/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Archive inventory elapsed time and peak memory at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `python3 scripts/fixtures/inventory.py --verify` with elapsed-time and peak-memory reporting. Record the initial baseline and machine details; no interleaved comparison is required.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Record the first baseline. Fail a repeat above 1.25 times the median baseline on the same unchanged fixture. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** None. CC-01 is not review-gated for product interaction. Its independent contract gate still applies.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Validate and convert a portable results package (CC-02)

**Depends on.** [GRS-9](https://linear.app/vaper/issue/GRS-9/freeze-the-v5-fixture-and-behavior-baseline).

**Files.**

- [ ] Own `src/lib/case-package/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `scripts/case-package/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/case-package/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/results-package.md` for this unit. Reserve shared files before dispatch.

- [ ] Own `package.json` for this unit. Reserve shared files before dispatch.

- [ ] Own `package-lock.json` for this unit. Reserve shared files before dispatch.

- [ ] Own `tsconfig.json` for this unit. Reserve shared files before dispatch.

- [ ] Own `vitest.config.*` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Specify and implement the v5 adapter with case identity, input revision, results version, manifest, datasets, originals and attachment relationships. Do not execute imported HTML to obtain data.

- [ ] Validate all dataset shapes and refs, path containment, duplicate IDs, unsupported versions and ambiguous asset mappings. Use distinct diagnostics for known baseline defects and new structural failures.

- [ ] Preserve source values and provenance. Use file fingerprints for asset identity; do not equate legacy refs across independently rebuilt packs.

- [ ] Import produces an immutable candidate and diagnostics. Repeated conversion is deterministic. User notes and registers are not embedded in immutable results. Define the generated-data versus authored-analysis boundary.

- [ ] Establish the minimal npm/TypeScript/Vitest toolchain and npm check, test and measure scripts needed to execute this ticket. CC-03 extends these files only after the package gate passes.

- [ ] Treat every imported narrative, filename, URL and metadata field as untrusted content, not only manually authored Markdown. Reject unsafe link schemes and define safe rendering rules in the package contract. Verify hostile fixtures cannot execute code.

- [ ] Define bounded file, record and nesting sizes; if archive extraction is supported, bound expanded size and reject traversal/symlink escapes and malformed archives. Invalid or excessive inputs must fail with actionable diagnostics before activation.

**You see.**

- [ ] An operator can convert the v5 sample to an inspectable package and obtain actionable validation errors before activation.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/case-package` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-02/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Convert v5 and compare all chronology fields. Save `.orchestration/reports/CC-02/lane-01.png` for browser behavior or `.orchestration/reports/CC-02/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Validate a complete candidate. Save `.orchestration/reports/CC-02/lane-02.png` for browser behavior or `.orchestration/reports/CC-02/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Reject malformed data without a candidate. Save `.orchestration/reports/CC-02/lane-03.png` for browser behavior or `.orchestration/reports/CC-02/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Reject duplicate refs. Save `.orchestration/reports/CC-02/lane-04.png` for browser behavior or `.orchestration/reports/CC-02/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Report broken citation targets. Save `.orchestration/reports/CC-02/lane-05.png` for browser behavior or `.orchestration/reports/CC-02/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Reject a path traversal asset. Save `.orchestration/reports/CC-02/lane-06.png` for browser behavior or `.orchestration/reports/CC-02/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Distinguish unsupported media from missing text. Save `.orchestration/reports/CC-02/lane-07.png` for browser behavior or `.orchestration/reports/CC-02/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Resolve an attachment to its parent. Save `.orchestration/reports/CC-02/lane-08.png` for browser behavior or `.orchestration/reports/CC-02/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Reconvert with stable output identity. Save `.orchestration/reports/CC-02/lane-09.png` for browser behavior or `.orchestration/reports/CC-02/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Reject an unsupported package version. Save `.orchestration/reports/CC-02/lane-10.png` for browser behavior or `.orchestration/reports/CC-02/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Candidate conversion and validation time, peak memory at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-02 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details. Place this unit's measurement script under its owned scripts/case-package/ directory.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Set numeric conversion and memory limits from the CC-01 baseline before implementation. Repeat imports must stay within 1.25 times the accepted median. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** None. CC-02 is not review-gated for product interaction. Its independent contract gate still applies.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Complete the local import to original-document workflow (CC-03)

**Depends on.** [GRS-11](https://linear.app/vaper/issue/GRS-11/gate-the-reference-baseline-and-package-contract).

**Files.**

- [ ] Own `vite.config.*` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/routes/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/components/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/local-case/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/e2e/pilot/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/development.md` for this unit. Reserve shared files before dispatch.

- [ ] Own `package.json` for this unit. Reserve shared files before dispatch.

- [ ] Own `package-lock.json` for this unit. Reserve shared files before dispatch.

- [ ] Own `tsconfig.json` for this unit. Reserve shared files before dispatch.

- [ ] Own `vitest.config.*` for this unit. Reserve shared files before dispatch.

- [ ] Own `svelte.config.*` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/app.*` for this unit. Reserve shared files before dispatch.

- [ ] Own `static/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `scripts/measure/**` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Choose and pin the local stack after comparing the minimum viable storage choices. Use the recommended SvelteKit and TypeScript unless a measured constraint justifies a change.

- [ ] Implement case-folder selection, validation report, candidate preview, activation, overview, chronology and document detail. Open or download supported original types with explicit unsupported/missing states.

- [ ] Keep the active version unchanged on failed import. Keep originals outside Git. Serve only loopback and work with outbound networking disabled.

- [ ] Provide history-aware navigation, accessible focus, case-aware titles, citation links and a reproducible boot/verification command. This complete workflow is the pilot before feature fan-out.

- [ ] Freeze navigation entries and route extension points for all 42 views using the coordinator-owned view inventory. Reserve one feature subtree per worker and define shared component/persistence contracts before fan-out. Unimplemented entries remain explicitly unavailable until their owning issue passes. The coordinator serializes dependency, lockfile, shared layout and configuration changes during M2.

- [ ] Ownership transfer after CC-02 is accepted. Extend package.json, package-lock.json, tsconfig.json, vitest.config.* serially, preserving the accepted behavior and documentation. The previous owner is no longer an active writer on these paths.

- [ ] Apply the package's safe-rendering and link policy throughout overview, chronology, document details and previews. Active original content must not execute with the application's origin/privileges; isolate supported previews or offer an explicit download. Test hostile narratives, filenames, links and original files without outbound access.

- [ ] For dates used in chronology, retain the source value and expose supplied date type/provenance or explicitly mark the basis unknown. Do not silently infer a document issue date from an incidental date. Source metadata re-extraction is deferred (BA-04).

- [ ] Navigation names must match their destinations and use task names rather than development-priority labels (BA-18).

**You see.**

- [ ] The operator imports a candidate, previews and activates it, then follows a chronology citation to the correct original.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/e2e/pilot` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-03/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Compare the complete import-to-document workflow with the reference. Save `.orchestration/reports/CC-03/lane-01.png` for browser behavior or `.orchestration/reports/CC-03/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Import and preview v5 without activation. Save `.orchestration/reports/CC-03/lane-02.png` for browser behavior or `.orchestration/reports/CC-03/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Activate and see exactly 1,689 base records. Save `.orchestration/reports/CC-03/lane-03.png` for browser behavior or `.orchestration/reports/CC-03/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Sort and filter chronology with fixed expected rows. Save `.orchestration/reports/CC-03/lane-04.png` for browser behavior or `.orchestration/reports/CC-03/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Open a cited PDF. Save `.orchestration/reports/CC-03/lane-05.png` for browser behavior or `.orchestration/reports/CC-03/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Open or download a non-PDF original. Save `.orchestration/reports/CC-03/lane-06.png` for browser behavior or `.orchestration/reports/CC-03/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Show a missing-original state. Save `.orchestration/reports/CC-03/lane-07.png` for browser behavior or `.orchestration/reports/CC-03/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Reject a broken candidate while the active version remains usable. Save `.orchestration/reports/CC-03/lane-08.png` for browser behavior or `.orchestration/reports/CC-03/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Use keyboard navigation and browser Back. Save `.orchestration/reports/CC-03/lane-09.png` for browser behavior or `.orchestration/reports/CC-03/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Restart with networking disabled and recover the active case. Save `.orchestration/reports/CC-03/lane-10.png` for browser behavior or `.orchestration/reports/CC-03/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Cold usable-overview time, warm navigation and original-open latency at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-03 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Overview <=2,000 ms and warm navigation <=200 ms at p95 on the recorded local machine. Report original-open separately with a numeric budget fixed after CC-01. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-03/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Browse, search and compare the case evidence (CC-04)

**Depends on.** [GRS-13](https://linear.app/vaper/issue/GRS-13/gate-the-complete-local-pilot-before-feature-fan-out).

**Files.**

- [ ] Own `src/routes/evidence/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/evidence/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/evidence/**` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Cover Documents, Contracts, Filings & Affidavits, Advanced Search, People, Entities and Document Diff with their recorded actions.

- [ ] Preserve query/filter/sort/page state through navigation and exports. Distinguish invalid ranges from genuine empty results.

- [ ] Disclose indexed-text limits and unsupported files. Do not label a truncated corpus search as full-document search.

- [ ] Use literal expected search/diff examples and justified comparison relationships. Keep original links and filing-register edits functional.

- [ ] Treat imported filing classifications and inferred professional identities as unverified unless supported by review evidence; disclose that status and test the audit's misleading classification/automated-sender cases. Do not present an automated sender as a verified attorney. Preserve raw source data; full extraction/classification rebuild remains deferred (BA-05, BA-07).

- [ ] Ensure document ordering labels, active sort, pagination and exported order agree (BA-17).

**You see.**

- [ ] A reviewer can find a document through filters or search, inspect its people/entities and agreements, and compare available text.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/evidence` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-04/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Compare fixed search results with v5. Save `.orchestration/reports/CC-04/lane-01.png` for browser behavior or `.orchestration/reports/CC-04/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Filter by bundle and document type. Save `.orchestration/reports/CC-04/lane-02.png` for browser behavior or `.orchestration/reports/CC-04/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Retain a query across pagination. Save `.orchestration/reports/CC-04/lane-03.png` for browser behavior or `.orchestration/reports/CC-04/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Reject reversed date and amount intervals. Save `.orchestration/reports/CC-04/lane-04.png` for browser behavior or `.orchestration/reports/CC-04/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Show a genuine empty result. Save `.orchestration/reports/CC-04/lane-05.png` for browser behavior or `.orchestration/reports/CC-04/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Show truncated or absent text coverage. Save `.orchestration/reports/CC-04/lane-06.png` for browser behavior or `.orchestration/reports/CC-04/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Open a contract and its citation. Save `.orchestration/reports/CC-04/lane-07.png` for browser behavior or `.orchestration/reports/CC-04/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Inspect a person and entity relationship. Save `.orchestration/reports/CC-04/lane-08.png` for browser behavior or `.orchestration/reports/CC-04/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Edit and reload a filing relationship. Save `.orchestration/reports/CC-04/lane-09.png` for browser behavior or `.orchestration/reports/CC-04/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Compare two known text versions. Save `.orchestration/reports/CC-04/lane-10.png` for browser behavior or `.orchestration/reports/CC-04/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Search latency and warm evidence navigation at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-04 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Search <=300 ms and warm navigation <=200 ms at p95; no unexpected whole-corpus reload per filter. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-04/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Read the matter narrative and evidence-linked analysis (CC-05)

**Depends on.** [GRS-13](https://linear.app/vaper/issue/GRS-13/gate-the-complete-local-pilot-before-feature-fan-out).

**Files.**

- [ ] Own `src/routes/analysis/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/analysis/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/analysis/**` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Cover Matter & Strategy, Timeline, Contradiction Tracker, Risk Matrix, Defence & Rebuttal, Info Required and Witnesses.

- [ ] Preserve narratives, groupings, severities and citations from the selected package. Record intentional ordering changes.

- [ ] Persist any checklist or witness edits found in the baseline action inventory without changing imported source analysis.

- [ ] Provide readable narrow-screen details, print/export behavior from v5, and explicit empty or incomplete states.

**You see.**

- [ ] A reviewer can read the storyline and timeline, inspect contradictions, risks and defences, and follow supporting citations.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/analysis` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-05/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Compare a fixed narrative section with v5. Save `.orchestration/reports/CC-05/lane-01.png` for browser behavior or `.orchestration/reports/CC-05/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Follow an inline reference. Save `.orchestration/reports/CC-05/lane-02.png` for browser behavior or `.orchestration/reports/CC-05/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Read the timeline in order. Save `.orchestration/reports/CC-05/lane-03.png` for browser behavior or `.orchestration/reports/CC-05/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Print the timeline. Save `.orchestration/reports/CC-05/lane-04.png` for browser behavior or `.orchestration/reports/CC-05/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Inspect contradiction categories and their sources. Save `.orchestration/reports/CC-05/lane-05.png` for browser behavior or `.orchestration/reports/CC-05/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Read one risk with its mitigation on a narrow screen. Save `.orchestration/reports/CC-05/lane-06.png` for browser behavior or `.orchestration/reports/CC-05/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Trace a defence to its evidence. Save `.orchestration/reports/CC-05/lane-07.png` for browser behavior or `.orchestration/reports/CC-05/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Change and reload an information-required item. Save `.orchestration/reports/CC-05/lane-08.png` for browser behavior or `.orchestration/reports/CC-05/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Inspect a witness and linked document. Save `.orchestration/reports/CC-05/lane-09.png` for browser behavior or `.orchestration/reports/CC-05/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Render a package with an empty optional analysis dataset. Save `.orchestration/reports/CC-05/lane-10.png` for browser behavior or `.orchestration/reports/CC-05/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Analysis navigation and expanded-detail latency at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-05 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Warm navigation <=200 ms at p95; no uncaught error on empty optional datasets. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-05/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Reconcile quantum and scenario calculations (CC-06)

**Depends on.** [GRS-13](https://linear.app/vaper/issue/GRS-13/gate-the-complete-local-pilot-before-feature-fan-out).

**Files.**

- [ ] Own `src/routes/quantum/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/calculations/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/calculations/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/reference/calculation-differences.md` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Cover Quantum & Interest, Invoice Ledger, Interest Recalculator, Payments & Net Claim, Prescription and Settlement / BATNA.

- [ ] Reconcile source amounts and dates without silently correcting imported figures. Document rounding, time basis, defaults and every deliberate arithmetic fix.

- [ ] Use fixed literal checks including R1,000 at 10% simple interest for one year yielding R100, zero and invalid inputs, leap dates and month ends.

- [ ] Persist scenario/payment inputs where v5 does; export the intended ledger. Keep legal-rule approval separate from arithmetic verification. Flag unsupported legal conclusions for human review.

- [ ] Resolve BA-01 to BA-03 through explicit arithmetic/default checks and a differences register. Imported narrative that contradicts its own dates must be visibly flagged or replaced by a reviewed correction; it cannot pass as an unqualified verified conclusion. Preserve original source values and keep approval of legal rules separate.

**You see.**

- [ ] A reviewer can reconcile invoices and payments and reproduce financial/date scenarios with visible assumptions.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/calculations` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-06/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Compare invoice totals with the reference. Save `.orchestration/reports/CC-06/lane-01.png` for browser behavior or `.orchestration/reports/CC-06/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Run the R100 simple-interest example. Save `.orchestration/reports/CC-06/lane-02.png` for browser behavior or `.orchestration/reports/CC-06/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Change and restore grace-period defaults. Save `.orchestration/reports/CC-06/lane-03.png` for browser behavior or `.orchestration/reports/CC-06/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Exercise month-end and leap-day dates. Save `.orchestration/reports/CC-06/lane-04.png` for browser behavior or `.orchestration/reports/CC-06/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Reject invalid or reversed calculation inputs. Save `.orchestration/reports/CC-06/lane-05.png` for browser behavior or `.orchestration/reports/CC-06/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Record a payment and reload the net claim. Save `.orchestration/reports/CC-06/lane-06.png` for browser behavior or `.orchestration/reports/CC-06/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Export the invoice ledger. Save `.orchestration/reports/CC-06/lane-07.png` for browser behavior or `.orchestration/reports/CC-06/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Change a settlement assumption and observe the result. Save `.orchestration/reports/CC-06/lane-08.png` for browser behavior or `.orchestration/reports/CC-06/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Distinguish imported legal narrative from computed dates. Save `.orchestration/reports/CC-06/lane-09.png` for browser behavior or `.orchestration/reports/CC-06/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Repeat with a fixed clock and obtain identical results. Save `.orchestration/reports/CC-06/lane-10.png` for browser behavior or `.orchestration/reports/CC-06/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Scenario recalculation and ledger navigation latency at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-06 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Recalculation <=200 ms and warm navigation <=200 ms at p95; zero unexplained numeric differences. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-06/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Maintain case registers without losing edits (CC-07)

**Depends on.** [GRS-13](https://linear.app/vaper/issue/GRS-13/gate-the-complete-local-pilot-before-feature-fan-out).

**Files.**

- [ ] Own `src/routes/registers/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/user-work/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/registers/**` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Cover Disbursements, Timesheet, Deadlines, Privilege Log, POPIA Register, Annotations and Transcripts.

- [ ] Implement the create/edit/delete/export actions present in v5 and scope records to the selected case. Keep imported results separate.

- [ ] Persist changes through reload and server restart. Make failed writes visible and preserve unsaved input.

- [ ] Verify totals, deadline countdown with a fixed clock, calendar export and original-document references with controlled local fixtures.

- [ ] Privilege workflows must not turn unverified professional-role inference into a privilege finding. Keep suggestions explicitly unverified; test an automated-sender example without silently rewriting source identities (BA-07).

**You see.**

- [ ] A reviewer can maintain case-management records locally and recover them after restart.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/registers` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-07/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Compare seeded register state with v5. Save `.orchestration/reports/CC-07/lane-01.png` for browser behavior or `.orchestration/reports/CC-07/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Create and edit a disbursement. Save `.orchestration/reports/CC-07/lane-02.png` for browser behavior or `.orchestration/reports/CC-07/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Record time and verify its value. Save `.orchestration/reports/CC-07/lane-03.png` for browser behavior or `.orchestration/reports/CC-07/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Create a deadline and export its calendar entry. Save `.orchestration/reports/CC-07/lane-04.png` for browser behavior or `.orchestration/reports/CC-07/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Edit privilege and POPIA records. Save `.orchestration/reports/CC-07/lane-05.png` for browser behavior or `.orchestration/reports/CC-07/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Add a document annotation. Save `.orchestration/reports/CC-07/lane-06.png` for browser behavior or `.orchestration/reports/CC-07/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Inspect or edit a transcript as supported by v5. Save `.orchestration/reports/CC-07/lane-07.png` for browser behavior or `.orchestration/reports/CC-07/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Delete a controlled test record. Save `.orchestration/reports/CC-07/lane-08.png` for browser behavior or `.orchestration/reports/CC-07/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Restart and recover every saved entry. Save `.orchestration/reports/CC-07/lane-09.png` for browser behavior or `.orchestration/reports/CC-07/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Simulate a failed write without losing unsaved input. Save `.orchestration/reports/CC-07/lane-10.png` for browser behavior or `.orchestration/reports/CC-07/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Register save/read latency at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-07 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Save/read <=200 ms at p95 on the acceptance fixture. This issue has no dependency on a later restore baseline; CC-10 / [GRS-20](https://linear.app/vaper/issue/GRS-20/rescan-local-files-and-restore-user-work-safely) owns backup/restore time and memory budgets and measurements. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-07/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Work through litigation preparation tools (CC-08)

**Depends on.** [GRS-13](https://linear.app/vaper/issue/GRS-13/gate-the-complete-local-pilot-before-feature-fan-out), [GRS-15](https://linear.app/vaper/issue/GRS-15/read-the-matter-narrative-and-evidence-linked-analysis), [GRS-17](https://linear.app/vaper/issue/GRS-17/maintain-case-registers-without-losing-edits).

**Files.**

- [ ] Own `src/routes/litigation/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/litigation/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/litigation/**` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Cover Conflict Check, Enforcement Roadmap, Legality & SIU Risk, Cause of Action, Authorities, Heads of Argument and Cross-Exam Prep.

- [ ] Preserve the supplied working analysis and cited evidence. Label dataset scope and unverified legal assertions clearly.

- [ ] Implement editable statuses, authority entries and preparation notes as identified in the baseline. Persist them in the existing case user-work store.

- [ ] Verify export contents and citation targets, including an empty preparation state. Do not present a corpus match as a definitive legal conflict finding.

**You see.**

- [ ] A reviewer can prepare authorities, argument and cross-examination material and track the litigation roadmap.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/litigation` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-08/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Compare roadmap content with v5. Save `.orchestration/reports/CC-08/lane-01.png` for browser behavior or `.orchestration/reports/CC-08/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Change and reload a roadmap status. Save `.orchestration/reports/CC-08/lane-02.png` for browser behavior or `.orchestration/reports/CC-08/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Inspect a legality scenario and its evidence. Save `.orchestration/reports/CC-08/lane-03.png` for browser behavior or `.orchestration/reports/CC-08/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Trace a cause-of-action element to its witness. Save `.orchestration/reports/CC-08/lane-04.png` for browser behavior or `.orchestration/reports/CC-08/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Create and export an authority. Save `.orchestration/reports/CC-08/lane-05.png` for browser behavior or `.orchestration/reports/CC-08/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Draft and reload an argument section. Save `.orchestration/reports/CC-08/lane-06.png` for browser behavior or `.orchestration/reports/CC-08/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Prepare a witness cross-examination note. Save `.orchestration/reports/CC-08/lane-07.png` for browser behavior or `.orchestration/reports/CC-08/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Run a known conflict-search example. Save `.orchestration/reports/CC-08/lane-08.png` for browser behavior or `.orchestration/reports/CC-08/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Show an unknown party without claiming clearance. Save `.orchestration/reports/CC-08/lane-09.png` for browser behavior or `.orchestration/reports/CC-08/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Export preparation material with valid citations. Save `.orchestration/reports/CC-08/lane-10.png` for browser behavior or `.orchestration/reports/CC-08/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Preparation navigation and save latency at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-08 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Warm navigation and save <=200 ms at p95 on the acceptance fixture. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-08/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Prepare discovery schedules and case bundles (CC-09)

**Depends on.** [GRS-13](https://linear.app/vaper/issue/GRS-13/gate-the-complete-local-pilot-before-feature-fan-out), [GRS-17](https://linear.app/vaper/issue/GRS-17/maintain-case-registers-without-losing-edits).

**Files.**

- [ ] Own `src/routes/bundles/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/bundles/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/bundles/**` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Cover Discovery Schedule, Court Bundle and CaseLines to the actual v5 capability boundary.

- [ ] Reconcile source rows, order, page references and selected items. Preserve draft/incomplete status in exported content.

- [ ] Exercise every export present in the reference and inspect the output. Do not assume the old bundle builder physically merges PDFs until the baseline proves it.

- [ ] Verify missing-text and missing-source behavior, selection persistence and safe handling of large originals.

**You see.**

- [ ] A reviewer can reconcile discovery coverage, select bundle items and use CaseLines references with honest completeness states.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/bundles` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-09/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Compare a discovery schedule with its source. Save `.orchestration/reports/CC-09/lane-01.png` for browser behavior or `.orchestration/reports/CC-09/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Inspect an incomplete schedule item. Save `.orchestration/reports/CC-09/lane-02.png` for browser behavior or `.orchestration/reports/CC-09/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Select and reorder bundle references. Save `.orchestration/reports/CC-09/lane-03.png` for browser behavior or `.orchestration/reports/CC-09/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Reload a saved selection. Save `.orchestration/reports/CC-09/lane-04.png` for browser behavior or `.orchestration/reports/CC-09/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Inspect the produced bundle output. Save `.orchestration/reports/CC-09/lane-05.png` for browser behavior or `.orchestration/reports/CC-09/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Follow a CaseLines page reference. Save `.orchestration/reports/CC-09/lane-06.png` for browser behavior or `.orchestration/reports/CC-09/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Search available page text. Save `.orchestration/reports/CC-09/lane-07.png` for browser behavior or `.orchestration/reports/CC-09/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Show missing page text explicitly. Save `.orchestration/reports/CC-09/lane-08.png` for browser behavior or `.orchestration/reports/CC-09/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Open the large pleadings original. Save `.orchestration/reports/CC-09/lane-09.png` for browser behavior or `.orchestration/reports/CC-09/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Keep incomplete exports visibly incomplete. Save `.orchestration/reports/CC-09/lane-10.png` for browser behavior or `.orchestration/reports/CC-09/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Bundle selection, export and large-document open latency at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-09 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Selection <=200 ms at p95. Record export and large-document budgets from CC-01 before optimizing or claiming a speedup. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-09/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Rescan local files and restore user work safely (CC-10)

**Depends on.** [GRS-13](https://linear.app/vaper/issue/GRS-13/gate-the-complete-local-pilot-before-feature-fan-out), [GRS-17](https://linear.app/vaper/issue/GRS-17/maintain-case-registers-without-losing-edits).

**Files.**

- [ ] Own `src/routes/system/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/local-case/rescan/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/user-work/backup/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/system/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/user-guide.md` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Cover Rescan & Update, Backup / Restore and Manual.

- [ ] A repeat scan is idempotent. Detect additions, removals and changed contents; do not assign duplicate refs or claim analysis is current after a shallow rescan.

- [ ] Backup includes user-entered state and required identities/version metadata. State clearly whether binaries are included. Validate restore and scope it to the correct case.

- [ ] Corrupt or incompatible backups leave active data unchanged. Verify restoration into a fresh local profile and document startup, import, search coverage and backup behavior.

- [ ] Own and record backup/restore time and memory budgets before implementing this workflow, then measure them on the accepted fixture. [GRS-17](https://linear.app/vaper/issue/GRS-17/maintain-case-registers-without-losing-edits) completion requires its own register read/write evidence and does not wait for these later measurements.

**You see.**

- [ ] An operator discovers changed files, queues manual reprocessing and can restore all local work without corrupting the active case.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/system` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-10/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Compare available system actions with v5. Save `.orchestration/reports/CC-10/lane-01.png` for browser behavior or `.orchestration/reports/CC-10/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Scan an unchanged folder twice. Save `.orchestration/reports/CC-10/lane-02.png` for browser behavior or `.orchestration/reports/CC-10/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Discover multiple same-prefix additions without duplicate refs. Save `.orchestration/reports/CC-10/lane-03.png` for browser behavior or `.orchestration/reports/CC-10/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Detect same-name same-size changed content. Save `.orchestration/reports/CC-10/lane-04.png` for browser behavior or `.orchestration/reports/CC-10/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Report removed originals. Save `.orchestration/reports/CC-10/lane-05.png` for browser behavior or `.orchestration/reports/CC-10/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Keep processing-pending state after rescan. Save `.orchestration/reports/CC-10/lane-06.png` for browser behavior or `.orchestration/reports/CC-10/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Export all user-work categories. Save `.orchestration/reports/CC-10/lane-07.png` for browser behavior or `.orchestration/reports/CC-10/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Restore into a fresh profile. Save `.orchestration/reports/CC-10/lane-08.png` for browser behavior or `.orchestration/reports/CC-10/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Reject a corrupt or wrong-case backup. Save `.orchestration/reports/CC-10/lane-09.png` for browser behavior or `.orchestration/reports/CC-10/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Follow the manual with networking disabled. Save `.orchestration/reports/CC-10/lane-10.png` for browser behavior or `.orchestration/reports/CC-10/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Rescan duration, backup/restore duration and peak memory at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-10 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Record unchanged-scan baseline first and fail regression above 1.25 times median; set numeric backup/restore memory and time budgets before implementation. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-10/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Verify complete v5 parity and local release readiness (CC-11)

**Depends on.** [GRS-14](https://linear.app/vaper/issue/GRS-14/browse-search-and-compare-the-case-evidence), [GRS-15](https://linear.app/vaper/issue/GRS-15/read-the-matter-narrative-and-evidence-linked-analysis), [GRS-16](https://linear.app/vaper/issue/GRS-16/reconcile-quantum-and-scenario-calculations), [GRS-17](https://linear.app/vaper/issue/GRS-17/maintain-case-registers-without-losing-edits), [GRS-18](https://linear.app/vaper/issue/GRS-18/work-through-litigation-preparation-tools), [GRS-19](https://linear.app/vaper/issue/GRS-19/prepare-discovery-schedules-and-case-bundles), [GRS-20](https://linear.app/vaper/issue/GRS-20/rescan-local-files-and-restore-user-work-safely).

**Files.**

- [ ] Own `tests/e2e/acceptance/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `scripts/verify/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/acceptance/CC-11/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/development.md` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/user-guide.md` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Account for all 42 views and their actions with PASS/FAIL/BLOCKED and artifact pointers at the exact reviewed revision. No placeholder view passes.

- [ ] Run the complete import-to-original workflow offline, then edit, restart, backup, restore and activate a replacement without losing user work.

- [ ] Check keyboard/focus, Back, labels, contrast and layouts at 320, 390, 768 and 1280 pixels. Provide screenshots and a short walkthrough.

- [ ] Record interleaved comparable reference/head metrics and absolute local budgets. Independently review known-data defects and corrections. Request user visual review at the concrete merge-ready result; do not merge or publish under this planning task.

- [ ] A second reviewer from a different supported model family reviews the acceptance suite, verification scripts and documentation written by this gate owner, then independently reruns critical paths at the exact integrated revision. The author cannot issue their own final PASS.

- [ ] Ownership transfer after CC-03 is accepted. Extend docs/development.md serially, preserving the accepted behavior and documentation. The previous owner is no longer an active writer on these paths.

- [ ] Ownership transfer after CC-10 is accepted. Extend docs/user-guide.md serially, preserving the accepted behavior and documentation. The previous owner is no longer an active writer on these paths.

- [ ] Review all BA-01 to BA-21 dispositions against their owning issues. Applicable V1 corrections/disclosures require evidence; V2 and deferred items require an explicit scope decision and visible limitations where relevant. No known misleading conclusion may pass solely because it matches the source.

- [ ] Verify hostile imported content and original-preview isolation across the completed viewer. Report the 42-view parity result separately from production-only/deferred capabilities.

**You see.**

- [ ] An independent reviewer can verify the local release against all 42 v5 views and inspect every intentional difference.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/e2e/acceptance` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-11/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Run the reference and rewrite pilot side by side. Save `.orchestration/reports/CC-11/lane-01.png` for browser behavior or `.orchestration/reports/CC-11/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Account for every view and meaningful action. Save `.orchestration/reports/CC-11/lane-02.png` for browser behavior or `.orchestration/reports/CC-11/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Exercise all citations and original mappings. Save `.orchestration/reports/CC-11/lane-03.png` for browser behavior or `.orchestration/reports/CC-11/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Verify fixed search and numeric examples. Save `.orchestration/reports/CC-11/lane-04.png` for browser behavior or `.orchestration/reports/CC-11/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Edit every mutable state category then restart. Save `.orchestration/reports/CC-11/lane-05.png` for browser behavior or `.orchestration/reports/CC-11/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Backup and restore into a clean profile. Save `.orchestration/reports/CC-11/lane-06.png` for browser behavior or `.orchestration/reports/CC-11/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Keep the previous case active after a failed import. Save `.orchestration/reports/CC-11/lane-07.png` for browser behavior or `.orchestration/reports/CC-11/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Operate fully offline. Save `.orchestration/reports/CC-11/lane-08.png` for browser behavior or `.orchestration/reports/CC-11/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Inspect keyboard, contrast and four viewport widths. Save `.orchestration/reports/CC-11/lane-09.png` for browser behavior or `.orchestration/reports/CC-11/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Review a 30-60 second walkthrough and the differences register. Save `.orchestration/reports/CC-11/lane-10.png` for browser behavior or `.orchestration/reports/CC-11/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Cold overview, warm navigation, search and state-write p95 at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-11 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Cold overview <=2,000 ms; warm navigation/state write <=200 ms; search <=300 ms. Use at least 20 recorded samples per metric after warmup; no ratio across unlike scenarios. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-11/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Import and verify the newer 2,131-document export (CC-12)

**Depends on.** [GRS-21](https://linear.app/vaper/issue/GRS-21/verify-complete-v5-parity-and-local-release-readiness).

**Files.**

- [ ] Own `src/lib/case-package/adapters/september/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/routes/compatibility/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/compatibility/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/compatibility.md` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Identify the source format explicitly and preserve all 2,131 chronology rows, 24 DATA keys and two auxiliary top-level datasets in the observed export. Confirm counts from the source before coding.

- [ ] Handle changed shapes such as storyline records and numeric/string row positions through the format adapter, not scattered UI conditionals.

- [ ] Document extra dataset presentation or an explicit unsupported state for every new dataset. Preserve attachment sources and disclose the 4,000-character text cap.

- [ ] Re-run all v5 gates after adding compatibility. Ref collisions between versions never silently attach old notes to a different original.

- [ ] Recheck BA-04, BA-05, BA-07, BA-09 and BA-11 on the newer export. Date basis, classification/identity uncertainty, direct-versus-parent originals and email-subset coverage must be explicit wherever those datasets are presented. An unsupported view/dataset is reported as unsupported, not as a completed feature. Full metadata re-extraction and expanded OCR remain deferred.

**You see.**

- [ ] The same workspace loads the September export without replacing or weakening the v5 compatibility contract.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/compatibility` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-12/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Re-run the v5 pilot unchanged. Save `.orchestration/reports/CC-12/lane-01.png` for browser behavior or `.orchestration/reports/CC-12/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Import exactly 2,131 newer chronology rows. Save `.orchestration/reports/CC-12/lane-02.png` for browser behavior or `.orchestration/reports/CC-12/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Account for every top-level dataset. Save `.orchestration/reports/CC-12/lane-03.png` for browser behavior or `.orchestration/reports/CC-12/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Convert the changed storyline shape. Save `.orchestration/reports/CC-12/lane-04.png` for browser behavior or `.orchestration/reports/CC-12/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Render risks with category owner and refs. Save `.orchestration/reports/CC-12/lane-05.png` for browser behavior or `.orchestration/reports/CC-12/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Open an indexed attachment or its parent route. Save `.orchestration/reports/CC-12/lane-06.png` for browser behavior or `.orchestration/reports/CC-12/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Display text truncation coverage. Save `.orchestration/reports/CC-12/lane-07.png` for browser behavior or `.orchestration/reports/CC-12/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Handle a reused ref with changed file identity. Save `.orchestration/reports/CC-12/lane-08.png` for browser behavior or `.orchestration/reports/CC-12/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Reject an unrecognized third format. Save `.orchestration/reports/CC-12/lane-09.png` for browser behavior or `.orchestration/reports/CC-12/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Switch versions while preserving correctly scoped user work. Save `.orchestration/reports/CC-12/lane-10.png` for browser behavior or `.orchestration/reports/CC-12/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Import validation, overview load and search latency at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-12 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. Retain the V1 2,000/200/300 ms budgets for overview/navigation/search. Record import/memory baseline for this distinct fixture; do not compare unlike corpus sizes as a speedup. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-12/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Round-trip one manually authored analysis through Markdown (CC-13)

**Depends on.** [GRS-22](https://linear.app/vaper/issue/GRS-22/import-and-verify-the-newer-2131-document-export).

**Files.**

- [ ] Own `scripts/authoring/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `templates/analysis/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `src/lib/analysis-authoring/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `tests/authoring/**` for this unit. Reserve shared files before dispatch.

- [ ] Own `docs/manual-processing.md` for this unit. Reserve shared files before dispatch.

**Build.**

- [ ] Use one risk-analysis example to prove metadata/data-to-Markdown generation and edited-Markdown-to-structured-results parsing. Keep the parser distinct from Knap templating.

- [ ] Validate required fields, stable analysis IDs, safe rendering and citations against the chosen case version. Reject unknown refs and malformed frontmatter with line-specific feedback.

- [ ] Show the resulting risk record in the existing preview with matching values and links. Preserve generated document indexes and machine-derived facts.

- [ ] Document the manual prompts/input/results handoff and remaining unsupported analysis forms. A complete Markdown editing app and fresh OCR/AI analysis are not part of this ticket.

**You see.**

- [ ] An operator can generate a structured analysis template, edit it and import the validated result into a private local candidate.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` and `npm run test -- --run tests/authoring` against the literal acceptance examples. Record stdout, stderr and exit codes in `.orchestration/reports/CC-13/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision.

- [ ] Lane 1. Regression lane against the last accepted integration revision. Generate a risk template from known metadata. Save `.orchestration/reports/CC-13/lane-01.png` for browser behavior or `.orchestration/reports/CC-13/lane-01.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria. Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result.

- [ ] Lane 2. Edit a risk and see it in preview. Save `.orchestration/reports/CC-13/lane-02.png` for browser behavior or `.orchestration/reports/CC-13/lane-02.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 3. Follow its citation to an original. Save `.orchestration/reports/CC-13/lane-03.png` for browser behavior or `.orchestration/reports/CC-13/lane-03.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 4. Reject a missing required field. Save `.orchestration/reports/CC-13/lane-04.png` for browser behavior or `.orchestration/reports/CC-13/lane-04.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 5. Reject an unknown document ref. Save `.orchestration/reports/CC-13/lane-05.png` for browser behavior or `.orchestration/reports/CC-13/lane-05.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 6. Reject malformed frontmatter with a location. Save `.orchestration/reports/CC-13/lane-06.png` for browser behavior or `.orchestration/reports/CC-13/lane-06.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 7. Render hostile markup as safe content. Save `.orchestration/reports/CC-13/lane-07.png` for browser behavior or `.orchestration/reports/CC-13/lane-07.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 8. Keep generated chronology unchanged. Save `.orchestration/reports/CC-13/lane-08.png` for browser behavior or `.orchestration/reports/CC-13/lane-08.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 9. Repeat conversion deterministically. Save `.orchestration/reports/CC-13/lane-09.png` for browser behavior or `.orchestration/reports/CC-13/lane-09.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

- [ ] Lane 10. Document unsupported authoring forms without data loss. Save `.orchestration/reports/CC-13/lane-10.png` for browser behavior or `.orchestration/reports/CC-13/lane-10.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure Template/parse/validation elapsed time and preview update at the accepted base and candidate where comparable. Name the work newly added by this unit.

- [ ] Probe. Run `npm run measure -- --ticket CC-13 --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details.

- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.

- [ ] Rule. A single authored record validates and updates preview within 300 ms at p95; bulk authoring remains outside this ticket. Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.

**Review gate.** The user reviews changed interactions before merge into main. 

- [ ] Save a screenshot and a 30 to 60 second video under `.orchestration/reports/CC-13/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.

- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.

- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.

## Close the program

- [ ] Reconcile all spawned tasks and receipts. Verify the V1 parity and compatibility gates at the integrated revision.

- [ ] Read back Linear milestones, issues and blocking relations. Refresh the plan snapshot and report any drift.

- [ ] Update the product brief, development/user docs, differences register and the next-agent checkpoint.

- [ ] Hand back the local app and evidence. Leave V2 and Pi Durable behind their explicit phase gates.

## Appendix A. Prototype evidence

No new application prototype has been built. The existing v5 HTML is the behavioral reference. Baseline capture, local persistence/import design and the complete pilot are explicit gated work before broad implementation. The hosted compute and role choices remain decision work. No empirical question is claimed settled by this plan.

## Appendix B. Alternatives rejected

Reject a direct production rewrite as the initial acceptance target because the user selected v5 first. Reject a shared multi-tenant platform for the first hosted version because the user requested separate client instances. Reject bulk execution of archive scripts and silent reuse of legacy refs across independent builds. Keep Knap as data-to-Markdown templating with a separate parser for edited analysis.

## Appendix C. Risks

The original processing scripts and hosted import contract are missing. CC-01/02 preserve observed behavior and CC-14 investigates operator access without blocking V1. Legacy defects need explicit dispositions rather than blind parity. Large files and truncated text require honest states. CC-06 separates arithmetic checks from legal approval. Push feature branches early and preserve recoverable local state before risky Git operations. V2 deployment and product-role decisions are gated by CC-26, and CC-28 implements the hosted foundation before CC-16 starts client intake.

## Appendix D. Links and reading list

Read [scope](product-brief.md), [evidence](evidence.md), [orchestration](orchestration.md), [skill alignment](reviews/skill-alignment.md) and [view ownership](plan/view-coverage.json). The decision trail is `.audit/planning-decisions.tsv`. The installed skills live under `/home/vaper/.agents/skills/`. Use how for subsystem understanding and architect for interface decisions during implementation. Use interrogate if a design remains contested.

## Appendix E. Milestones and full issue graph

### M0 - Reference and package contract

The v5 reference is reproducible, all 42 behaviors are inventoried, and a portable candidate package validates.

- [GRS-9](https://linear.app/vaper/issue/GRS-9/freeze-the-v5-fixture-and-behavior-baseline) `CC-01`. Freeze the v5 fixture and behavior baseline. Blockers CC-27. [delivery brief](plan/tickets/CC-01.md).

- [GRS-10](https://linear.app/vaper/issue/GRS-10/validate-and-convert-a-portable-results-package) `CC-02`. Validate and convert a portable results package. Blockers CC-01. [delivery brief](plan/tickets/CC-02.md).

- [GRS-11](https://linear.app/vaper/issue/GRS-11/gate-the-reference-baseline-and-package-contract) `CC-23`. Gate the reference baseline and package contract. Blockers CC-01, CC-02. [gate brief](plan/tickets/CC-23.md).

- [GRS-35](https://linear.app/vaper/issue/GRS-35/set-up-pstack-and-verification-skills-for-agent-cli-access) `CC-27`. Set up pstack and verification skills for agent CLI access. Blockers none. [enablement brief](plan/tickets/CC-27.md).

### M1 - Complete local pilot

Import, preview, activation, overview, chronology and original-document navigation work locally before fan-out.

- [GRS-12](https://linear.app/vaper/issue/GRS-12/complete-the-local-import-to-original-document-workflow) `CC-03`. Complete the local import to original-document workflow. Blockers CC-23. [delivery brief](plan/tickets/CC-03.md).

- [GRS-13](https://linear.app/vaper/issue/GRS-13/gate-the-complete-local-pilot-before-feature-fan-out) `CC-24`. Gate the complete local pilot before feature fan-out. Blockers CC-03. [gate brief](plan/tickets/CC-24.md).

### M2 - Full v5 local parity

All 42 views, user work, exports, offline operation and acceptance evidence pass.

- [GRS-14](https://linear.app/vaper/issue/GRS-14/browse-search-and-compare-the-case-evidence) `CC-04`. Browse, search and compare the case evidence. Blockers CC-24. [delivery brief](plan/tickets/CC-04.md).

- [GRS-15](https://linear.app/vaper/issue/GRS-15/read-the-matter-narrative-and-evidence-linked-analysis) `CC-05`. Read the matter narrative and evidence-linked analysis. Blockers CC-24. [delivery brief](plan/tickets/CC-05.md).

- [GRS-16](https://linear.app/vaper/issue/GRS-16/reconcile-quantum-and-scenario-calculations) `CC-06`. Reconcile quantum and scenario calculations. Blockers CC-24. [delivery brief](plan/tickets/CC-06.md).

- [GRS-17](https://linear.app/vaper/issue/GRS-17/maintain-case-registers-without-losing-edits) `CC-07`. Maintain case registers without losing edits. Blockers CC-24. [delivery brief](plan/tickets/CC-07.md).

- [GRS-18](https://linear.app/vaper/issue/GRS-18/work-through-litigation-preparation-tools) `CC-08`. Work through litigation preparation tools. Blockers CC-24, CC-05, CC-07. [delivery brief](plan/tickets/CC-08.md).

- [GRS-19](https://linear.app/vaper/issue/GRS-19/prepare-discovery-schedules-and-case-bundles) `CC-09`. Prepare discovery schedules and case bundles. Blockers CC-24, CC-07. [delivery brief](plan/tickets/CC-09.md).

- [GRS-20](https://linear.app/vaper/issue/GRS-20/rescan-local-files-and-restore-user-work-safely) `CC-10`. Rescan local files and restore user work safely. Blockers CC-24, CC-07. [delivery brief](plan/tickets/CC-10.md).

- [GRS-21](https://linear.app/vaper/issue/GRS-21/verify-complete-v5-parity-and-local-release-readiness) `CC-11`. Verify complete v5 parity and local release readiness. Blockers CC-04, CC-05, CC-06, CC-07, CC-08, CC-09, CC-10. [gate brief](plan/tickets/CC-11.md).

### M3 - Newer export and manual authoring

The 2,131-document export and one structured Markdown authoring round trip pass without v5 regressions.

- [GRS-22](https://linear.app/vaper/issue/GRS-22/import-and-verify-the-newer-2131-document-export) `CC-12`. Import and verify the newer 2,131-document export. Blockers CC-11. [delivery brief](plan/tickets/CC-12.md).

- [GRS-23](https://linear.app/vaper/issue/GRS-23/round-trip-one-manually-authored-analysis-through-markdown) `CC-13`. Round-trip one manually authored analysis through Markdown. Blockers CC-12. [delivery brief](plan/tickets/CC-13.md).

- [GRS-24](https://linear.app/vaper/issue/GRS-24/gate-newer-export-compatibility-and-the-manual-authoring-contract) `CC-25`. Gate newer-export compatibility and the manual authoring contract. Blockers CC-12, CC-13. [gate brief](plan/tickets/CC-25.md).

### M4 - Hosted readiness decisions

Operator-contract evidence is recorded and client isolation, roles, durable storage and hosting are resolved.

- [GRS-25](https://linear.app/vaper/issue/GRS-25/confirm-the-existing-operator-results-import-contract) `CC-14`. Confirm the existing operator results-import contract. Blockers none. [discovery brief](plan/tickets/CC-14.md).

- [GRS-26](https://linear.app/vaper/issue/GRS-26/resolve-client-isolation-roles-and-cloudflare-deployment) `CC-15`. Resolve client isolation, roles and Cloudflare deployment. Blockers CC-25. [decision brief](plan/tickets/CC-15.md).

- [GRS-27](https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation) `CC-26`. Gate the hosted design before client intake implementation. Blockers CC-15. [gate brief](plan/tickets/CC-26.md).

### M5 - Hosted manual workflow

Client intake through private review and human-approved publication passes staging acceptance.

- [GRS-28](https://linear.app/vaper/issue/GRS-28/submit-and-resume-client-document-uploads) `CC-16`. Submit and resume client document uploads. Blockers CC-28. [delivery brief](plan/tickets/CC-16.md).

- [GRS-29](https://linear.app/vaper/issue/GRS-29/notify-operators-and-download-a-complete-submission) `CC-17`. Notify operators and download a complete submission. Blockers CC-16. [delivery brief](plan/tickets/CC-17.md).

- [GRS-30](https://linear.app/vaper/issue/GRS-30/import-processed-results-into-a-private-hosted-preview) `CC-18`. Import processed results into a private hosted preview. Blockers CC-17, CC-13. [delivery brief](plan/tickets/CC-18.md).

- [GRS-31](https://linear.app/vaper/issue/GRS-31/sign-off-and-publish-an-exact-results-version) `CC-19`. Sign off and publish an exact results version. Blockers CC-18. [delivery brief](plan/tickets/CC-19.md).

- [GRS-32](https://linear.app/vaper/issue/GRS-32/verify-hosted-isolation-recovery-and-release-readiness) `CC-20`. Verify hosted isolation, recovery and release readiness. Blockers CC-19. [gate brief](plan/tickets/CC-20.md).

- [GRS-36](https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work) `CC-28`. Implement hosted identity, client provisioning and durable user work. Blockers CC-26. [delivery brief](plan/tickets/CC-28.md).

### M6 - Future processing automation

Deferred Pi Durable design and implementation preserve human publication approval.

- [GRS-33](https://linear.app/vaper/issue/GRS-33/design-pi-durable-processing-against-the-proven-manual-contract) `CC-21`. Design Pi Durable processing against the proven manual contract. Blockers CC-20. [future brief](plan/tickets/CC-21.md).

- [GRS-34](https://linear.app/vaper/issue/GRS-34/automate-processing-with-recovery-and-candidate-only-output) `CC-22`. Automate processing with recovery and candidate-only output. Blockers CC-21. [future brief](plan/tickets/CC-22.md).

CC-27 supplies the agent tooling and plan synchronization that CC-01 waits for; it implements no application behavior. CC-14 remains open until the old contract is verified. It is not a dependency of V1 or a reason to invent an operator route. CC-26 can explicitly accept the new contract while deferring legacy migration. M6 stays parked. No later-phase implementation starts without a concrete verification recipe and resolved product decisions.

## Appendix F. Audit dispositions by issue

The browser audit findings BA-01 to BA-21 and their full dispositions live in the [Linear delivery plan](https://linear.app/vaper/document/clearcase-delivery-plan-and-acceptance-gates-518b0c44b87a). CC-01 owns the repository register `docs/reference/audit-dispositions.md`, CC-23 verifies it and CC-11 reviews every finding against its owner. Each line below lists the issues whose acceptance text names that finding.

- BA-01. CC-06.

- BA-02. CC-06.

- BA-03. CC-06.

- BA-04. CC-03, CC-12.

- BA-05. CC-04, CC-12.

- BA-06. No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it.

- BA-07. CC-04, CC-07, CC-12.

- BA-08. No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it.

- BA-09. CC-12.

- BA-10. No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it.

- BA-11. CC-12.

- BA-12. No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it.

- BA-13. No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it.

- BA-14. No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it.

- BA-15. No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it.

- BA-16. No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it.

- BA-17. CC-04.

- BA-18. CC-03.

- BA-19. CC-15, CC-20, CC-28.

- BA-20. CC-15, CC-20, CC-28.

- BA-21. No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it.
