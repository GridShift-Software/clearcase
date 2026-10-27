# Checked workers.dev first deployment

`deploy/native-alpha/workers-dev-bootstrap.ts` is the separate
`clearcase.workers-dev-bootstrap/1` profile. It does not change the existing
custom-domain native/1 target, pipeline, controls or stage binder.

This is preparation tooling, not deployment or live-service evidence. It builds
nothing, calls no provider, reads no credentials and applies no migrations.

## Fixed scope

Account: `fb4c31b91c5d89b7a54afbdc34823170`.

| Slot | Desired Worker name | D1 database UUID | Private EU R2 bucket |
| --- | --- | --- | --- |
| client-a | cc-sbx-a-20261023 | cd257736-7bf3-49f6-8544-ac58c2207802 | cc-sbx-a-20261023-files |
| client-b | cc-sbx-b-20261023 | 7c340891-9fcc-4398-8128-68abe726f130 | cc-sbx-b-20261023-files |
| staff | cc-sbx-staff-20261023 | none | none |

D1 names are `cc-sbx-a-20261023-db` and `cc-sbx-b-20261025-r1-db`.
Client bindings are exactly `DB` and `BUCKET`; staff has neither. EU D1
jurisdiction and disabled R2 development URLs were verified by the parent before
this brief. The manifest records desired policy, not a new provider readback.
D1 jurisdiction is not a Wrangler binding field. R2 jurisdiction is `eu` in the
config; the parent must keep both buckets private with development URLs disabled.

Every config has `workers_dev: true`, `preview_urls: false`, `routes: []`,
`no_bundle: true`, `find_additional_modules: false`, `minify: false` and
`ASSETS` pointing only to `artifact/public`. The entry is
`artifact/cloudflare/_worker.js`. Compatibility flags must be exactly
`["nodejs_compat"]`; the parent selects this mode and builds the artifact for it.

No `limits` property is emitted. Workers Free applies its provider-enforced CPU
ceiling; the first actual upload returned code 100328 because even a 10ms custom
CPU setting is paid-plan-only. Removing that override does not upgrade a plan or
change the checked artifact. Canonical config checking still refuses an injected
`limits` field. The original failed upload and its accepted static assets remain
recorded separately from a successful Worker deployment.

The configs explicitly set `CLEARCASE_INSTANCE_ROLE` to `client` or `staff`,
and `CLEARCASE_CLIENT_ID` to the corresponding client, or an empty string for
staff. The empty string grants no client identity. The role variable is descriptive
configuration, not an authorization mechanism. Staff is an unconfigured portal
shell using the same artifact, not a working case app or a case-content authority.
Missing identity, storage and other services remain unavailable.

## Parent API

All APIs are exported from `deploy/native-alpha/workers-dev-bootstrap.ts`.
Use the parent's external reviewed source, artifact-tree and entry pins; never
recover authority from a stage's own manifest. Hashes use `sha256:<64 lowercase
hex>`; source uses the full lowercase Git SHA. Artifact-tree hashes use the
existing `checkNativeArtifact` framing, including paths, directories and bytes.

```ts
const settings = {
  pins: { source: reviewedSourceSha, artifact: reviewedArtifactDigest, entry: reviewedEntryDigest },
  compatibilityDate: reviewedCompatibilityDate,
  compatibilityFlags: ['nodejs_compat'],
};

const plan = planWorkersDevBootstrap(settings); // Pure, no files read.
const prepared = prepareWorkersDevBootstrap({
  artifact: '/absolute/path/to/reviewed/artifact',
  out: '/absolute/path/to/new-bootstrap-stage', // Parent directory must exist.
  settings,
});

