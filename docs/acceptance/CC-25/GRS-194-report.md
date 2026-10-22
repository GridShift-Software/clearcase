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
