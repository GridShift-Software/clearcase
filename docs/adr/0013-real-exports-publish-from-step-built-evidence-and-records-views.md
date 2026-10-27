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

These decisions do not claim that the implementation or real-export publication has been verified.
