---
status: accepted
date: 2026-10-15
---

# Preserve originals and require complete in-app file viewing

Clients need to inspect case material without leaving the workspace to download files. In [Define in-app file viewing and original integrity](https://linear.app/vaper/issue/GRS-90/define-in-app-file-viewing-and-original-integrity), the user chose in-app viewing for every accepted alpha file, with faithful generated file previews permitted alongside unchanged originals. Downloads remain optional. PDF, common images, Word, Excel and EML/MSG email are minimum coverage, not an exhaustive list or permission to leave another accepted format download-only. Email files exported from Outlook and from Gmail are both covered. Live mailbox connections, provider-side drafts and syncing are later work ([GRS-99](https://linear.app/vaper/issue/GRS-99/plan-live-outlook-and-gmail-integrations-after-alpha)), not part of this record.

Spreadsheets use a read-only workbook viewer with sheet tabs and searchable cells, preserving displayed values and structure. Email presents headers, body and attachments together, with each attachment viewable in the app.

Hidden sheets, rows and columns remain accessible and are labelled. When a formula has no stored result, show the formula and a value-unavailable state rather than inventing a value. Where a grid cannot represent meaningful visual content, a faithful supplementary preview or operator repair is required.

For paginated documents, alpha requires verified document-and-page citations. Invalid page references must be explicit errors and must never be silently moved to another page. Precise passage highlighting may follow later.

Converted previews identify their reviewed version and page. Preserve supplied original-document references and show original and processed-preview references when they differ and a verified mapping exists. Do not label generated pagination as original pagination. An unmatched supplied reference holds the candidate for operator repair; any reviewer correction is audited and requires fresh approval.

For non-paginated files, citations open the supplied sheet/cell or range, or the relevant email message or attachment. References without a precise location are explicitly labelled file-level; the app must not invent precision.

The user also supports playback of accepted audio/video and browsable archives with contained-file previews, subject to feasibility. Format, codec and archive limits must be established before promising coverage.

A failed file preview holds the submitted update for operator repair. The last published results version remains available to clients. This extends the [exact-version review and publication decision](https://linear.app/vaper/issue/GRS-88/define-private-preview-approval-and-client-publication): preview readiness must be checked before approval and publication of the complete update.

Complete case exports include originals, their published previews and a manifest linking their identities and references. Originals and previews are clearly separated. Notes are excluded unless explicitly selected.

PDF bundle input files and generated bundle outputs are durable case assets, as set in the [alpha integration decision](https://linear.app/vaper/issue/GRS-91/define-alpha-behavior-for-every-production-integration), which owns the wider integration policy. A generated version pins the input versions, order and index it was built from. Regeneration creates a new version and never overwrites an earlier one. By default every version is kept. An explicitly configured history limit keeps the latest version plus the N previous unpinned versions. Versions marked Keep and every source file are always protected, so a limit never removes them. N is a runtime setting with no fixed default. The limit applies only to generated bundle history; it does not govern originals, published results, private candidates or general case retention.

The user requires a dedicated viewer evaluation and quality pass. Compare established components before choosing what to adopt or build, then verify accepted-format coverage, fidelity, citation navigation and desktop/mobile usability at exact revisions. Hosted file delivery must preserve the existing original-integrity guarantees; the feasibility research does not establish a replacement for them.

This rejects download-only fallbacks and publishing the rest of an update while leaving one accepted file unreadable. It increases preview-generation and review work, which the manual processing workflow must accommodate.

This record settles original preservation, required web access, citation/reference behavior, complete exports, publication completeness and the durability of PDF bundle files and versions. Specific viewer libraries, operational limits and hosted performance remain design and verification work. A file preview is distinct from private operator review of a candidate results version. No implementation or hosted acceptance is claimed.
