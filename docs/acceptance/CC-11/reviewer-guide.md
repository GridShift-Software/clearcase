# CC-11 reviewer guide: rerun the critical paths

For the second reviewer of GRS-21 (CC-11). The gate's author cannot give its final PASS. Rerun these commands at the exact revision you review, on a clean tree, and compare your results with [README.md](README.md) and [matrix.md](matrix.md). A skipped step, a mocked check or a run at another revision is not a PASS.

## Before you start

1. Check out the revision and confirm that the tree is clean:

   ```sh
   git rev-parse HEAD
   git status --porcelain          # must print nothing
   ```

2. Install and run the doctor:

   ```sh
   bun install --frozen-lockfile
   scripts/agent-tools/doctor
   ```

3. Copy the coordinator's current `.local/v5-verification.json` into the checkout. The v5 steps need it; the gate names the expected resultsVersion when it is stale.

4. Admit the browser jobs ([Browser admission](../../development.md#browser-admission-grs-154)). On the shared host (PUK) export nothing: leave `CLEARCASE_BROWSER_LOCK` unset and a checkout under the ClearCase workspace discovers `orch-bin/browser-lock` itself, taking a slot per browser job. Or export the absolute path of the installed lock. A relative path is refused. `BROWSER_LOCK` is the retired spelling and must be unset, even empty. Check what this checkout resolves before the long runs:

   ```sh
   unset BROWSER_LOCK
   bun scripts/browser-lock.mjs        # stdout: the lock; stderr: how it was admitted; exit 2 and the fix if refused
   # or, instead of discovery: export CLEARCASE_BROWSER_LOCK=/abs/path/to/ClearCase/orch-bin/browser-lock
   ```

   `CLEARCASE_BROWSER_LOCK=none` runs browser jobs without a slot. Use it only on an isolated runner or CI host with no workspace lock, never to get past a refusal on the shared host. The gate, `evidence.sh` and the hosted runner refuse before running any step when admission is missing or invalid.

## Critical paths

Run them in this order. Each command prints a summary line; every step must exit 0 unless the README records the failure.

| # | Command | What it proves | Expected |
| --: | --- | --- | --- |
| 1 | `bun run --bun gate` | build, check, unit tests, every e2e suite (browser, durability, the seven category suites, the UI class suite), strict parity over the 42 views, and the ten real-v5 lanes | `GATE PASS <sha>` |
| 2 | `scripts/verify/evidence.sh acceptance` | the whole offline workflow (AC1 to AC8): import, originals, every mutable state category, restart, backup into a clean profile, a failed import, a replacement, hostile content in all 42 views | `acceptance suite: 8/8 scenarios passed` |
| 3 | `scripts/verify/evidence.sh layout` | 42 views at 320, 390, 768 and 1280 px on the synthetic case: layout, labels, keyboard and Back, contrast | the failures listed in README.md, and no others |
| 4 | `scripts/verify/evidence.sh layout-v5` | the same on the real v5 sample (screenshots stay in `.local/GRS-21/layout-v5/shots/`) | as step 3 |
| 5 | `scripts/verify/evidence.sh metrics` | cold overview and warm navigation interleaved with the v5 reference, search and state write, against the budgets | every head p95 within its budget |
| 6 | `scripts/verify/evidence.sh dispositions matrix` | the defect table and the matrix, regenerated from steps 1 to 5 | no diff against the committed `defects-table.md` and `matrix.md`, apart from timings |

Step 6 rewrites `docs/acceptance/CC-11/matrix.md` and `defects-table.md`. Compare them with `git diff`, then restore them with `git checkout docs/acceptance/CC-11`.

Each step writes its log to `.local/GRS-21/<step>.log` and its results under `.local/GRS-21/`. The gate writes its own to `.local/gate/`.

## What to read, not rerun

- **Parity per view:** `.local/gate/parity-out/scorecard.md` (counts only). The per-view JSON holds case values; keep it local.
- **The acceptance scenarios:** `.local/GRS-21/acceptance-out/acceptance/<scenario>.json`, one file per scenario with its checks.
- **Layout failures:** the `failures` list of `.local/GRS-21/layout-synthetic/layout.json`.
- **Screenshots:** `.local/GRS-21/layout-*/shots/`, listed with their sha256 in `layout.json` (`shots`). Measure layout with the scripts. Don't judge it from screenshots.

## Review the author's own files

The gate's author wrote these files. Review them as part of the gate:
- `tests/e2e/acceptance/suite.mjs`;
- `scripts/verify/*`;
- `docs/acceptance/CC-11/*`;
- the GRS-21 sections of `docs/development.md` and `docs/user-guide.md`.

`git diff c064458..HEAD --stat` lists every change; no file under `src/` changes.
