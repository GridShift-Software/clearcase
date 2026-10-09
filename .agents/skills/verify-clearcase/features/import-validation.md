# Import and validation report

Import results lets a user name a case folder of originals and a results package (folder or .zip), validate the package against the contract and the originals without changing the active version, and read a validation report with a verdict (accept, report or reject), the results version, diagnostics grouped by code and, when stored, a verified candidate.

## Sub-features

- `import-form` validates a folder package against a case folder from the Import results form.
- `import-progress` shows hashing progress while a long validation runs, and offers cancellation.
- `report-verdict` shows the verdict, results version, manifest digest and the stored copy's verification.
- `report-diagnostics` lists errors, warnings (new for this case or already accepted) and info by code.
- `report-reject` explains a rejected package; nothing is stored and the active version is unchanged.
- `report-noop` reports a byte-identical re-import as already stored, with nothing written.
- `imports-list` lists previous imports with verdict and outcome.

## How to get to it (user POV)

- Choose `Import results` in the top bar (`#nav-import`), or open `/` while no version is active (it redirects to `/import`).
- Choose a row's number under `Previous imports` to reopen its report at `/import/<id>`.
- Without JavaScript the same form posts to `?/import` and redirects to the report.

## Driving it with verify-clearcase

Preconditions:

- The run's instance passed the live doctor; the data directory is fresh, so `Previous imports` reads `No imports yet.`
- The synthetic case folder and package exist under the run's scratch.

- **Fill and validate.** Type the case folder into `#caseFolder` and the package folder into `#packageSource`, then choose `#validate`. Step `import-form`. The page moves to `/import/<id>` and `main[data-ready=import:<id>]` appears.
- **Read the verdict.** Step `validation-report`. `main[data-verdict]` is `report` for the synthetic case (warnings CITE_UNRESOLVED, TEXT_NONE and V5_META_COUNT_DISAGREEMENT, no errors). `#results-version` equals the package's results version, `#verify-state` reads `verified` and `#active-state` reads `not active`. As a second view, `GET /` still redirects to `/import`.
- **Diagnostics.** In the same step, `#diag-summary` reads `0 errors, 4 warnings (4 new for this case)` and each `details[data-code][data-severity]` group is listed.
- **Rejected package.** *Not yet driven.* Build a package with a contract error (e.g. `buildCase` with an `edit` that breaks a required field) and import it. `data-verdict=reject`, `#verdict-msg` says nothing was stored, and `/` is unchanged.
- **Identical re-import.** *Not yet driven.* Submit the same two paths again. The report URL carries `?noop=1` and `#noop-msg` appears.
- **Proof.** `screens/01-import-form-filled.png` and `screens/02-validation-report.png`, with the values in `inner.json` under `import-form` and `validation-report`.

## Gotchas

- `main[data-ready=import]` is in the server HTML, so it is true before hydration, and hydration resets typed values. Refill until the values hold, as `import-form` does, and report `refills`.
- Both fields are `required`: an empty field blocks the submit silently (browser validation) and the wait times out.
- Validation of large originals takes time; wait up to 60 s for the report, not a fixed sleep.
- The case folder must be a disposable synthetic copy; the importer reads it, and later steps may change it for negative controls.
