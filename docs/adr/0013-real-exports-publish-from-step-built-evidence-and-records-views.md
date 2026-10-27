---
status: accepted
date: 2026-10-27
---

# Real exports publish from step-built evidence and records views

On 27 October 2026, the user accepted records views and chose to stay on Workers Free in the orchestration session. Real exports are too large to validate and check for publication in a single request without exceeding runtime limits. Sampling or raising list caps would not prove completeness.

## Required datasets

This amends how [ADR-0010](0010-exact-version-signoff-and-publication.md)'s requirement that required datasets “validate and display correctly” applies when a dataset has no native view. A registered dataset may clear sign-off as `records-rendered` when its verified projection validates against its committed schema and a labelled, schema-driven records view displays every record and schema-named field. The gate checks every record identity and leaf in the server render. The client sees “Source records. The calculated view is not yet available.” Citations resolve to original routes; warnings remain visible. No records or nested values are sampled, truncated or replaced by counts.

`records-rendered` is never `valid`: `valid` means the native view rendered and was checked. A records view must not take the native view's name or invent calculated totals. Readiness distinguishes records views from native views; unknown or invalid required datasets still hold publication.

## Evidence and runtime

Publication evidence is persisted per observation, bound to the candidate and exact inputs, and built in resumable, lease-claimed steps. Immutable evidence rows are sealed in pages under an evidence root; sign-off binds that root and publication recomputes it, refusing changed evidence. Readiness uses complete counts and cursor-paginated item lists, not caps or samples. Warning acknowledgements retain every fingerprint and a reason.

The deployment stays on Workers Free. Evidence steps are sized to Free's per-request CPU limit using measured safe bounds; import, readiness and publication reads must also fit that limit, with staging split as needed. A step that cannot fit holds honestly, refused or retryable; the budget is never silently raised.

## Originals and integrity metadata

A PDF is `rendered` when its exact bytes open in the pinned renderer, its page count is known, and the first and every cited page rasterise. A non-PDF needs a faithful pipeline-generated preview bound to the original's hash, with generated pagination labelled. Embedded attachments must be extracted as originals with their parent recorded. An uncited missing original is shown as not supplied and clears only with acknowledgement; a cited missing original holds.

[ADR-0011](0011-originals-and-complete-in-app-file-viewing.md)'s no-download-only rule for published results is unchanged. These evidence and missing-original rules do not waive its in-app viewing, fidelity or citation requirements.

This also amends the proposed [ADR-0012](0012-integrity-metadata-is-not-a-view.md): META counts derived from records that disagree may be `disagrees`, not `integrity-verified`, only when each disagreement has its matching diagnostic fingerprint acknowledged with a reason. Unverifiable counts or unmatched disagreements remain `invalid`; displayed counts come from records, not incorrect META. New exports should compute META from emitted records.

These decisions do not claim that the implementation or real-export publication has been verified.
