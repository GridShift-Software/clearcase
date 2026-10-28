# RC rehearsal, Wednesday 28 October 2026

Staging checks run before the Monday 2 November gate. They are single passes, run from the coordinator's EU host, so they give functional coverage only. They do not establish the gate's p95: that needs three runs from the South African network on Monday, still to be done and recorded in `2026-11-02.md`.

## Rollback

Rolled back from 269ff017 to d85fd6ae with `scripts/deploy-staging.sh --rollback`, then redeployed 269ff017 with `scripts/deploy-staging.sh`.

| Step | From | To | Worker version | Wall time | Smoke |
|---|---|---|---|---|---|
| Rollback | 269ff017 | d85fd6ae | 02b5308e-6f4c-4c73-8d48-e8db11904c22 | 24 s | PASS |
| Redeploy | d85fd6ae | 269ff017 | 3dc05193-45d2-4fcb-bc0d-4b35bb586b66 | 42 s | PASS |

Both are under the 2-minute limit. No migrations lie between the two SHAs, so no D1 restore was needed; a rollback across a migration needs the D1 bookmark from the deploy log and the runbook.

## Journeys at 269ff017

| Journey | User | Verdict | Notes |
|---|---|---|---|
| J1 | viewer, read-only | PASS | 42 entries; Document Diff 833 ms; Discovery 1,350 ms |
| J5 | viewer, read-only | PASS | 24 of 24 views; slowest 1,428 ms (quantum). Heads passed on its documented empty state (J5 accepts it since #192); populated Heads entries were not checked here |
| J10 | viewer, read-only, `IDLE_MINUTES=20` | PARTIAL | every idle check PASS: 0 401, 0 503, 0 failed requests, 0 page errors, session survived; the two write steps are skipped under read-only |

## Journeys at d85fd6ae (editor, writes on)

| Journey | Verdict | Over budget |
|---|---|---|
| J7 notes | FAIL (latency) | case notes list 2,218 ms |
| J8 deadlines | PASS | none; save 1,345 ms |
| J9 bundles | FAIL (latency) | bundle save 3,425 ms |

The RC latency fix (`sprint/grs-266-rc-latency`) targets these two steps and Discovery.

## Full run at d25a66ab (run-all J1 to J10, editor, writes on)

One `run-all.mjs` pass with `IDLE_MINUTES=20`, after the latency fixes (#194, #196) and the sign-in hop cut (#197). `/health` reported d25a66ab at the start, the end and in all 135 checks between.

| Journey | Steps other than sign-in | Slowest step / budget | Sign-in |
|---|---|---|---|
| J1 | all 40 PASS (shell and 39 menu entries) | quantum 1,400 / 2,000 ms | 9,808 ms |
| J2 | PASS | overview 483 / 2,000 ms | 9,326 ms |
| J3 | PASS | one-click citation 827 / 2,000 ms | 14,537 ms |
| J4 | PASS, three bands | largest first PDF page 2,000 / 3,000 ms | 9,685 ms |
| J5 | all 24 views PASS | quantum 817 / 2,000 ms | 9,129 ms |
| J6 | PASS | search 450 / 2,000 ms | 9,184 ms |
| J7 | PASS | note save 1,329 / 2,000 ms | 8,704 ms |
| J8 | PASS | deadline save 1,339 / 2,000 ms | 8,802 ms |
| J9 | PASS | bundle save 1,333 / 2,000 ms | 8,868 ms |
| J10 | PASS, 20-minute idle, session survived, save after idle | resume document 1,250 / 2,000 ms | 8,781 ms |

Network across the run: 0 4xx, 0 5xx, 0 401, 0 503, 0 failed requests, 0 page errors.

Every sign-in completed without an error but took 8.7 to 14.5 s against 5 s, so every journey fails on that step alone; this is GRS-269. Each run starts a fresh browser, which gets the development Clerk instance's new-device code step, and about 6 s of each sign-in is that instance. The owner's GRS-267 decision accepts the development instance as an interim (about 6.6 s warm, 11 to 13 s cold); sign-in is judged at 5 s again after the switch to the production instances (`docs/sprint/runbooks/09c-clerk-instance.md`).

After the run, staging's audit log reached its 10,000-event cap. The cap fails closed, so every signed-in page and every save or delete answered 503 until the cap was raised to 1,000,000 (GRS-270, #200, deployed at e6109523). The journey cleanup ran into it. The run's leftover rows were removed afterwards, and a reload confirmed that the five preload items are unchanged.

## Open before the gate

- GRS-268, the sign-in callback binding fix, merged and deployed to staging before Monday's runs.
- Monday's three runs from the South African network, recorded in `2026-11-02.md`.
- The colleague's 390 px phone check, recorded in the Human log.
- Preload: recorded in `preload.md`.
