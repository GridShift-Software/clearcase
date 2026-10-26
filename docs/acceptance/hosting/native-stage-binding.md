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

`readNativeStageEvidence({ client, stage, clients, pins, now })` calls the real `readNativeStage` twice around real `readRegular` reads of stage.json, target.json and wrangler.jsonc and of every artifact file in the checked reading's upload inventory. The artifact tree listing must be exactly what that inventory implies (an unlisted file or an empty directory throws), and each file read must have its inventory size and sha256. The evidence (`clearcase.native-stage-evidence/2`) carries them as `artifact: { entryText, publicFiles: [{ path, base64 }] }`: the final Worker entry as UTF-8 text and every other file, all under artifact/public, as canonical base64. Both checked readings must have no problems and be identical. Their `files` values are hashes, NOT text: each raw text is hashed against the checked reading, target/config against the external pins, and stage.json against the recomputed canonical record. Invalid UTF-8, failed checks, changed readings or mismatched raw bytes throw without issuing evidence. The completion timestamp comes from the supplied clock after both checks.

Successful evidence is deeply frozen and privately branded in a WeakSet. `isIssuedNativeStageEvidence(value)` checks actual object identity. Booleans, caller checker labels, JSON and spread copies are not provenance. `bindCheckedNativeStages(input)` requires this brand on every read BEFORE the pure binder copies the evidence. No new target.ts export or edit is needed.

The lower-level `bindNativeStages(input)` in `native-stage-binding.ts` remains a pure data comparator, with no filesystem, environment, network, process, credential, clock or host-module access. Calling it directly does NOT establish checked origin. Parents must use the checked bridge above, not substitute a reader that merely returns `checker: 'checkNativeStage'` and an empty problems list.

## Input and time contracts

- `observed`: parsed, copied, frozen ControlManifest and copied, frozen provider readback. `readbackProblems(..., 'before')` must pass at entry AND at the final post-read clock; domain IDs, version IDs and other provider facts come only from this observation. Nothing here fetches or fabricates readback.
- `pins`: exactly six reviewed external pins per manifest client. Missing, malformed, additional or differently echoed pins are refused.
- `profileRevision`: captured once before callbacks and compared using only that captured value. A reader cannot replace a wrong reviewed revision during binding.
- `reader.read(client)`: exact `NativeStageEvidence` shape with raw texts, the actual artifact bytes, external pins, empty checker problems and completion `readAt`. A missing byte section, entry text or public file, a path outside artifact/public, a repeated path, or a hash, marker or non-canonical base64 in place of bytes is a HOLD. Every client is read twice; content must be identical, and the second read time cannot go backwards. Evidence is copied and frozen on receipt.
- `now()`: sampled after EACH reader call and once finally. Non-finite, missing or backwards clocks are refused. Evidence must not be future-dated or older than 300 seconds; evidence freshness is also checked at the final clock. The provider observation's separate 60-second freshness policy is rechecked after all reads. Honest completion timestamps need no backdating or frozen production clock.

## Upload and observed-state comparison

The binder rehashes target/config text against the pins, parses the target, checks config against all bound targets and refuses shared identifiers. It reconstructs the entire native record byte for byte and compares every observed account, zone, Worker, domain, D1, private EU R2, secret inventory, source, artifact, profile revision and original asset canary fact.

The expanded upstream upload contract is preserved: `assets` and `dynamicHostImports` are required, not dropped or replaced with a legacy record. Upload files have unique canonical artifact paths, hashes and sizes; the entry must be listed with the same size/hash and match its external pin. `nativeArtifactLayout` enforces artifact/public and the single artifact/cloudflare/_worker.js server entry. Public assets and the exact adapter header inventory must equal the upload inventory. Dynamic host facts require allowed specifiers, compatible flags, positive site counts and unique literal/forwarder facts. Closed static host imports, `additionalModules:false` and the exact upload invocation remain required.

The captured bytes must be exactly the upload inventory (entry plus every other listed file). The binder hashes the entry text against the external entry pin and re-derives the artifact tree digest (digestDir framing, directories implied by the file paths) from the captured bytes against the external artifact pin, so a lying reader whose record and inventory agree with grafted bytes is still refused. It then passes the entry text and the decoded public bytes, with the actual `_headers` text, to `nativeArtifactLayout`, whose positive provenance (the default Worker's one `server.respond` receiver, `create_server` over the used Kit manifest IIFE, its static Set and browser graph) judges them unchanged. The migrations digest, the entry's module facts and version.json against the target are still checked by the real stage issuer, not inferred from checker strings.

## Result and integration

Results are frozen, process-issued records with exactly `schema, state, problems, bound, structuralOnly, providerProof, controlReady, funded, legacyConversion`. State is `HOLD` (nothing bound) or `BOUND-STRUCTURAL`; all proof/readiness/funding/conversion flags stay false. `nativeBindingProblems` refuses unissued result copies and HOLD results. Even checked-origin binding grants no provider action. The parent requires no binding problems before its separate controller/apply logic. DNS, certificates, stop plans and negative canaries remain unchanged in controls.ts.

## Focused tests

Byte-evidence regressions (`the actual artifact bytes carried by the evidence`) cover issuer capture and freezing, absent/partial bytes, tampered and hash/marker/non-canonical bytes, edited and other-build entries, grafted, outside-tree, unsafe and repeated paths, a consistent forged inventory refused only by the re-derived artifact pin, byte revalidation, copied or later-edited bytes, empty directories, a Kit-shaped expanded stage binding through the bridge, a different Kit-shaped stage, and the canonical record and invocation. The two original positive cases now use Kit-shaped entries with genuine used-manifest provenance. The expanded-assets case requires exactly five public files (four base files plus its synthetic asset) and explicitly checks membership; the other-build case retains the original artifact-mismatch refusal. All 85 test names and negative checks are preserved.

The 85-test suite retains the original cases and adds reviewer regressions and checked-issuer cases, using real synthetic stages, hashing and filesystem checks. Fixtures now use artifact/public. The private Vitest include replaces the root list; run with `--maxWorkers=1`. Tests cover completion clocks, final provider expiry despite mutation of the caller's readback, immutable profile pins, issuer identity/copies, real changed stages, nonempty dynamic imports, adapter headers and altered upload metadata. The root Vitest configuration also includes this suite through its recursive deployment-test glob.

Unrun here: full build/suites/gates, browser, workerd, real production bundle, real provider readback, provider execution and deployment. Local synthetic checks are not live-alpha evidence.