// Immediately before EACH upload, with the SAME settings and a selected fixed slot:
const checked = checkWorkersDevBootstrapInvocation({
  stage: prepared.stage,
  cwd: prepared.stage,
  settings,
  slot: 'client-a',
  argv: ['wrangler', 'deploy', '--config', 'client-a.wrangler.json'],
});
// The parent, not this module, runs Wrangler under real Node.
```

`readWorkersDevBootstrap({ stage, settings })` is the read-only owner API when no
invocation is being checked. Refusals throw; no partial result authorizes an upload.
Arguments have exact key sets. There is no raw config, role, account, name,
binding, secret or argv override option. Returned records are recursively frozen.

The stage contains exactly:

- `artifact/`: one unchanged copy, shared by all three configs;
- `client-a.wrangler.json`, `client-b.wrangler.json`, `staff.wrangler.json`;
- `bootstrap.json`: canonical manifest containing config bytes and hashes,
  external pins, compatibility, the embedded production build stamp, every
  uploaded file's path/byte count/hash, classified public assets and header rules,
  desired scope and the three bounded argv arrays.

The returned `manifestSha256` hashes the exact `manifestText` / `bootstrap.json`
bytes. The manifest does not hash itself. The shared upload record deliberately
has no native/1 invocation: only `targets[].argv` belongs to this profile.

The exact commands, each with the checked stage as cwd, are:

```text
wrangler deploy --config client-a.wrangler.json
wrangler deploy --config client-b.wrangler.json
wrangler deploy --config staff.wrangler.json
```

No additional flags are allowed, including `--env`, `--name`, `--var`, `--route`,
`--config`, `--dry-run` or bundling/compatibility overrides. The parent resolves
the reviewed pinned Wrangler executable and hosts it with real Node, using a
sanitized execution environment with no ambient config overrides and dotenv
loading disabled (`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`,
`CLOUDFLARE_INCLUDE_PROCESS_ENV=false`). Credentials are the parent's execution
concern and must never enter this API, the manifest or reports. The guard checks
argv/cwd/files, not the parent's eventual process environment or executable.

## Optional runtime configuration

`settings.runtimeConfig` is absent by default, and then every output byte is the shell-only output above. When present it is the
**input of `planNativeRuntimeConfig`** (`runtime-config.ts`): `{ manifest, clients, browserAllocation }`. It is never a vars map,
and it carries no secret value. The bootstrap hands the value to the reviewed planner during planning (so before any file is read,
written or listed), keeps only the planner's frozen result and never reads the caller's object again. Any planner refusal is
rethrown as `runtimeConfig: <the planner's fixed diagnostic>`; no input value, key, hostname or thrown value is echoed.

Each planned client is matched against the exact bootstrap target: client id `client-a` or `client-b` (not `staff`), Worker, D1 name
and UUID and R2 bucket must equal the table above, and the hostname must be exactly `<Worker>.shiny-sunset-211d.workers.dev`. That
account subdomain is pinned in the bootstrap beside the account id (public provider metadata, observed from the account API and the live
URLs); a caller-supplied label, even one that matches the shape, or different labels for A and B, is refused. Planning a
single client leaves the other as the unchanged shell.

`settings.origin` is the one switch between two pinned hostname sets and is absent by default, which means `'workers-dev'`. A Worker serves
one origin: `CLEARCASE_APP_ORIGIN`, the manifest hostname and Clerk's fixed sign-in callbacks all name it, and the runtime refuses a pair
that differs. `'custom-domain'` requires each client's hostname, deployment tuple and app origin to be exactly its own single label under
the approved zone, `sbx-a.clearcase.co.za` or `sbx-b.clearcase.co.za`, read from `APPROVED_NATIVE_SCOPE`; a wildcard, another zone, the
workers.dev name and the other client's host refuse. Under either value the other set refuses, so the switch moves both clients together.
The config keeps `workers_dev: true` and `routes: []` in both modes: the domain is bound by the reviewed free Workers Custom Domain PUT
(`custom-domain-bind.ts`), never by a route, and workers.dev stays on as a static fallback that cannot sign in while the custom domain is
the pinned origin. Rolling back is a redeploy of the workers-dev stage, then detaching the two bindings. The merge then puts the planner's public vars after
`CLEARCASE_INSTANCE_ROLE` and `CLEARCASE_CLIENT_ID` in that client's config (the planned client id must equal the slot, so role and
client stay locked). Only these names are admitted: the planner's public Clerk values, `CLEARCASE_APP_ORIGIN`, `AUTH_MFA_REQUIRED`
and `CLEARCASE_NATIVE_CONFIG`; each value is a string of at most 5000 UTF-8 bytes. Secret names, the role variable and anything else
are refused even if a changed planner emitted them, as are changed secret-name lists and bindings other than `DB`, `BUCKET`,
`ASSETS` and an optional `BROWSER`.

