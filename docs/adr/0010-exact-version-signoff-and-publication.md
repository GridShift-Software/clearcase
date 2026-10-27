---
status: accepted
date: 2026-10-15
---

# Exact-version sign-off and publication

Processed results enter private review as candidates. Uploading or validating a package does not make it client-visible. On 15 October the user confirmed the publication rules in [Define private preview, approval and client publication](https://linear.app/vaper/issue/GRS-88/define-private-preview-approval-and-client-publication).

Global Admin and designated operators may publish only through their explicitly granted case access and publication authority. For alpha, the person who prepared results may also approve them, through a separately recorded sign-off. This permits the initial small service team to operate without requiring a second person for every job, while retaining a record of the human decision.

Approval binds one exact results version. Any later change creates a new candidate requiring fresh approval. Future processing automation uses the same candidate-import contract as manual uploads and does not gain publication authority.

The reviewer checks document counts, missing originals, citation problems, validation warnings and changes since the previous publication. Hard validation failures block publication; warnings require acknowledgement with reasons.

Unrecognized analysis sections may be retained privately for review and repair. Unsupported or invalid required sections block publication until they validate and display correctly; opaque storage with a warning is not complete presentation. A failed required file preview holds the whole update in the same way ([ADR-0011](0011-originals-and-complete-in-app-file-viewing.md)); the prior publication stays available. This boundary is confirmed in the [POC and export reconciliation decision](https://linear.app/vaper/issue/GRS-92/reconcile-poc-demo-and-newer-export-work-with-the-hosted-plan).

See [ADR-0013](0013-real-exports-publish-from-step-built-evidence-and-records-views.md) for the accepted records-view interpretation for required datasets without a native view.

Authorized publishers may restore a previous approved version without losing client user work, recording the action. If no safe version exists, they may withdraw results from client access.

Later submissions extend the existing case. Operators receive full case context with added or changed files identified. Processing produces a new complete results version and preserves client notes, registers and other user work.

Corrections to service-team processing mistakes keep their job's operator and priority. They do not receive the back-of-queue treatment for submissions missing client-supplied files or passwords.

Private candidate review within the client instance is the leading architecture, conditional on proving its suitability and excluding client access through routes, APIs, originals, exports and caches. The user also permits separate review staging if that works better. Software-test staging is a separate purpose. Neither review topology has been proved by a hosted deployment.

Reviewers can edit candidate text, headings, formatting, citations and structured fields through suitable controls. Changed calculation inputs trigger recalculation and validation. A saved correction changes the results and therefore creates a new candidate identity that requires validation and fresh approval. This permission is separate from client user-work editing and does not authorize changing originals or application source code.

Each saved correction batch records who changed it, when, the before/after values and a brief reason. Corrections remain part of published and exported results. Later processing surfaces prior corrections for the reviewer to retain or replace and flags conflicts instead of silently overwriting them.

The product workflow is settled. Detailed review topology and its access-isolation proof remain obligations of the hosted design gate. The overall planning gate ([GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha)) remains open.

## Cases without a publication, 17 October

In [Stress-test the complete hosted-alpha plan with final workflow scenarios](https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow) the user confirmed that a case exists without a publication: before its first publication, and after authorized staff withdraw its results. Its authorized users keep their originals, case-level Notes, case costs and other user work that does not depend on results. How originals open before publication is set in [ADR-0011](0011-originals-and-complete-in-app-file-viewing.md).

Results-dependent views show a designed waiting or unavailable state with a meaningful reason and the relevant next action or status. They never show placeholder or invented results, and they keep user work and access intact. None of this gives clients access to a private candidate, bypasses revoked access, exposes withdrawn results or requires a navigation redesign. Work that does not depend on results is reached through the case's stable identity rather than a resultsVersion; concrete routing belongs to the implementing tickets.
