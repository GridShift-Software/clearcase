# Case directory and trusted case provisioning (native alpha)

Code: `src/lib/tenancy/case-directory.ts` (request-safe) and `src/lib/tenancy/case-provisioning.ts` (provisioning only).
Tests: `tests/hosted-foundation/provisioning/case-directory.test.ts` (node:sqlite stand-ins; not D1 or workerd evidence).

## Case directory

`d1CaseDirectory({ db, deployment })` is the `CaseDirectory` the case authorizer asks. It reads this client's own `rs_case`
table (GRS-115); there is no second registry. One SELECT joins the `rs_storage_identity` singleton to the case, so the
database must name the deployment's client and layout `clearcase.rs/1` in the same read. An unbound, foreign or
other-layout database, another client's id, an unknown case and a malformed id all answer `false`. A storage fault rejects
with the retryable `storage-unavailable`, which the authorizer turns into `identity-unavailable`. It issues only SELECT.
`lookupCase` is the same read, exported for the provisioning module.

## Case provisioning

`createCaseProvisioning({ deployment, db, audit, now }).provisionCase({ operator, caseId, title })` creates one synthetic,
empty case with no results or upload. `audit` is the `ProvisioningAuditPort` (`provisioningAuditPort` from `$lib/audit/provisioning`),
so the event actor is `{ kind: 'system', component: 'provisioning', operator }` and never a verified person. No input can
set the actor.

- Input: `caseId` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$`; `title` is 1 to 200 characters, trimmed, with no control or bidi characters; `operator` is a run label.
- Rows: one `rs_case (case_id, case_label)` row, which every storage adapter statement refers to. No publication row means no publication. The insert is guarded by the identity row in the same statement.
- Results: `provisioned` (with `repeated`), `invalid`, `refused` (storage identity), `conflict` (`title-differs` or `audit-mismatch`), `audit-pending` (row in place, event not confirmed; replay completes it). A storage fault throws `storage-unavailable`.
- Idempotent and immutable: a replay with the same id and title appends nothing new; another title conflicts. A concurrent creator is resolved by reading what is stored.
- Audit: event id `case-provision:<caseId>`, action `case.provision`. A replay finds the stored event and ignores its time and run label; anything else stored under that id is `audit-mismatch`.

## Assumptions and limits

- The database's `rs_storage_identity` row and the bucket's `identity/client.json` are provisioned with the deployment; this module never writes them.
- `rs_case` has no owner or created column; the owner is the client the database is bound to. No schema change is needed.
- A case row is visible before its audit event is confirmed (`audit-pending`). It is inert without grants, and the caller should retry until `provisioned`.
- Parent composition: export `d1CaseDirectory` from the tenancy index; never export or import `case-provisioning.ts` from the hosted graph, and add it to the `scripts/ci/hosted-imports.ts` provisioning-only list.