The renderer set comes from one decision, the explicit plan: the clients with a render budget must equal `browserClients` exactly,
in both directions. A missing or extra `BROWSER` binding refuses the plan. Staff stays an honest `ASSETS`-only identity shell with
the two shell vars, no stores, no `runtime` record and `readiness: 'unconfigured-portal-shell'` (the planner records it as
`unsupported`). A configured client keeps `readiness: 'services-unconfigured'`: its secrets are not bound, and nothing is
claimed deployed, provisioned or identity-ready.

The plan gains a top-level `runtimeConfig: { manifestSha256, manifest }` (the planner's manifest, with `providerProof`,
`provisioned` and `deployed` all false) and each configured target a `runtime: { varNames, requiredSecretNames, plannerFileSha256 }`
record: secret NAMES only, to be supplied by the parent out of band. Because the vars live in the canonical config bytes,
every stage record, the checker, every reread and every invocation compare the same values; a changed, added, removed or reordered
var, or a settings value that differs from the one prepared, is refused as a difference from the exact bootstrap profile.

The input graph grows by the planner's: `runtime-config.ts` reaches `native-render-check.ts`, which statically imports
`@cloudflare/puppeteer` (loaded, never launched here). Nothing in the graph reads the environment, a provider or a network.

## Checks and remaining deployment work

Preparation and every read use the existing `checkNativeArtifact` on actual bytes:
closed entry graph, compatibility-aware host imports, no hosted-gate marker,
no extra server module, no public server copy, no source maps, dotenv/dotfiles,
asset-ignore or routing-policy escape hatch. `_headers` must be the existing
exact adapter rules. The source pin must match `_app/version.json` and the
embedded `build:hosted` JSON marker; the marker must be a clean, non-exported
Cloudflare production build. The artifact and entry hashes must match external
pins independently. A marker alone does not certify arbitrary code: reviewed
external pins remain the authority.

The reader also requires exact canonical config/manifest bytes and the complete
stage file/directory set. Binding swaps, shared client stores, staff client stores,
unexpected binding keys and changed code/assets are refused. Symlinks, multiply
linked files and special files are refused through existing safe file readers;
new stage creation never overwrites an existing directory. On a preparation
failure, only the newly created output directory is removed. Same-user concurrent
check-to-upload changes cannot be made atomic by this API: the parent must keep
the stage exclusive, recheck before each upload and stop on any refusal.

Parent steps: independently review this change, build the real production artifact
for the chosen date and `nodejs_compat`, supply reviewed pins, prepare and recheck,
deploy the three fixed names, then record actual observed workers.dev URLs and
version IDs from deployment output. No observed URL or provider-assigned version
ID is invented here. The parent supplies secrets and service wiring afterwards;
this profile intentionally carries no secret values or required-secret gate that
would block first creation.

Focused synthetic checks (no provider, workerd or deployment execution):

```sh
scripts/agent-tools/receipt --name workers-dev-bootstrap-unit -- bun run --bun test --config tests/hosting-probe/deployment/workers-dev-bootstrap/vitest.config.ts
scripts/agent-tools/receipt --name workers-dev-bootstrap-tsc -- bun node_modules/typescript/bin/tsc --noEmit -p tests/hosting-probe/deployment/workers-dev-bootstrap/tsconfig.json
scripts/agent-tools/receipt --name workers-dev-bootstrap-runtime-config-unit -- bun run --bun test --config tests/hosting-probe/deployment/workers-dev-bootstrap-runtime-config/vitest.config.ts
scripts/agent-tools/receipt --name workers-dev-bootstrap-runtime-config-tsc -- bun node_modules/typescript/bin/tsc --noEmit -p tests/hosting-probe/deployment/workers-dev-bootstrap-runtime-config/tsconfig.json
```
