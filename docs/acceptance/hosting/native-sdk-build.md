# Scoped native renderer SDK build policy

This is **build-only / SCOPED-BUNDLE-NOT-NATIVE** evidence. No app build,
workerd, browser, binding, provider, deployment or runtime compatibility proof is
claimed. The native acceptance checker is unchanged and still refuses the one
required host import described below.

## API and installation

`nativeRenderSdkBuild({ root, target, profile })` in
`scripts/native-render-sdk-build.ts` is installed before Kit in `vite.config.ts`.
It applies before SDK parsing/bundling in the `ssr` build environment, forces the
SDK into the server bundle (not an external package for a later bundler), and
does not pre-patch `node_modules` on disk. Local returns no plugin; hosted-gate
can build its doubles without any SDK and refuses accidental SDK reachability.
A production build **fails** until the real factory is reachable and every
required transformation ran. The parent still owns service composition.

Only `src/lib/viewer/hosted/native-render-check.ts` may import the exact SDK root
and `lib/esm/puppeteer/generated/version.js`. Only trusted hosted `services.ts`
may reach this constructor in the source boundary. A prior trusted visit cannot
bless a route's later import. Other SDK entry points, CJS, foreign roots, queries,
symlinks, generic application filesystem/network/Buffer imports, and unknown
SDK imports are refused rather than shimmed.

## Input and transformation pins

No package or lock change. Official `@cloudflare/puppeteer` **1.4.0**, installed
by Bun **1.4.2** with the frozen lock:

- Package metadata SHA-256: `8ab3e1d7431161bccb5ac1c7198eee3077aa14912a74290764b71583a9699166`.
- Sorted inventory of all 144 official ESM JavaScript modules, including vendored
  RxJS (excluding tests/maps/declarations):
  `65d81a63ea1ea2a381d29260aad55d9737ca513b345efc68b66a88c4df539005`.
- Inventory format is `JSON.stringify([{module,sha256},...])`, ordinal relative
  module paths below `lib/esm`, lowercase SHA-256 of UTF-8 bytes. Malformed UTF-8
  is refused. Every reached input is compared again before transformation.

The exact existing `applyNativeRenderSdkPolicy` is invoked on **both**
`common/Debug.js` and `cloudflare/utils.js`, with its original input and output
pins. Neither output is edited again. A marker in the renderer HTML is not used
as build proof. Replayed/pre-patched inputs fail the official inventory pin.

Additional output pins are exported in `NATIVE_SDK_WORKER_OUTPUTS`:

| SDK module | Restriction |
| --- | --- |
| `cloudflare/PuppeteerWorkers.js` | Removes the global Buffer patcher import. |
| `environment.js` | Workers-only `isNode = false`; no process/environment branch. |
| `common/util.js` | Filesystem import throws; optional V8 stack instrumentation uses a fixed diagnostic label instead of mutating `Error.prepareStackTrace`. |
| `cdp/ElementHandle.js` | File upload always throws, including an empty file list. |
| `common/BrowserConnector.js` | Generic URL/transport connector always throws. |
| `common/BrowserWebSocketTransport.js` | Both construction and creation always throw. |
| `api/Page.js`, `cdp/HTTPResponse.js` | Lexical Buffer imports, no protected global assignment. |

Two private, edge-restricted adapters exist: native `node:buffer` re-export,
and a throwing Node-debug adapter for the optional SDK-only `debug` branch.
They cannot be imported by application modules. Enabled Workers diagnostics
remain sanitized by the original reviewed policy, not silenced with a global
console/process/Buffer patch. No buffer npm polyfill, generic fs stub, filesystem
success response, or generic network connector is introduced.

## Receipt and emitted proof

A successful server bundling hook writes only private build metadata:
`.local/native-render-sdk-build/ssr.json` (`clearcase.native-render-sdk-build/1`).
It records the official inventory pins, policy ID, entry/factory, connected SDK
module graph, every reached module's input/output hashes and transformation
steps, private adapters, required host capability, and emitted chunks' actual
hashes/byte counts/module rendered lengths. The two reviewed policy modules must
have nonempty emitted contributions. Post-transform parser input must still
match the recorded output hash. Externalized, missing or later-replaced policy
modules/adapters fail the build. Each server build clears the previous receipt;
build/render hook failures remove it. Later app/adapter failure cannot turn this
server-graph receipt into whole-build evidence.

The receipt describes **Kit's server output**, not the parent's later final
Worker bundle. Parent must compare its chunk hashes against the actual output,
carry these transformed bytes through adapter/final bundling, and run the
unchanged native scanner on the final closed entry. Never upload this receipt
or treat it as a public manifest/provenance exception. A receipt alone is not
native acceptance, and no stale receipt substitutes for a successful build.

## Trusted PDF metadata define

Alongside `__CLEARCASE_BUILD__`, the config defines `__CLEARCASE_PDF_ASSETS__`
from `prepareHostedStaticInput(root).inventory`, only for a hosted-production
build. It is `null` for local, dev/preview, or hosted-gate. All 191 public asset
records come from the actual reviewed copying helper, not env, secrets, caller
config, or a new public manifest. Parent owns the typed server-only declaration
and use for `NativePreviewRenderChecker.pins`. The original pre-Kit discovery,
post-adapter disposal, strict CSP and positive manifest provenance are unchanged.

## Reproduce (light only)

After frozen install and Kit sync:

```sh
scripts/agent-tools/receipt --name native-sdk-tests --tool bun -- \
  bun run --bun test --maxWorkers=1 tests/hosted-foundation/native-sdk-build \
  tests/hosted-foundation/runtime/hosted-imports.test.ts \
  tests/hosted-smoke/pdf-static-assets
scripts/agent-tools/receipt --name native-sdk-closure --tool bun -- \
  bun run --bun tests/hosted-foundation/native-sdk-build/scoped-bundle.ts
```

The second command bundles a synthetic default Worker entry using the **real
factory and installed SDK**, with the exact production plugin, without evaluating
that entry. It preserves its private emitted bytes/receipt for inspection and
runs `scanModule` plus `uploadModuleProblems` from the unchanged native checker.
It exits nonzero on refusal; it is not an alternate acceptance path.

## Exact remaining parent integration requirement

The scoped emitted closure has **one static `node:buffer` import**, no dynamic or
computed imports, no require calls, no filesystem/Node connector imports and no
global Buffer/console/process patch. Buffer is genuinely retained by the SDK's
response/screenshot/stream implementations. It is the actual Workers host
module, not the installed npm `buffer` package or a fabricated global.

The unchanged checker only accepts static `cloudflare:workers` and
`node:async_hooks`; therefore it **FAILS** this closure specifically for
`node:buffer`, even with `nodejs_compat`. Parent owns a separate review of that
host-module/compatibility requirement and actual Worker runtime evidence. Do not
weaken the checker here, remove the import to hide the requirement, or claim this
as closed native acceptance. After any reviewed host-policy change, update the
scoped test's exact expected native verdict and rerun it on the integrated SHA.
Parent also owns the actual production factory import, artifact/native bundle
checks, resources, runtime flags and native execution. Native remains **UNRUN**.
