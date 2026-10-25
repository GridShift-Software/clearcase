# Trusted initial case grants

## Scope and API

`src/lib/tenancy/case-grant-provisioning.ts` is a **trusted, non-request** producer for the offline owned synthetic alpha seed. It is not exported from the tenancy index. Its only method is:

```ts
createCaseGrantProvisioning({ deployment, grants, cases, audit, now, newGrantId? })
  .grantCase({ operator, operationId, target, caseId, role, expiresAt })
```

- `deployment`: the exact validated deployment returned by `resolveExactDeployment`, from trusted configuration, never request input.
- `grants`: the **same primary `GrantRepository`** that case authorization uses, normally `d1GrantRepository(db)`.
- `cases`: the actual `d1CaseDirectory({ db, deployment })`, over that deployment's own storage identity and `rs_case` rows, not a synthetic allow-all directory.
- `audit`: the provisioning-only `provisioningAuditPort({ db, config, now })` from `src/lib/audit/provisioning.ts`, with append and exact event lookup. The audit binding must already be provisioned for this client.
- `now`: the trusted clock. Optional `newGrantId` is the engine's identifier hook; defaults to a UUID and must produce an audit-compatible object identifier.
- `target`: `{ issuer, subject, kind: 'client' | 'staff' }`. The issuer must equal this deployment's issuer for that exact kind; membership metadata is not authority.
- `caseId`: one existing case in this client's database. Unknown, unbound, foreign-client and foreign-layout databases cannot authorize a write, including a replay's activation.
- `role`: exactly `viewer`, `editor`, `operator` or `publisher`. Viewer/editor share one content slot; operator and publisher are distinct capabilities, not implicit content readers. **No client-wide scope, grant-admin, upload-originals authority, updates or revocations.** Upload provisioning remains separate.
- `expiresAt`: an exact ISO instant in the future for a new operation, or `null`. The original expiry never changes on replay.

The return is the existing `ManageResult`: `applied` (with grant and repeated flag), `invalid`, `conflict`, `audit-pending`, or the shared engine's stale outcome. Operator labels are bounded identifiers, not identities. Operation IDs are at most 119 characters because the engine's `grant-op:` prefix must fit the 128-character audit event ID. Case IDs and target subjects must also fit their existing audit identifier grammars.

## Attribution and lifecycle

The ledger records `operation: 'create'`, actor `{ issuer: 'control-plane:<clientId>', subject: operator, kind: 'control-plane' }`, and a distinct canonical request array beginning with `case-provision`. This namespace is attribution only; it is not a client/staff issuer and grants no request authority. The request binds target issuer, subject and kind, role, case and expiry. The audit actor is exactly `{ kind: 'system', component: 'provisioning', operator }`, with action `grant.provision`: **no principal, session or verified claim is invented**. Requester-shaped extra input cannot change it. The producer never constructs a manager, request audit sink or authenticated requester.

It reuses the typed operation engine and primary repository, without schema or engine changes. Grant plus fixed event payload/digest are inserted pending in one transaction. Pending grants grant nothing and reserve their slot. Only an acknowledged audit append or byte-identical lookup of the recorded event permits activation. An unavailable log leaves `audit-pending`; a mismatched event conflicts. Replay reads the original event, including its original time and operator, and can recover an interrupted insertion, audit acknowledgement, activation or settlement. An exact replay after expiry may settle the original row but never renews it: the existing `effective()` check still denies expired authority. Reused IDs with different actors or requests conflict without disclosing the winning grant. The existing unique slots, operation ledger and compare-and-set activation arbitrate competing writers.

## Parent-owned integration hooks

Before use, the parent must:

1. Add `src/lib/tenancy/case-grant-provisioning.ts` to `provisioningOnly` in `scripts/ci/hosted-imports.ts`, and extend the hosted import-denial mutation coverage (`tests/hosted-foundation/runtime/guard-mutations.ts`). A current clean-graph import check alone does **not** prove this new producer is denied.
2. Invoke it **only from the parent's offline owned seed**, after case provisioning and audit binding. Reuse the exact deployment, primary grants and actual directory over the same client DB used by runtime authorization; compose the provisioning audit port directly. Do not add an HTTP handler, runtime import, tenancy barrel export or fake staff/admin requester. Parent alone executes provider setup.
3. Run integration checks on the combined revision. This lane intentionally changes no guard, runtime, audit implementation or schema file.

## Prepared evidence, not live proof

The private runner `tests/hosted-foundation/case-grant-provisioning/vitest.config.ts` includes only this test directory, uses one worker and no file parallelism. Tests exercise real storage, tenancy and audit schemas; exact deployment resolution; real case provisioning/directory, primary grant repository, provisioning audit port and operation engine. The transport is synthetic SQLite behind the D1 shape, including injected storage faults and lost acknowledgements. Restart tests close and reopen an on-disk synthetic database. No grant is seeded by direct active-row insertion and no requester is manufactured to get past a management or request-audit boundary.

```sh
scripts/agent-tools/receipt --name case-grant-provisioning --tool bun -- bun run --bun test --config tests/hosted-foundation/case-grant-provisioning/vitest.config.ts --maxWorkers=1
scripts/agent-tools/receipt --name case-grant-provisioning-tsc --tool bun -- bun run --bun tsc --project tests/hosted-foundation/case-grant-provisioning/tsconfig.json --noEmit
```

The handoff report records the exact checked SHA and receipts. These checks are **not** evidence of Clerk, Cloudflare D1, a deployment, request-path reachability denial or a live grant. No providers, credentials, browser, workerd, full build or full suite run in this lane.
