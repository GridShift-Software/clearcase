# Bounded historical audit delivery runner

Implementation: `src/lib/server/runtime/hosted/recoveries.ts`.
Status: SQL/component diagnostics only. Native D1/workerd/provider validation is **UNRUN**.
The underlying trusted recovery port is not recertified by these diagnostics.

## Parent installation and composition hooks

- Add `src/lib/server/runtime/hosted/migrations/0001_audit_recovery_cursor.sql` to the owned schema assembler and install it before invoking recovery on each client D1. The runner never executes DDL. Missing schema refuses recovery.
- Compose the runner in services with the raw primary-capable deployment DB, its configured client ID, explicit finite budget, trusted committed candidate/publication recovery ports and real publication receipt reader.
- Scheduler installation and invocation remain parent work. No scheduler, timer, provider action or request route is added here.
- Call `run()` independently of request identity and selected case. No continuation argument or process-local memory is needed, including after restart.

## Private durable state and API

`native_audit_recovery_cursor` has primary key `(client_id, case_id, kind)` and columns `after_at`, nullable `after_id`, and integer `revision`.
The deployment-wide `cases` row uses an empty case ID; `candidate`, `signoff` and `operation` rows use their real case ID.
Rows are lazily initialized, persist through runner/process restart, and are not deleted on wrap or successful delivery.
This table contains traversal keys only, never grants, approvals, audit ACKs or settlement/application proof.
Existing source rows, including failures and invalidation, are retained.

The factory signature and progress fields are unchanged. `run(afterCaseId?)` still validates a supplied legacy hint but ignores it for traversal; callers cannot override durable discovery with it.
`nextCaseCursor` is now a diagnostic snapshot of the durable case cursor, not a required input for the next call. Concurrent progress can move that snapshot ahead.

## Paging and overlap

- Cases and candidate intents use increasing case/candidate IDs. Signoffs use `(signed_at, signoff_id)`; receipt-bearing operations use `(at, operation_id)`.
- Each selection reads at most its configured limit plus one key for lookahead. Only the configured limit is attempted. Candidate hydration is per item, so a malformed source cannot abort later items in that page.
- After attempting the selected page, including failures, advance its cursor. At the end of the ordered sources, wrap to null. Older failures and new sources inserted behind a cursor become eligible again on the next traversal.
- The case cursor advances only after its selected cases have been processed. No caller-supplied case filter is used.
- All cursor/source discovery and readbacks use a `first-primary` session after checking the deployment storage identity.
- Each cursor update compares the loaded revision and increments it, even on wrap. Overlapping invocations may duplicate attempts, but a stale invocation cannot overwrite newer progress, including after a full wrap (ABA).
- An uncertain write is resolved by primary readback. A newer revision is kept, never overwritten or blindly retried. No revision progress is a storage fault. An interrupted attempt before cursor commit is retried; a committed cursor survives a lost answer and restart.
- Each dimension must be an integer from 1 through 20; `maxCases * (maxCandidateIntentsPerCase + maxSignoffsPerCase + maxOperationsPerCase) <= 100`. Concurrency does not enlarge an individual invocation's attempt budget. There is no retry loop or wall-clock timeout claim.

## Settlement authority stays unchanged

Candidate and signoff settlement require exact source-proven audit event ACKs. Operations additionally require an exact real apply receipt matching the entire historical intent; pointer equality is not proof.
Recovery never publishes, withdraws, reapproves, regrants, replaces the historical requester, or clears signoff invalidation.
Cursor advancement does not settle or quarantine a failed source: it stays pending and retryable.

## Focused diagnostics

The seven original tests in `tests/hosted-foundation/runtime/native-recovery.test.ts` are preserved; only their setup installs the new migration.
`tests/hosted-foundation/native-recovery-runner/fairness.test.ts` covers permanent oldest failures and valid later work for all three kinds, per-item malformed hydration, exact ACK refusal, retained failures and reattempt, more cases than a page, insertion behind the cursor, restart, all four cursor overlap/wrap races, lost cursor ACKs before/after commit, schema installation and strict attempt budgets.
Tests use synthetic SQLite/D1 transport and explicit fault injection, not native acceptance boundaries. Run with Bun, a private targeted Vitest include and `maxWorkers: 1`; the integration owner must separately run native validation after schema/service composition.
