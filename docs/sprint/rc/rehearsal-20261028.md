# RC rehearsal, Wednesday 28 October 2026

Staging checks run before the Monday 2 November gate. They are single passes, run from the coordinator's EU host, so they give functional coverage only. The gate's p95 comes from three runs from the South African network, recorded in `2026-11-02.md`.

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
| J5 | viewer, read-only | PASS | 24 of 24 views; slowest 1,428 ms (quantum) |
| J10 | viewer, read-only, `IDLE_MINUTES=20` | PARTIAL | every idle check PASS: 0 401, 0 503, 0 failed requests, 0 page errors, session survived; the two write steps are skipped under read-only |

## Journeys at d85fd6ae (editor, writes on)

| Journey | Verdict | Over budget |
|---|---|---|
| J7 notes | FAIL (latency) | case notes list 2,218 ms |
| J8 deadlines | PASS | none; save 1,345 ms |
| J9 bundles | FAIL (latency) | bundle save 3,425 ms |

The RC latency fix (`sprint/grs-266-rc-latency`) targets these two steps and Discovery.

## Open before the gate

- Sign-in: the measured 12 to 16 s includes fixed waits in the probe and the journey harness. The per-phase breakdown is on `sprint/grs-266-signin-timing`. Production Clerk instances are the owner's decision.
- Preload of two notes, two deadlines and one custom bundle: to be recorded in `preload.md`.
- The colleague's 390 px phone check, recorded in the Human log.
