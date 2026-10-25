# Offline native runtime configuration

This plans and stages the non-secret runtime configuration that the current `hostedServices` and `clerkIdentityProviderFromEnv` read, for explicit client A/B deployments. It does not read the environment or any credential file, run a subprocess, contact Clerk or Cloudflare, create a target, deploy, bind or rebind. Everything staged is **source-only settings**: `providerProof`, `provisioned` and `deployed` are `false`, and acceptance by the current parsers is not health, login, tenant, Browser or runtime proof. Native use is **UNRUN**.

## API and CLI

`deploy/native-alpha/runtime-config.ts`:

- `planNativeRuntimeConfig(input)`: pure and deterministic; returns `{ manifest, manifestText, files, clients }`.
- `prepareNativeRuntimeConfig({ input, out })`: exclusive new directory (mode 0700, files 0600); returns the re-read plan.
- `readNativeRuntimeConfig({ input, stage })`: re-plans from `input` and requires the stage to hold exactly the planned entries and bytes.
- `loadNativeRuntimeConfigInput(file)`: strict-JSON (duplicate keys refused), bounded, regular, unlinked file.
- `nativeRuntimeConfigDiagnostic(error)`: the immutable message of an error this module issued, by identity; `nativeRenderLeaseMs(maxRunMs)`; constants `NATIVE_RUNTIME_SECRET_NAMES`, `NATIVE_RUNTIME_CONFIG_*`.

```sh
bun scripts/hosted-native-runtime-config.ts prepare /abs/input.json /abs/new-stage
bun scripts/hosted-native-runtime-config.ts verify  /abs/input.json /abs/new-stage
```

Exit 2 for usage, 1 for refusal. Stage and input paths must be canonical absolute paths with no symlinked ancestor. The input must be explicit and contain no secret value; secret-shaped strings anywhere (value or key) refuse.

## Input (all fields required; `null` is an explicit "unset", never a default)

`{ manifest, clients: [...], browserAllocation }`. `manifest` is the `validateClientManifest` shape. Each client is `{ deployment, appOrigin, clerk, policy }`:

- `deployment`: the `resolveExactDeployment` tuple (`clientId, hostname, worker, d1DatabaseId, d1DatabaseName, r2Bucket`), checked against the manifest.
- `appOrigin`: exactly `https://` plus the manifest hostname.
- `clerk`: `clientPublishableKey, staffPublishableKey` (development, `pk_test_`, public), `apiUrl, signInUrl, staffSignInUrl, audience` (string or null), `mfaRequired` (boolean). The real `readClerkIdentityConfig` judges them; each key's host must name the manifest's client and staff issuer.
- `policy`: `auditLimits, storageBudgets, storageQuotas, userWorkLimits, intakeBudget, importBudget` (all finite, exact keys) and `nativeRenderBudget` (the six fields, or `null` to leave the client without a Browser binding and renderer). Validated by `auditConfig`, `storageBudgets`, `storageQuotas`, `userWorkConfig`, `intakeBudget`, `nativeImportBudget`, `hostedValidationPolicy` and the renderer's exported ceilings. The planner also refuses the two relations `hostedServices` otherwise drops silently (`importBudget.maxFiles`/`maxFileBytes` above the storage package bounds).
- `browserAllocation`: `null`, or `{ maxConcurrentBrowsers, maxReservedBrowserMsPerDay }`.

## Output per client (`<clientId>.runtime.json`) and `runtime-config.json`

- `vars` (nonsecret): `CLEARCASE_CLIENT_ID`, `CLEARCASE_APP_ORIGIN`, `CLERK_CLIENT_PUBLISHABLE_KEY`, `CLERK_STAFF_PUBLISHABLE_KEY`, `AUTH_MFA_REQUIRED`, the non-null ones of `CLERK_API_URL`, `CLERK_CLIENT_SIGN_IN_URL`, `CLERK_STAFF_SIGN_IN_URL`, `CLERK_SESSION_AUDIENCE`, and `CLEARCASE_NATIVE_CONFIG` (`clearcase.native-runtime/1`: `deployment`, a one-client `manifest`, and the policy sections; at most 5120 bytes, the documented Workers variable limit, unverified here). These map to `target.json` `vars`.
- `secrets` (names only; values are supplied by the parent out of band): `CLERK_CLIENT_SECRET_KEY`, `CLERK_CLIENT_JWT_KEY`, `CLERK_STAFF_SECRET_KEY`, `CLERK_STAFF_JWT_KEY`. A missing one makes the identity provider unavailable (tested).
- `bindings`: `DB`, `BUCKET`, `ASSETS`, and `BROWSER` only for a client with a render budget. Names, not provisioned resources.
- The manifest lists each file's bytes and SHA-256, `staff`, `plannedBrowserAllocation` and the three `false` flags.

## Staff

`staff.runtimeConfig` is `unsupported`. `clerkIdentityProviderFromEnv` needs a non-empty `CLEARCASE_CLIENT_ID` and both Clerk instances, and `hostedServices` has no client-less mode, so there is no existing API for an identity-only staff Worker. The bootstrap's staff shell stays unconfigured; nothing is invented and no client database is borrowed.

## Planned Browser allocation (not availability or spend)

Each opted-in client is charged its real worst case: `maxRunMs + 2 s cleanup + 60 s idle tail` per run, success included, times `maxRunsPerClientPerDay`. The reservation SQL refuses a launch before the previous lease ends, so a client holds one browser at a time. The plan sums these and refuses unless they fit the explicit aggregate policy. It is labelled `planned-allocation` with `accountAvailabilityProven: false` and `spendProven: false`. The two private constants are cross-checked against the real checker's reserved `lease_ms` by the tests.

## Checks (synthetic, scoped; no provider, workerd, browser, build or full suite)

```sh
scripts/agent-tools/receipt --name native-runtime-config-unit -- bun run --bun vitest run --maxWorkers=1 --config tests/hosted-foundation/native-runtime-config/vitest.config.ts
scripts/agent-tools/receipt --name native-runtime-config-tsc -- bun node_modules/typescript/bin/tsc --noEmit -p tests/hosted-foundation/native-runtime-config/tsconfig.json
scripts/agent-tools/receipt --name native-alpha-tsc -- bun node_modules/typescript/bin/tsc --noEmit -p deploy/native-alpha/tsconfig.json
```

Tests cover the emitted values through the real Clerk reader/provider factory and the real `hostedServices` (in-memory D1/R2/ASSETS/BROWSER doubles, tamper cases with teeth), refusals (missing, malformed, over-ceiling, inconsistent, mismatched tuple/issuer/host, secret-shaped), the snapshot boundary (sparse, getter, Proxy, inherited, symbol, coercion), stage safety and changed bytes, the CLI, and the allocation arithmetic with a differential check of the render rule against the real constructor. `example-input.ts` is an explicit synthetic example, not a deploy preset.

## Missing parent composition (not supplied here)

Provider scope and the real Clerk metadata for the synthetic clients; the secret values; the `target.json`/Wrangler merge of these `vars`, `secrets` and bindings (the workers.dev bootstrap currently emits only `CLEARCASE_INSTANCE_ROLE` and `CLEARCASE_CLIENT_ID`); applying the schema and runtime migrations; the compiled PDF pins in the artifact; any recovery target, resources or auth hooks (the current services contract has none, so none is emitted); the staff Worker; and every provider-side proof.
