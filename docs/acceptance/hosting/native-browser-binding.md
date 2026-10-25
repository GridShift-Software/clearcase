# Native Browser Run binding: client-only, explicit opt-in

Source configuration only. `BROWSER` is a controlled deployment capability, not
proof that Browser Run exists for the account, is isolated, bounded, billed or
renders anything. Nothing here deploys, calls a provider, sets a quota or budget,
or creates a target. The runtime still requires its explicit six-field policy and
compiled pins; a bound `BROWSER` replaces neither.

## What it admits

Exactly `browser: { binding: "BROWSER" }` in a client A or client B Worker config,
and only when the parent opted that client in. Staff stays ASSETS-only (no D1, R2
or browser). The D1 (`DB`), R2 (`BUCKET`, EU), `ASSETS`, `nodejs_compat`, source,
binding and provenance checks are unchanged, and the bootstrap profile still
carries no custom CPU `limits`. No build, local or hosted-gate config binds it, so
a build never triggers a remote browser proxy or authentication.

## Parent opt-in (the only entry points)

| Profile | Opt-in | Absent means |
| --- | --- | --- |
| native/1 (`pipeline.ts`) | optional `browser: { "binding": "BROWSER" }` in the reviewed client `target.json` (covered by the `target` pin), plus the same key in `wrangler.jsonc` | no browser; a config carrying one is refused |
| workers.dev bootstrap (`workers-dev-bootstrap.ts`) | optional `browserClients: ["client-a"] \| ["client-b"] \| ["client-a","client-b"]` in the settings the parent passes to every plan/prepare/read/invocation call | no browser; output bytes identical to before |

An opt-in absent from the supplied settings or reviewed target is never inferred
from a stage, so a stage cannot grant itself the binding.

## Guarded call sites

- `parseNativeTarget` (`pipeline.ts`): `browser` is an optional key, exactly `{ binding: "BROWSER" }`; `BROWSER` may not also be the assets binding, a var or a secret name. Reached by `loadNativeTargets`, `nativeStageFacts`, the stager and the binder.
- `checkNativeWrangler` (`pipeline.ts`): `config.browser` must exist iff the target opts in and then equal `{ binding: "BROWSER" }`; unknown keys (`env`, `services`, `ai`, `unsafe`, ...) stay refused by the closed key list. Reached by `checkNative`, `stageNative`, `checkNativeStage`/`readNativeStage` and the binder.
- `nativeStageRecord` (`pipeline.ts`): `desired.browserBinding` is recorded only for an opt-in, so the recomputed record stays byte-exact; other records are unchanged.
- `checkNativeUploadInvocation` (`target.ts`): the staged `target.json`, the stage record's `desired.browserBinding` and `wrangler.jsonc` must agree on the binding; the argv remains exactly `wrangler deploy --config wrangler.jsonc`.
- `planWorkersDevBootstrap` (`workers-dev-bootstrap.ts`): `browserClients` must be a non-empty, ordered, duplicate-free list of client slots; `staff` and any other value throw. Emitted config and `targets[].browser` exist only for listed clients.
- `prepare/readWorkersDevBootstrap` and `checkWorkersDevBootstrapInvocation`: exact canonical config and manifest bytes, so a renamed, remote, `env`-scoped, proxied or extra binding, a staff binding, or a widened/dropped opt-in is refused.
- The legacy `clearcase.deploy-target/1` profile keeps its closed key list and refuses `browser`.

## Checks (synthetic, scoped, no provider, workerd or browser)

```sh
scripts/agent-tools/receipt --name native-browser-binding-unit -- bun run --bun test --maxWorkers=1 --config tests/hosting-probe/deployment/native-browser-binding/vitest.config.ts
scripts/agent-tools/receipt --name native-browser-binding-tsc -- bun node_modules/typescript/bin/tsc --noEmit -p tests/hosting-probe/deployment/native-browser-binding/tsconfig.json
```

Existing suites that must stay green: `workers-dev-bootstrap` (103) and
`native-alpha-pipeline` (471; the four `public-asset-provenance-reviewfix` cases
need `NATIVE_PUBLIC_REAL_TREE` and fail without it). `native-stage-binding` fails
at its fixture stage step on the base commit already (public provenance of the
synthetic artifact) and is not changed by this work.
