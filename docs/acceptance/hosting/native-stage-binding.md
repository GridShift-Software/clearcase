# Native stage binder (NATIVE24)

Local structural comparison only, not deployment, provider, controls, funding or placement proof. The controller's legacy `bindStageRecord` is unchanged; native records are never converted to legacy records. Fresh independent re-check and combined-head integration remain with the parent.

## Parent API: checked evidence, then structural binding

Use `deploy/native-alpha/native-stage-evidence.ts` for the local deployment bridge:

```ts
import { bindCheckedNativeStages, readNativeStageEvidence } from './native-stage-evidence.ts';
import { nativeBindingProblems } from './native-stage-binding.ts';

const result = bindCheckedNativeStages({
  observed: { manifest, readback },
  pins, // Reviewed external NativePins per client, never derived from the stage.
  profileRevision, // Reviewed 40-hex revision.
  now,
  reader: { read: (client) => readNativeStageEvidence({
    client, stage: stages[client], clients: reviewedClients, pins: pins[client], now,
  }) },
});
const problems = nativeBindingProblems(result);
```

`readNativeStageEvidence({ client, stage, clients, pins, now })` calls the real `readNativeStage` twice around real `readRegular` reads of stage.json, target.json and wrangler.jsonc. Both checked readings must have no problems and be identical. Their `files` values are hashes, NOT text: each raw text is hashed against the checked reading, target/config against the external pins, and stage.json against the recomputed canonical record. Invalid UTF-8, failed checks, changed readings or mismatched raw bytes throw without issuing evidence. The completion timestamp comes from the supplied clock after both checks.

Successful evidence is deeply frozen and privately branded in a WeakSet. `isIssuedNativeStageEvidence(value)` checks actual object identity. Booleans, caller checker labels, JSON and spread copies are not provenance. `bindCheckedNativeStages(input)` requires this brand on every read BEFORE the pure binder copies the evidence. No new target.ts export or edit is needed.

The lower-level `bindNativeStages(input)` in `native-stage-binding.ts` remains a pure data comparator, with no filesystem, environment, network, process, credential, clock or host-module access. Calling it directly does NOT establish checked origin. Parents must use the checked bridge above, not substitute a reader that merely returns `checker: 'checkNativeStage'` and an empty problems list.

## Input and time contracts

- `observed`: parsed, copied, frozen ControlManifest and copied, frozen provider readback. `readbackProblems(..., 'before')` must pass at entry AND at the final post-read clock; domain IDs, version IDs and other provider facts come only from this observation. Nothing here fetches or fabricates readback.
- `pins`: exactly six reviewed external pins per manifest client. Missing, malformed, additional or differently echoed pins are refused.
- `profileRevision`: captured once before callbacks and compared using only that captured value. A reader cannot replace a wrong reviewed revision during binding.
- `reader.read(client)`: exact `NativeStageEvidence` shape with raw texts, external pins, empty checker problems and completion `readAt`. Every client is read twice; content must be identical, and the second read time cannot go backwards. Evidence is copied and frozen on receipt.
- `now()`: sampled after EACH reader call and once finally. Non-finite, missing or backwards clocks are refused. Evidence must not be future-dated or older than 300 seconds; evidence freshness is also checked at the final clock. The provider observation's separate 60-second freshness policy is rechecked after all reads. Honest completion timestamps need no backdating or frozen production clock.

## Upload and observed-state comparison

The binder rehashes target/config text against the pins, parses the target, checks config against all bound targets and refuses shared identifiers. It reconstructs the entire native record byte for byte and compares every observed account, zone, Worker, domain, D1, private EU R2, secret inventory, source, artifact, profile revision and original asset canary fact.

The expanded upstream upload contract is preserved: `assets` and `dynamicHostImports` are required, not dropped or replaced with a legacy record. Upload files have unique canonical artifact paths, hashes and sizes; the entry must be listed with the same size/hash and match its external pin. `nativeArtifactLayout` enforces artifact/public and the single artifact/cloudflare/_worker.js server entry. Public assets and the exact adapter header inventory must equal the upload inventory. Dynamic host facts require allowed specifiers, compatible flags, positive site counts and unique literal/forwarder facts. Closed static host imports, `additionalModules:false` and the exact upload invocation remain required. Actual tree digests, module facts and version bytes are checked by the real stage issuer, not inferred from checker strings.

## Result and integration

Results are frozen, process-issued records with exactly `schema, state, problems, bound, structuralOnly, providerProof, controlReady, funded, legacyConversion`. State is `HOLD` (nothing bound) or `BOUND-STRUCTURAL`; all proof/readiness/funding/conversion flags stay false. `nativeBindingProblems` refuses unissued result copies and HOLD results. Even checked-origin binding grants no provider action. The parent requires no binding problems before its separate controller/apply logic. DNS, certificates, stop plans and negative canaries remain unchanged in controls.ts.

## Focused tests

The private suite retains the original 60 tests and adds reviewer regressions and checked-issuer cases, using real synthetic stages, hashing and filesystem checks. Fixtures now use artifact/public. The private Vitest include replaces the root list; run with `--maxWorkers=1`. Tests cover completion clocks, final provider expiry despite mutation of the caller's readback, immutable profile pins, issuer identity/copies, real changed stages, nonempty dynamic imports, adapter headers and altered upload metadata. The suite is not yet registered in the shared integration runner; that shared-file follow-up belongs to the parent.

Unrun here: full build/suites/gates, browser, workerd, real production bundle, real provider readback, provider execution and deployment. Local synthetic checks are not live-alpha evidence.
