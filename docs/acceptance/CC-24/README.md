# CC-24 / GRS-13 gate evidence

**Verdict: HOLD.** Required coordinator reservations and one independent adversarial report are missing. Keep M2 closed.

Reviewed application revision: `5aa7b91c3011ded3af57c3c14a23096d64712786`. This evidence layer changes no implementation files. The complete local report, receipts, private screenshots and raw measurements remain in the coordinator's local `.orchestration/reports/CC-24/` directory.

The gate remains closed until the acceptance conditions, including ownership transfer, are satisfied. The runtime checks pass under Bun 1.4.2 in a network namespace with no external interface. The reservation ledger still holds CC-03's broad `src/routes/**` reservation and has no M2 owner route reservations or coordinator reservation for the shared layout and persistence paths. `ownership-plan.json` is the precise transfer request; it does not claim that the coordinator has activated those reservations.

## Reproduction

Build a clean checkout of the reviewed revision with `bun install --frozen-lockfile`, `bun run --bun check` and `bun run --bun build`. Keep the built app separate from this evidence commit: the acceptance runner checks the production build's revision, clean stamp and Bun version.

Run the synthetic acceptance tests from this evidence checkout:

```sh
export CLEARCASE_RECEIPTS_DIR=/absolute/local/CC-24/receipts
scripts/agent-tools/receipt --name cc24-synthetic --base 5aa7b91c3011ded3af57c3c14a23096d64712786 --input tests/acceptance/CC-24/run.mjs -- bun tests/acceptance/CC-24/run.mjs --app-root /absolute/clean-reviewed-checkout --out /absolute/local/CC-24/synthetic
```

The runner starts the real production entry under Bun, imports synthetic packages through the app, drives Chromium, proves loopback binding and SQLite pragmas, checks both Host guards, verifies preview isolation, rejects malformed and over-limit candidates without losing notes, kills the server and verifies restart recovery. It uses the repository's network wrapper to bring loopback up and restore the outer UID. No acceptance boundary is mocked.

Optional `--corpus /absolute/hostile-corpus` adds the independent synthetic HTML, SVG, XML, active-PDF and HTML/PDF cases. Original XML is downloaded, rather than parsed as an imported dataset. An inert text preview or an attachment is a valid safety outcome; a polyglot need not render successfully.

Check extension points and the coordinator's current reservations:

```sh
scripts/agent-tools/receipt --name cc24-ownership --base 5aa7b91c3011ded3af57c3c14a23096d64712786 --input tests/acceptance/CC-24/extension-points.mjs -- bun tests/acceptance/CC-24/extension-points.mjs --root /absolute/clean-reviewed-checkout --oracle /absolute/view-oracle/oracle-42.json --reservations /absolute/coordinator/reservations.tsv --out /absolute/local/CC-24/ownership.json
```

An exit of 1 preserves the failed ownership conditions. Omitting `--reservations` checks the registry and planned scopes only; that narrower result is insufficient to open M2.

The literal `unshare -rn bun run --bun test:e2e` fails on this host because Chromium sees namespace UID 0 and the parent namespace has loopback down. The successful equivalent keeps both isolation layers, uses `tests/e2e/pilot/offline.sh` in the parent, and unsets `CLEARCASE_OFFLINE` and `CLEARCASE_OFFLINE_NETNS` before starting the suite's own wrapper. A long `TMPDIR` also prevented Chromium startup; the local launcher sets only Chromium's internal temporary directory to `/tmp`, preserving its sandbox, arguments and browser binary. Profiles and all app data stay in the disposable report directory. Failed attempts are retained in the report.

## Evidence limits

The real v5 workflow checks all nine required steps, exactly 1,689 base records and all 42 navigation destinations. Two views are implemented; the other 40 are explicitly unavailable. The real v5 narrative contains no `[[REF]]` citations, so page routing also has synthetic coverage.

All three M2 contracts exist, are typed, have regression tests and are documented in `docs/development.md`. Adversarial probes also establish latent gaps in provider validation, widget serialization and generic restores. These are recorded individually in the local report; an M2 owner must address relevant gaps before exposing them to ordinary app input.

Measurements use the unchanged pilot script, 20 retained samples and two discarded warmups per metric and revision. Revision batches run in ABBA order. “Cold” means a fresh browser context; the server and OS page cache remain warm. The reviewed revision's two p95 results, in milliseconds, are:

| Metric | Budget | First repeat | Second repeat |
|---|---:|---:|---:|
| Usable overview | 2,000 | 86.7 | 69.4 |
| Warm navigation | 200 | 87.7 | 85.6 |
| PDF first page | 500 | 381 | 228 |
| Download start | 300 | 34.4 | 26.4 |

The first repeat overlapped other gate checks. The largest PDF can exceed the p95 budget individually because serving verifies the whole original first; both measured p95 values pass. Raw case-dependent sample lists remain local.

GRS-37 and GRS-38 are separate units outside the reviewed application revision. Their acceptance and integration remain prerequisites for M2. Initial worker concurrency stays at three; the memory snapshot does not measure four workers' peak demand.

After the v5 checks, the real newer 2,131-document export was smoke-tested. Conversion and served import reject its unsupported build-report shape, offer no activation, and preserve the active v5 case. The observation passes the preservation check; newer-export compatibility remains unaccepted.
