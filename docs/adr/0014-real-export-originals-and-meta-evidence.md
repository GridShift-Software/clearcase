---
status: proposed
date: 2026-10-27
---

# Real-export originals and META evidence policies

These policies are proposed and await the user's decision. They are not accepted by [ADR-0013](0013-real-exports-publish-from-step-built-evidence-and-records-views.md), which covers records views and step-built evidence on Workers Paid. They would affect [ADR-0011](0011-originals-and-complete-in-app-file-viewing.md) and the proposed [ADR-0012](0012-integrity-metadata-is-not-a-view.md).

## Originals and previews

A PDF would be `rendered` when its exact bytes open in the pinned renderer, its page count is known, and the first and every cited page rasterise. A non-PDF would need a faithful pipeline-generated preview bound to the original's hash, with generated pagination labelled. Embedded attachments would need to be extracted as originals with their parent recorded.

An uncited missing original would be shown as not supplied and clear only with acknowledgement; a cited missing original would hold. ADR-0011's no-download-only rule for published results remains unchanged unless the user separately amends it; these proposals do not waive its in-app viewing, fidelity or citation requirements.

## META reconciliation

For legacy exports, a META whose counts disagree with its records could be `disagrees`, never `integrity-verified`, only if the gate's own derivation finds exactly the disagreeing counts and each has a matching diagnostic fingerprint acknowledged with a reason. Unverifiable counts or unmatched disagreements remain `invalid`; displayed counts come from records, not incorrect META. New exports should compute META from emitted records.

No implementation or publication is verified by this proposal.
