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

Method, then `Origin` (equal to the request URL origin **and** the bound `appOrigin`), then `Content-Type: application/json`, then the exact-request binding (503 when absent), then the route case (404), then verified identity (401 when anonymous), then the in-memory scope (below), then the declared length, the bounded body and its DTO, then the scope once more with no await before the core call. Only then does the core run, and it applies its own authority, audit and visibility ordering.

The scope compares the request's verified identity with the identity the deps were opened for (client, session, issuer, subject, kind) and the bound case with the opened case. A mismatch, an identity object that changed after opening, or deps the bridge did not open is a fixed 503 `recovery-unavailable` before any SQL, storage or audit work. For `plan` and `apply` the scope also re-observes the receiving authentication validated at opening; a fault there is a fixed 503 `target-not-isolated`.

## Parent binding API

```ts
// src/lib/recovery/hosted/composition.ts (implemented in binding.ts)
openNativeRecoveryDeps(options: NativeRecoveryOptions): Promise<RestoreDeps>
nativeRecoveryBinding({ appOrigin, caseId, deps }): NativeRecoveryBinding
// src/lib/server/runtime/hosted/compositions.ts
bindNativeRequestCompositions(request, { intake, downloads, …, recovery?: NativeRecoveryBinding | null })
```

`openNativeRecoveryDeps` is the only way to make deps the bridge accepts: it reads the caller's options once, synchronously, into a private frozen copy (the case, the resource tuples and the receiving target; identity, audit, db and bucket stay the caller's handles), opens the reviewed `createNativeRecoveryAdapters` from that same copy (its `target` is the separately authenticated receiving source), and records the scope from that copy, so a parent that reuses or edits its options object while the open is pending changes neither what the adapters consume nor what the bridge checks. The scope is kept in a `WeakMap` keyed by the returned deps. The binding has no `restore` or `target` input, so a receiving target cannot be supplied beside deps it was not opened with; a spread, copy or graft of deps is not registered and `nativeRecoveryBinding` throws on it (a hand-forged binding object is refused per request with 503 before any IO). Receiving problems found in memory (another person or client, the source identity itself or a copy sharing its session, a shared database, bucket or worker place) leave export and verify available, open nothing of the target and answer `plan` and `apply` with 503 `target-not-isolated`. The target is never given the source identity: it is a different session of the same person in the same client, authenticated by the receiving deployment. A missing or unprovisioned target keeps `plan` and `apply` at 503 `recovery-unavailable`. Any other unusable configuration makes `openNativeRecoveryDeps` throw, and the parent then binds nothing.

The binding is keyed by the original `Request` object (a `WeakMap`), so a clone, an unknown request and a request bound to another client all resolve to nothing. It is validated and frozen at creation (`appOrigin` must be an exact URL origin). `deps.identity` must be the request's own authenticated identity (equal by client, session and principal). Missing `nativeEvidence` or a missing case-audit port keeps all four at 503 through the core. The parent supplies the real source and receiving resource and audit gates; this change supplies none.

## Errors

A response status comes only from a closed core error: an `Error` whose OWN data property `code` is a string naming one of the table's codes (a `Map`, so `constructor`, `toString`, `__proto__` and other prototype names are unknown). The text is the bridge's own fixed string. An inherited or accessor `code`, a coercible object, a non-Error value, an unknown code or any throw while looking is the bounded 503 `recovery-unavailable` with `retry-after: 2`; no provider message, key, stack or cause reaches a response, and no table entry and no error path can answer with a success status.

A Proxy is not detected and its traps are not claimed to stay silent. Standard JS has no check that runs none of them, and `util.types.isProxy` is not available in workerd, so `instanceof` and the descriptor read can run a Proxy's `getPrototypeOf` and `getOwnPropertyDescriptor` traps. Thrown values come from core and port code, not from a request. What such a value can select is only a table code (a probe with a Proxy reporting `forbidden` gets 403 with the fixed text); a code outside the table, a coercible value or a throwing trap is the bounded 503.

Known and separate: repeating an `apply` whose operation id already completed makes the core throw `invalid`, which is not in the table, so the answer is the bounded 503 `recovery-unavailable`; a retry after an uncertain apply still converges with 200 `activated:false`. The unmapped code predates this bridge and is recorded as a follow-up for the core, not mapped here.

## Not covered here

Real D1/R2, Clerk, workerd, a provisioned isolated target, the live version-visibility and case-audit policy composition, and `services.ts` wiring are all unproven. Tests use the existing synthetic SQLite/R2 recovery worlds with the real core, adapters, authorizer and audit sink (`tests/hosted-foundation/recovery-http`).
