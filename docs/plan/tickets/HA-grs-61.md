# UI class suite: close the last two fail-open paths (dialog "answered", CSV discovery)

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-61/ui-class-suite-close-the-last-two-fail-open-paths-dialog-answered-csv) is the execution authority.

Follow-up from <issue id="6428a777-8c34-48b8-a5b6-0d0a249a4574" href="https://linear.app/vaper/issue/GRS-59/p1-kit-one-shared-e2e-test-per-ui-bug-class-run-over-every-form-and">GRS-59</issue>'s re-check (`.orchestration/reports/GRS-59/recheck.md`). The one fix round closed the four highs. These two narrower mediums of the same class (a check that passes without setting up its bug) remain:

1. **Class 3 (dialog vs in-flight save):** `tests/e2e/classes/suite.mjs:405` sets `answered: !!answered || closedBySave`. That is a runtime escape, not a `declared.mjs` reason: "closed by the save" counts as answered without checking that the question actually closed, and a disabled Discard also counts. In the gate run, 8 of 12 ask-then-save scenarios pass this way without Discard being clicked. Make the scenario click Discard (or the page's answer), or declare per target why the save closes the question, and check that it did.
2. **CSV discovery:** `csvExports` (`tests/e2e/classes/targets.mjs:46-63`) silently drops a CSV producer that is a non-route `.ts` file or a component nested inside another component. Neither is mapped to a page nor counted as `unrecognised`. Nothing escapes today, but a new producer could. Map it, or fail as unrecognised.

Also from the re-check, lows:

* a failed note delete says "note not saved";
* the backup restore says "no answer" even when the app answered;
* the CSV check passes when only `.ics` or `.txt` files download;
* `run.mjs` checks classes only when the suite reports them;
* `LeaveGuard` duplicates the focus code in `askFocus`.

## Done when

Each path fails on a reintroduced shape, `bun run --bun gate` passes, and the diff is reviewed once. Then the coordinator removes classes 3 and 4 from `REVIEW.md`.
