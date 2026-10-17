# Prove the first complete hosted PDF case workflow before broad view migration

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view) is the execution authority.

Planning key `HA-first-workflow`. Accepted by the user in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). This creates an execution owner, not a dispatch.

## Outcome

One exact hosted revision proves a small synthetic PDF case through client upload, operator queue/claim/download, actual manual processing with the current prompts/recipe, private import/editing, fresh sign-off, publication and authorized client viewing. Broader workspace migration and the thick intake, queue, import, editing and publication owners wait for this accepted evidence.

## Reserved write scope

* `src/routes/v/[vid]/overview/**` — minimal hosted published-case read path only; sole writer until explicit handoff to the overview/evidence migration owner.
* `tests/hosted-smoke/**`
* `scripts/verify/hosted-smoke.mjs`
* `docs/acceptance/hosted-smoke.md`

**Restructured 17 October 2026.** This is the tracer bullet, not the final verifier. It runs directly after the foundation aggregate (<issue id="3ee13f2b-c1b4-44bb-9c43-cd750b3623e5" href="https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work">GRS-36</issue>) and the hosted gate, and before the intake, queue, import, editing, publication and view-migration owners. It builds the thinnest end-to-end slice of each stage itself, on the foundation contracts: a single-file upload with no resume, a claim with no FIFO ordering, a package import with no editing, a sign-off with no rollback, and the published overview with the existing originals viewer. Each later owner thickens its stage from this ticket's accepted head and takes over the paths below. This owner does not own all 42 views or the viewer shell, and it serializes any shared layout change through its existing owner.

Additional minimal reservations, handed to the named owner at acceptance: src/routes/client/intake/\*\* and src/lib/submissions/\*\* (to <issue id="29ff2f3f-0e74-4750-951e-c27851e2b166" href="https://linear.app/vaper/issue/GRS-28/submit-and-resume-client-document-uploads">GRS-28</issue>), src/lib/processing-queue/\*\* and src/routes/admin/queue/\*\* (to <issue id="b97a8bee-9190-453b-9a7d-6e98099ad25f" href="https://linear.app/vaper/issue/GRS-135/implement-the-internal-fifo-processing-queue-and-audited-operator">GRS-135</issue>), src/routes/admin/submissions/\*\* (to <issue id="e0957bbc-d8e6-4215-8073-65795f406468" href="https://linear.app/vaper/issue/GRS-29/notify-operators-and-download-a-complete-submission">GRS-29</issue>), src/lib/results-review/\*\* and src/routes/admin/results/\*\* (to <issue id="bbd61cf6-18f0-4a4f-a234-e40700eedf51" href="https://linear.app/vaper/issue/GRS-30/import-processed-results-into-a-private-hosted-preview">GRS-30</issue> and <issue id="be596ca1-3a0e-4ef9-a39f-172d65b2bf2c" href="https://linear.app/vaper/issue/GRS-130/edit-and-revalidate-private-results-before-exact-version-approval">GRS-130</issue>), src/lib/publication/\*\* and src/routes/admin/publication/\*\* (to <issue id="07b2f5cd-c6a9-432a-88e0-0c0ff13e69c5" href="https://linear.app/vaper/issue/GRS-31/sign-off-and-publish-an-exact-results-version">GRS-31</issue>).

## Acceptance

- [ ] At one exact hosted SHA, submit a fresh synthetic PDF case, claim and download it completely, follow the current manual processing recipe and produce a complete valid results package linked to the exact inputs. Do not substitute parity data, mocked output or an incomplete pilot.
- [ ] Import privately; clients are denied candidate content. Correct candidate content, invalidate any previous approval, revalidate and explicitly sign off the new exact version before publishing.
- [ ] Through a real client session, open the published overview and PDF original, follow a valid source reference and verify bytes/content. Deny unauthorized, wrong-case/client and private-candidate requests.
- [ ] Keep previous publication and user work intact on a selected failed import/publication attempt. Record outputs, identities, task/check receipts, commands and exact SHA.
- [ ] Use PDF-only coverage for this small test without weakening publication validation for files actually in the candidate. Office/email/accepted media/archive coverage and all 42 views remain mandatory in final acceptance; this test cannot satisfy that broader gate.
- [ ] Hand the exact overview files and accepted upstream head to the broad overview/evidence migration owner. Obtain fresh independent review of implementation and any verification code; the author cannot self-certify the path.

## Human gate: the manual processing step

Decided by the user on 17 October 2026. The processing step (running the current prompts and recipe on the downloaded submission to produce the results package) is a **human gate**, not agent work, because a processing run is expensive and is not yet trusted unattended. The worker builds and proves everything up to the operator download, then stops with status `AWAITING MANUAL RESULTS` and a report naming the exact submission manifest, the download path and the expected package shape. The user runs the recipe in their own chat, as processing is done today, and places the resulting package at a path they name on the ticket. A fresh worker session then resumes from the import step at the same SHA. The checkpoint sitting for this ticket includes that handoff. No agent may run the processing recipe under this ticket.

## Verification and boundaries

Execute a real hosted synthetic workflow, with browser evidence and retained downloaded/generated package manifests; record PASS/HOLD/FAIL at the exact SHA via receipt tooling. Freeze concrete boot/test commands and fixture expectations in the design gate/dispatch brief before execution. Shared files and browser capacity follow the operating plan. A skip, mock, weak assertion or another-SHA run is not PASS. Existing external review is required before dev integration. All hosted checks remain UNRUN now.

RAWS/current production read-only; real case material, private evidence and secrets stay out of Git and external test/agent services. No main merge, production deployment, live email or cloud provisioning is authorized by this planning issue. Read live native blockers before pickup.
