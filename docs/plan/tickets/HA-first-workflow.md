# Prove the first complete hosted PDF case workflow before broad view migration

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view) is the execution authority.

Planning key `HA-first-workflow`. Accepted by the user in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). This creates an execution owner, not a dispatch.

## Outcome

One exact hosted revision proves a small synthetic PDF case through client upload, operator queue/claim/download, actual manual processing with the current prompts/recipe, private import/editing, fresh sign-off, publication and authorized client viewing. Broader workspace migration waits for this accepted evidence.

## Reserved write scope

* `src/routes/v/[vid]/overview/**` — minimal hosted published-case read path only; sole writer until explicit handoff to the overview/evidence migration owner.
* `tests/hosted-smoke/**`
* `scripts/verify/hosted-smoke.mjs`
* `docs/acceptance/hosted-smoke.md`

Underlying auth/storage/viewer/intake/queue/import/editing/publication owners implement their own contracts first. This owner integrates the minimal overview and evidence; it does not recreate those services, bypass their checks, or own all 42 views. Serialize any shared layout change through its existing owner.

## Acceptance

- [ ] At one exact hosted SHA, submit a fresh synthetic PDF case, claim and download it completely, follow the current manual processing recipe and produce a complete valid results package linked to the exact inputs. Do not substitute parity data, mocked output or an incomplete pilot.
- [ ] Import privately; clients are denied candidate content. Correct candidate content, invalidate any previous approval, revalidate and explicitly sign off the new exact version before publishing.
- [ ] Through a real client session, open the published overview and PDF original, follow a valid source reference and verify bytes/content. Deny unauthorized, wrong-case/client and private-candidate requests.
- [ ] Keep previous publication and user work intact on a selected failed import/publication attempt. Record outputs, identities, task/check receipts, commands and exact SHA.
- [ ] Use PDF-only coverage for this small test without weakening publication validation for files actually in the candidate. Office/email/accepted media/archive coverage and all 42 views remain mandatory in final acceptance; this test cannot satisfy that broader gate.
- [ ] Hand the exact overview files and accepted upstream head to the broad overview/evidence migration owner. Obtain fresh independent review of implementation and any verification code; the author cannot self-certify the path.

## Verification and boundaries

Execute a real hosted synthetic workflow, with browser evidence and retained downloaded/generated package manifests; record PASS/HOLD/FAIL at the exact SHA via receipt tooling. Freeze concrete boot/test commands and fixture expectations in the design gate/dispatch brief before execution. Shared files and browser capacity follow the operating plan. A skip, mock, weak assertion or another-SHA run is not PASS. Existing external review is required before dev integration. All hosted checks remain UNRUN now.

RAWS/current production read-only; real case material, private evidence and secrets stay out of Git and external test/agent services. No main merge, production deployment, live email or cloud provisioning is authorized by this planning issue. Read live native blockers before pickup.
