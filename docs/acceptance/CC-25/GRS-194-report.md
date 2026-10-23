# GRS-194 presentation evidence

**HOLD for final compatibility approval.** The user authorized implementation of four missing presentation groups on 22 October 2026. That instruction is not contract approval. GRS-24 and GRS-27 remain open.

## Changes

Matter & Strategy presents supplied evidence anchors and the organogram, including a diagram, full node/connection lists and citations. The Timeline groups date-bounded phases by explicit event membership; ambiguous membership remains visible for review. Consistency checks include validated `source_checks` without inventing counts. The 42-view navigation stays unchanged.

## Recorded runs before the review fix

At `3423d90b8c9423e623c8b7556e6d24305635093e`, Linux Docker Desktop, Bun 1.4.2 and ordinary uid 1001:

- Package/analysis suite: PASS, 1,082 tests in 41 files, exit 0. Receipt `20261022T181046.350803Z-grs194-package-analysis`.
- Production build: PASS, exit 0. Receipt `20261022T181120.358941Z-grs194-build`.
- Offline analysis browser suite: PASS, 22/22 scenarios including AN-194, exit 0. Receipt `20261022T181351.456526Z-grs194-analysis-browser`. Synthetic screenshots include anchors/organogram, timeline and checks, and the anchor citation was followed to its document.
- `verify-clearcase` real-app skill: PASS, exit 0, including live instance identity, import, activation, citation/original viewer, 42-view navigation and the existing system workflows. Receipt `20261022T181457.309902Z-app`; skill evidence `20261022T181457Z-7472`. The new presentation action is covered separately by AN-194.
- Type/Svelte/schema/link/source checks: PASS at `f1f69a1624ef` (full SHA in receipt), exit 0; `20261022T180916.389296Z-grs194-check`. These are historical results, not acceptance of a later revision.

Evidence is under the user-requested Desktop `ClearCase Acceptance/reports/`, with receipt JSON files beneath `receipts/`. The Desktop `runner/` contains the Dockerfile and reusable PowerShell commands. Initial failures and their logs are retained: missing Chromium libraries, root bypassing permission tests, Bun worker selection, and assertions for the intentionally replaced residual behavior.

## Review and regression

Independent standards and spec reviews at `3423d90b` found hidden Unicode display protection missing, secondary timeline refs omitted, and stale compatibility expectations. The standards reviewer also suggested deriving the date-phase model from its schema. See [review and dispositions](GRS-194-review.md).

Both behavioral regressions fail at `10630fa6ad632e448633fb8531fe8b2af054743d`: `20261022T181546.380827Z-grs194-review-red`, exit 1, two failed tests. Final post-fix results will be recorded after the fixes and fresh recheck.

## Outstanding acceptance

- Real v5/newer/JSON samples and the coordinator's `.local/v5-verification.json` are absent. The Desktop private-samples directories are empty. Full gate, strict real-v5 parity and real-export CC-25 are HOLD/UNRUN; no synthetic substitute counts.
- Current real-export mapping expectations are explicit in `docs/compatibility.md`; their source counts come from prior observations, not a new run. Unknown shapes still require repair. No guarantee about the actual private organogram edge shape is made without the real sample.
- Doctor reports missing external agent skill installations on this host. The app/runtime checks and individual receipts are reported independently, without claiming a doctor PASS.
- No hosted routes, Cloudflare provisioning, provider acceptance, production publication or `main` merge occurred.
- After the real-export evidence and independent verdict pass, present the revised contract to the user. Only their explicit sign-off completes the human decision.

## Final implementation verification, 22 October 2026

Product revision `73de954ed5d5ac7a2373f73a0628c40058c0eebd`; later changes through `f744e2d35832dd487377a915bd9ce8757c5d10cc` only isolate test imports, record guard scope and refresh one parity-register evidence line (35 to 37). No approval or parity disposition changed.

- At `73de954e`: type/Svelte/schema/link/source checks PASS, exit 0 (`20261022T183058.350895Z-grs194-final-check`); production build PASS, exit 0 (`20261022T183119.449913Z-grs194-final-build`).
- At `73de954e`: offline analysis browser PASS, 22/22, exit 0 (`20261022T183125.229540Z-grs194-final-browser`); verification skill PASS (`20261022T183206.848823Z-app`, evidence `final-pilot/skill/20261022T183206Z-5013`). Screenshots are in `final-e2e/analysis/screens/grs194-*.png`. The browser followed the anchor's page citation and checked all four presentation groups, with no application egress or script execution.
- At `73de954e`: the full unit run was **FAIL**, 3,382 passed and 2 failed (`20261022T183108.573429Z-grs194-final-full-unit`). Both failures were the parity register's stale evidence line. The generator refreshed that line without changing the disposition or approval.
- At `f744e2d3`: the affected suite, including package, analysis, synthetic-generator and register-disposition tests, **PASS**, 1,108 tests in 45 files, exit 0 (`20261022T183639.437640Z-grs194-final-affected`). This is an affected-suite rerun, not a claim of a new full-suite PASS.
- At `f744e2d3`: fix-round guard PASS for **two existing TypeScript class invariants**, exit 0 (`20261022T183606.811660Z-test-guard`). It cannot resolve Svelte component imports; the component regressions remain runtime-tested and independently reviewed but **not protected by that guard**. The manifest explicitly records this limit. No named assertion was weakened.
- Independent standards recheck PASS at `c6515964185db14dc558cc23fad1b15b99cc8401`; final spec recheck PASS with no remaining findings at `495f9d2ca21da1c6616a0b8c1e5efd65d1faf829`. These are source verdicts, not runtime acceptance. The final recheck's primary-only timeline Unicode regression failed before the fix at `df8fefc5` (`20261022T182319.765386Z-grs194-recheck-red`) and is covered by the passing affected suite afterwards.

The first broad test run also exposed a missing synthetic-generator dataset and a container lifecycle problem. The generator now emits anchors and organogram; the runner uses Docker `--init` so orphaned child processes are reaped. Lifecycle tests pass in the later full run. Test commands are reproducible with the Desktop `runner/Run-Test.ps1`; detailed stdout/stderr and full SHA stamps remain in the receipts.

The real v5/newer/JSON gate and human contract decision remain HOLD. This implementation is suitable for a **draft** PR, not an acceptance or merge claim.
