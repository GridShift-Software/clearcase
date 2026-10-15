# Import and validation report

The Import results page (`/import`, heading "Open a case") offers two ways in. "Open a case" imports a case pack: the user names the case, picks a pack .zip or extracted folder in a folder browser, optionally changes where it is stored, and chooses Open case; ClearCase extracts the pack, converts its workspace HTML and checks every original. "Already have a results package?" takes a case folder of originals and a results package (folder or .zip) and validates the package against the contract and the originals. Both end on a validation report with a verdict (accept, report or reject), the results version, diagnostics grouped by code and, when stored, a verified candidate. Neither changes the active version.

## Sub-features

- `import-package` validates a results package against a case folder from the "Already have a results package?" form.
- `import-case-pack` imports a case pack (.zip or folder) chosen in the folder browser, under a case name and a storage destination.
- `import-progress` shows progress while a long import runs (`#import-progress` for a package, `#import-case-stage`/`#import-case-progress` for a case pack), and offers cancellation (`#cancel-import`).
- `report-verdict` shows the verdict, results version, manifest digest and the stored copy's verification.
- `report-diagnostics` lists errors, warnings (new for this case or already accepted) and info by code.
- `report-reject` explains a rejected package; nothing is stored and the active version is unchanged.
- `report-noop` reports a byte-identical re-import as already stored, with nothing written.
- `imports-list` lists previous imports with case, results version, verdict and outcome.

## How to get to it (user POV)

- Choose `Import results` in the top bar (`#nav-import`).
- On the case list (`/cases`, where `/` always redirects), choose `Import a case` (`#import-case-link`), or `Open` on a case that has only a candidate to reopen its report.
- Choose a row's number under `Previous imports` to reopen its report at `/import/<id>`.
- Without JavaScript the package form posts to `?/import` and the case-pack form to `?/importCase`; both redirect to the report.

## Driving it with verify-clearcase

Preconditions:

- The run's instance passed the live doctor; the data directory is fresh, so `Previous imports` reads `No imports yet.`
- The synthetic case folder and package exist under the run's scratch.

- **Fill and validate a package.** Under "Already have a results package?", type the case folder into `#caseFolder` and the package folder into `#packageSource`, then choose `#validate`. Step `import-form`. The page moves to `/import/<id>` and `main[data-ready=import:<id>]` appears.
- **Read the verdict.** Step `validation-report`. `main[data-verdict]` is `report` for the synthetic case (warnings, no errors). `#results-version` equals the package's results version, `#verify-state` reads `verified`, `#active-state` reads `not active` and `#activate` is offered. As a second view, `GET /` redirects to `/cases`, and the case list's `Open` link for the synthetic case leads back to `/import/<id>`.
- **Diagnostics.** Step `validation-report`: `#diag-summary` reads `0 errors, 5 warnings (5 new for this case).` (ASSET_MISSING_AT_BUILD, CITE_UNRESOLVED, TEXT_NONE, V5_META_COUNT_DISAGREEMENT, plus info codes) and each `details[data-code][data-severity]` group is listed. The step records these values; it does not assert the counts.
- **Import a case pack.** *Not yet driven.* Type a name into `#case-name`, choose `#add-documents`, pick a synthetic pack in the folder browser dialog, then `#import-case`. The synthetic case is a results package, not a case pack, so this needs an invented pack in the format `src/lib/case-package/v5/` adapts.
- **Rejected package.** *Not yet driven.* Build a package with a contract error (e.g. `buildCase` with an `edit` that breaks a required field) and import it. `data-verdict=reject`, `#verdict-msg` says nothing was stored, and the case list is unchanged.
- **Identical re-import.** *Not yet driven.* Submit the same two paths again. The report URL carries `?noop=1` and `#noop-msg` appears.
- **Proof.** `screens/01-import-form-filled.png` and `screens/02-validation-report.png`, with the values in `inner.json` under `import-form` and `validation-report`.

## Gotchas

- The package form is the second card on the page, below the case-pack steps; the filled-form screenshot shows it scrolled into view.
- `main[data-ready=import]` is set after mount, so typed values hold once it appears.
- The package form's fields are `required`: an empty field blocks the submit silently (browser validation) and the wait times out.
- Validation of large originals takes time; wait up to 60 s for the report, not a fixed sleep.
- `/` no longer tells you whether a version is active: it always redirects to `/cases`. Read the case card (`li[data-case][data-status]`, `Open` link) instead.
- The case folder must be a disposable synthetic copy; the importer reads it, and later steps may change it for negative controls.
