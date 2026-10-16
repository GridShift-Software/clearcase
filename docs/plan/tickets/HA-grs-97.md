# Evaluate viewer components and freeze alpha file coverage

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-97/evaluate-viewer-components-and-freeze-alpha-file-coverage) is the execution authority.

## Outcome

A dedicated viewer evaluation selects maintained components or a justified custom approach and freezes a testable alpha viewer contract before the hosted design gate. This is planned execution work, not a wayfinder decision or permission to start implementation now.

## Scope

Compare established viewer components against the resolved file-viewing decision and software-audit criteria. Use representative synthetic files and a bounded component harness. Record versions, maintenance, licenses, dependencies, fidelity limits and the reason to adopt, adapt or build. Do not send case material to external viewer services.

## Acceptance

- [ ] Map every accepted format to an in-app original view or a faithful prepared preview. PDF/images/Word/Excel/EML-MSG are minimum coverage; accepted media/ZIP contents also need a verified viewing path. Downloads remain optional.
- [ ] Exercise original versus processed-preview references, rendition version/page mappings, supplied sheet/cell/range and message/attachment targets, and explicit file-level references. Unmatched supplied locations require repair, not guessed mappings or silent clamping.
- [ ] Exercise workbook tabs/search, exact values, hidden content, missing formula results and meaningful chart/format/comment content; email headers/body and nested attachments; media playback/seeking; archive entries and contained-file previews.
- [ ] Evaluate desktop and mobile usability, keyboard/focus, zoom/find/page navigation where applicable and large files at the initial POC scale. Report actual browser methods and failures; documentation support is not runtime evidence.
- [ ] Freeze the format/codec matrix, preview-readiness and candidate-import contracts, file reservations and concrete integration checks. A failed preview holds the whole update. Flag any original-integrity/range-delivery proof still needed at the design gate.
- [ ] Provide an independent verdict on the exact evaluation revision. This component evaluation does not replace the final hosted viewer pass in release acceptance.

## Write scope

Evaluation harness, synthetic viewer fixtures, and docs/acceptance/viewers/\*\*. Production viewer implementation is separate delivery work to be sliced in the approved implementation plan.

## Boundaries

Blocked by the alpha planning gate, stack decision and resolved viewer inputs. No dispatch until planning is approved. No deployment, production changes, real case data, secrets, or merge without the required review.

Provider-neutral email coverage: the user explicitly requires Outlook- and Gmail-origin messages to be importable, processable and viewable. Include synthetic exports from both in the coverage matrix, preserving headers/body/inline and regular attachments plus provenance. Distinguish individual email files from bulk mailbox archives; explicitly record which archive formats are accepted and any manual extraction/conversion required. Do not silently treat Google-origin email as out of scope or infer a Gmail API connection from this file-viewing requirement. Live mailbox integration scope and registration design are being resolved separately in the integration decision.

Delivery handoff: [Implement the protected in-app viewer shell and PDF/image readers](<https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers>), [Implement faithful Word and Excel viewing and prepared renditions](<https://linear.app/vaper/issue/GRS-121/implement-faithful-word-and-excel-viewing-and-prepared-renditions>), [Implement Outlook and Gmail email-file and attachment viewing](<https://linear.app/vaper/issue/GRS-122/implement-outlook-and-gmail-email-file-and-attachment-viewing>) and [Implement accepted media and archive-contained viewing paths](<https://linear.app/vaper/issue/GRS-123/implement-accepted-media-and-archive-contained-viewing-paths>) implement the selected contract after the design/foundation gates. This issue evaluates and freezes coverage; it does not own production routes. Canonical plugin discovery must pass first.

Concrete evaluation reservation: tests/viewer-evaluation/\*\* (harness and synthetic fixtures) and docs/acceptance/viewers/\*\*. Do not edit production viewer routes/components. Hand the frozen contract to the existing implementation owners after the independent design gate.
