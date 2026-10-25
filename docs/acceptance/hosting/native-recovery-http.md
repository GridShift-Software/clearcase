# Native recovery /2 HTTP bridge — local source interface

**Implemented source interface; native acceptance UNRUN.** This is HTTP plumbing over the reviewed `/2` recovery core (`exportNativeCase`, `verifyNativeExport`, `planNativeRestore`, `applyNativeRestore`). It provisions no resource, creates no target, and composes no real service. Until the trusted parent binds a request, every route answers 503.

## Routes

All four are `POST` only, under `deploy/client/routes/api/cases/[caseId]/recovery/native/`. No route module exports a `GET`. Bodies are one strict JSON object of at most 2048 bytes; an unknown or missing field is 422, a duplicate key or bad UTF-8 is 422, a larger body (declared or streamed) is 413.

| Route | Body | Core call | Success |
|---|---|---|---|
| `export` | `{exportId, includeUserWork, auditScope?}` | `exportNativeCase` | 201 `{kind:'exported', format, exportId, caseId, createdAt, manifestSha256, evidence:{audit,rows,bytes,sha256}, accounting}` |
| `verify` | `{exportId, expectedManifestSha256}` | `verifyNativeExport` | 200 `{kind:'verified', …, verifiedBlobs, accounting}` |
| `plan` | `{exportId, expectedManifestSha256}` | `planNativeRestore` | 200 `{kind:'planned', plan}` (the core's `RestorePlan`) |
| `apply` | `{exportId, expectedManifestSha256, confirmedPlanSha256, operationId}` | `applyNativeRestore` | 200 `{kind:'applied', report}` (the core's `RestoreReport`, `activated:false`) |

The case is the route's `caseId` and must equal the binding's `caseId`; the body cannot carry one. Responses are `cache-control: no-store`. No object key, session id, provider message or URL is returned. There is no `/1` fallback; the legacy functions are never called.

## Order of checks

Method, then `Origin` (equal to the request URL origin **and** the bound `appOrigin`), then `Content-Type: application/json`, then the exact-request binding (503 when absent), then the route case (404), then verified identity (401 when anonymous) and equality with the bound deps identity (client, principal, session; else 503), then the declared length, the bounded body and its DTO. Only then does the core run, and it applies its own authority, audit and visibility ordering.

## Parent binding API

```ts
// src/lib/recovery/hosted/composition.ts
nativeRecoveryBinding({ appOrigin, caseId, deps: RecoveryDeps, restore: { liveIsolationId, target: RestoreTarget } | null }): NativeRecoveryBinding
// src/lib/server/runtime/hosted/compositions.ts
bindNativeRequestCompositions(request, { intake, downloads, …, recovery?: NativeRecoveryBinding | null })
```

The binding is keyed by the original `Request` object (a `WeakMap`), so a clone, an unknown request and a request bound to another client all resolve to nothing. It is validated and frozen at creation (`appOrigin` must be an exact URL origin). `deps.identity` must be the request's own authenticated identity. `restore: null`, or a target that is not isolated (the core's `target-not-isolated`), keeps `plan` and `apply` at 503. Missing `nativeEvidence` or a missing case-audit port keeps all four at 503 through the core. The parent supplies the real source and receiving resource and audit gates; this change supplies none.

## Not covered here

Real D1/R2, Clerk, workerd, a provisioned isolated target, the live version-visibility and case-audit policy composition, and `services.ts` wiring are all unproven. Tests use the existing synthetic SQLite/R2 recovery worlds with the real core, adapters, authorizer and audit sink (`tests/hosted-foundation/recovery-http`).
