# Local case fixtures

Case archives, extracted originals and anything derived from their content stay outside Git. This page sets up the v5 reference fixture on a fresh machine and says where everything lives. The baseline it reproduces is described in [docs/reference/](../../docs/reference/README.md).

## Requirements

- Linux with Python 3.11 or later (verified with 3.14.7); no Python packages are needed.
- The designated archive `CASE_Lawyer_Pack_v5-002.zip` (3,257,868,481 bytes, sha256 `(pinned in scripts/fixtures/profiles/v5-002.json)`). On puk it is in `/home/operator/Work/Active/MX-two/ClearCase/RAWS/`, which is read-only by rule.
- About 3.3 GB free for the extracted tree.
- For screens only: Node 22 or later, `unshare` from util-linux with unprivileged user namespaces enabled, and a Chromium headless shell (puk: `~/.cache/ms-playwright/chromium_headless_shell-1223/...`).

## Locations

| What | Default | Override |
| --- | --- | --- |
| Archive | `/home/operator/Work/Active/MX-two/ClearCase/RAWS/CASE_Lawyer_Pack_v5-002.zip` | `--archive` or `CLEARCASE_FIXTURE_ARCHIVE` |
| Fixture root (not a Git repository, not RAWS) | `/home/operator/Work/Active/MX-two/ClearCase/fixtures` | `--fixture-root` or `CLEARCASE_FIXTURE_ROOT` |
| Extracted tree | `<root>/v5-002/tree/` (files read-only) | `--tree` |
| Inventory outputs | `<root>/v5-002/inventory/zip/` and `.../tree/` | `--out` |
| Expected examples | `<root>/v5-002/expected/expected-examples.json` | `--examples` |
| Screens and evidence | `.orchestration/reports/CC-01/` in the `dev` clone (ignored) | command argument |

On another machine, put the archive anywhere outside the repository and set `CLEARCASE_FIXTURE_ARCHIVE` and `CLEARCASE_FIXTURE_ROOT`. The expected-examples file is case-bearing and is not in Git: copy it from puk's fixture root, then check its sha256 against [expected-examples.md](../../docs/reference/expected-examples.md).

## Set up and verify

```sh
export CLEARCASE_FIXTURE_ROOT=/home/operator/Work/Active/MX-two/ClearCase/fixtures   # or your own path
sha256sum /home/operator/Work/Active/MX-two/ClearCase/RAWS/CASE_Lawyer_Pack_v5-002.zip
python3 scripts/fixtures/inventory.py --extract            # extract once; every file's size and CRC-32 is checked
python3 scripts/fixtures/inventory.py --verify             # from the zip: profile, committed summary, examples
python3 scripts/fixtures/inventory.py --source tree --verify  # from the extracted tree: identical outputs
cmp "$CLEARCASE_FIXTURE_ROOT"/v5-002/inventory/zip/inventory.json "$CLEARCASE_FIXTURE_ROOT"/v5-002/inventory/tree/inventory.json
python3 -m unittest discover -s scripts/fixtures/tests -v  # synthetic data only, no fixture needed
python3 scripts/fixtures/leak_check.py                     # no tracked file holds case strings or case dates
python3 scripts/fixtures/leak_check.py --range BASE..HEAD   # the same over every blob and message in a commit range
python3 scripts/fixtures/count_actions.py                  # recount the view checklist's actions and form fields
python3 scripts/fixtures/perf.py --runs 7 --baseline-median 2.67
```

`--extract` never writes outside the tree: entries with absolute paths, `..`, drive letters, backslashes or symlink modes are refused, existing files must match the archive, and nothing is written under the archive's folder. `--verify` exits 0 only when every check passes, 1 when one fails and 2 for a missing input; the checks are printed one per line. Every build, with or without `--verify`, takes the main HTML pinned by the profile when the archive holds a pinned file (otherwise it chooses by content, never by name or build date) and stops with exit 2, writing nothing, when the pinned main is absent, a root HTML cannot be parsed or no single candidate is complete by content; a bundles-only variant is never promoted. Two runs over an unchanged fixture write byte-identical `inventory.json`, `summary.json` and `examples.json`; timings and the archive path are only in `run.json`.

`--write-summary` regenerates `docs/reference/v5-summary.json` from the fixture. Use it only when the baseline itself changes, and review the diff.

## Screens without network

```sh
scripts/fixtures/capture-screens PLAN.json /home/operator/Work/Active/MX-two/ClearCase/clearcase/.orchestration/reports/CC-01/screens
```

The wrapper runs Node and the browser inside `unshare -rn`, so they have no network at all, and drives the browser over `--remote-debugging-pipe`. A plan fixes the clock and timezone and lists views, optional seeded `localStorage` and steps (see the header of `capture-screens.mjs`). Opening the workspace runs its own UI code, which is what a screen shows; no archive processing or build script is run, and no data is taken from the page except the probes that confirm expected examples. `capture.json` records each probe and every non-file request (there must be none). Screens are private: never commit them.

## Synthetic fixtures

`scripts/fixtures/tests/synth.py` builds small invented archives (unflagged UTF-8 names, missing originals, duplicate and missing refs, escaping links, symlinks, swapped or ambiguous variants) at test time. Committed tests use only these; their dates are invented, and `leak_check.py` checks that none equals a case date.
