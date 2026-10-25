# Native alpha: the checked pipeline's native profile

Status: PREPARED / UNVERIFIED. The native profile has local unit and structural checks only. It is not funded admission, a controls proof, real EU placement, an applied migration, a Build Output proof or a deploy.

## What it is

The accepted-D GRS-107 pipeline (`deploy/probes/target.ts`: target, then stage, then prebuilt) gains an explicit native profile, selected with `--profile native`. Without `--profile`, every command and function runs the unchanged legacy `clearcase.deploy-target/1` path. The legacy parser still refuses `routes`, `workers_dev`, `preview_urls`, `limits` and an R2 `jurisdiction`, and it refuses a native target as a wrong schema. The frozen `tests/hosting-probe/deployment/target.test.ts` runs unchanged beside the native tests.

This is new native applicability on top of the legacy pipeline. It does not reopen GRS-203 and does not change its closed-ingress policy.

```
bun deploy/probes/target.ts check    <client> --profile native --clients DIR [--config FILE]
bun deploy/probes/target.ts stage    <client> --profile native --clients DIR --artifact DIR --digest sha256:<hex> --out DIR
bun deploy/probes/target.ts prebuilt <client> --profile native --clients DIR --stage DIR \
  --pin-target sha256:<hex> --pin-config sha256:<hex> --pin-artifact sha256:<hex> \
  --pin-migrations sha256:<hex> --pin-entry sha256:<hex> --pin-source <40-hex>
bun deploy/probes/target.ts invocation <client> --profile native --stage DIR --cwd DIR -- wrangler deploy --config wrangler.jsonc
```

The native command line is exact. Each command reads a fixed flag set, and an unknown, repeated, valueless, positional or flag-looking argument is a usage error (exit 2) before anything is read: there is no ignored flag and no override flag. `--profile=native` and any `--profile` value other than `native` are usage errors, never the legacy path. Without `--profile`, the legacy command line is unchanged (it still ignores unknown flags).

The profile itself lives in [`deploy/native-alpha/pipeline.ts`](../../../deploy/native-alpha/pipeline.ts). It checks data only and has no filesystem, environment, network, credential or process access. `target.ts` keeps the staging mechanics.

## The native target: desired, not observed

`clearcase.deploy-target.native/1` is the exact scoped deployment the parent intends. It is bound to `APPROVED_NATIVE_SCOPE` in `controls.ts`, which is imported read-only. The target holds exactly these keys, and each must be present:

- `client`, the approved `accountId`, the approved `worker`.
- `zone {id, name}`.
- `customDomain {hostname, zoneId}`, with an exact lower-case hostname inside the zone and no wildcard.
- `workersDev:false` and `previewUrls:false`.
- `limits {cpu_ms, subrequests?}`.
- `d1 {binding DB, approved name, UUID, jurisdiction eu}`.
- `r2 {binding BUCKET, approved bucket, jurisdiction eu, publicAccess false}`.
- `secrets`, which holds secret names only, never values.
- `vars`, with `CLEARCASE_CLIENT_ID` equal to the client.
- `runtime {profile production, sourceSha, artifactSha256, migrationsSha256, compatibilityDate, compatibilityFlags, assetsBinding}`.

Identifiers that the provider assigns after a deploy, such as the Workers custom-domain ID and version IDs, are refused here. They belong to the observed controls manifest. A null D1 UUID is refused as a draft, not as an executable target. Nothing here invents an ID. The native clients directory is explicit and has no committed default.

## Config facts and the adapter

These facts come from the bundled primary schema, Wrangler 4.151.1 `config-schema.json`:

- `routes` items may be a ZoneIdRoute `{pattern, zone_id, custom_domain}`.
- `workers_dev`, `preview_urls` and `limits {cpu_ms, subrequests}` are RawEnvironment fields.
- `r2_buckets` items have `jurisdiction`.
- `d1_databases` items have no jurisdiction field.

D1 EU is therefore a property of the provider resource. The target and the stage record hold it as policy, and it is never written into a config. A D1 `jurisdiction` key in a config is refused.

**Measured capability gap: cf.** This is a static reading of cf 1.0.0-beta.20, `dist/wrangler-migration-*.mjs` `convertTriggers`. It turns a custom-domain route into a `domains` list of hostname strings, and it flags `zone_id` or `zone_name` on that route as "Custom-domain route options require manual review". A cf config therefore cannot bind the custom domain to the exact approved zone ID. What a cf Build Output carries for domains, workers.dev and limits was not measured, because a cf build is parent-only.

The native profile refuses a cf config, a cf `--format` and a `.cloudflare/` Build Output. The only adapter is the checked Wrangler config in the stage. Nothing generates config: the parent writes the reviewed `wrangler.jsonc`, and the profile compares it with the target.

## Checks

**check.** The native config must have exactly these 17 keys, and each must be present:

- `name`, `account_id`, `main` (`artifact/cloudflare/_worker.js`) and the `assets` directory (`artifact/public`) and binding, all pointing at the staged artifact. An assets directory that holds the entry is refused by name.
- `compatibility_date` and `compatibility_flags`.
- `send_metrics:false`, `workers_dev:false` and `preview_urls:false`.
- `no_bundle: true` and `find_additional_modules: false`, both required (see Final upload bytes).
- Exactly one `routes` entry: `{pattern: hostname, zone_id, custom_domain: true}`.
- `limits`, with exactly the target's limits.
- Exactly the target's `vars` and `secrets.required`.
- One D1 `{binding, database_name, database_id, migrations_dir: migrations}`.
- One R2 `{binding, bucket_name, jurisdiction: eu}`.

It refuses:

- Any other key, including executable config such as `build`, `define`, `rules` and `alias`, `no_bundle` or `find_additional_modules` with any value but the required one, plus `env`, `route`, extra bindings, `placement`, `observability`, `unsafe` and `previews`.
- Extra route options, a wildcard or differently cased hostname, and a second route.
- Any string, key or value that equals, case-free, another native client's identifier, naming that client. Approved clients absent from the directory still count.

Config JSON is read with a bounded strict parser (duplicate keys, nesting over 32 and trailing text are refused; the last duplicate no longer wins). `deploy/native-alpha/pipeline.ts` carries its own copy of the `src/lib/case-package/strict-json.ts` rules, because importing that module makes the deployment probe's Vite transform resolve the app's `$app/tsconfig`. Nothing evaluates config.

**Final upload bytes (M1).** `wrangler deploy` with bundling on would re-bundle `_worker.js` with esbuild at upload time and resolve its bare imports from `node_modules` above the stage, outside every hash. The native profile therefore requires a prebundled final module and uploads it as is:

- The config declares `no_bundle: true`, and `find_additional_modules: false` because the bundled Wrangler 4.151.1 `config-schema.json` says it "Defaults to true if `no_bundle` is true". Wrangler then uploads the `main` module's bytes and the assets directory, and nothing else is resolved, bundled or shimmed.
- `_worker.js` is parsed (TypeScript's parser, a root devDependency, run on the bytes read from the stage; nothing is executed) and must be a closed ES module graph. A static import or export-from is accepted only for `cloudflare:workers` and `node:async_hooks` (`NATIVE_HOST_IMPORTS`; the first is imported by the adapter-cloudflare 8.0.1 worker, the second needs `nodejs_als` or `nodejs_compat` in the target's flags). Every bare, relative, outside-stage or other `node:` specifier, every computed static specifier, every `require()` and any syntax error is refused. A comment, string, regex or template text that merely mentions an import is not an import. Adding a host module is a reviewed change to `pipeline.ts`.
- Dynamic `import()` (NATIVE24, below) is accepted only for a proven runtime built-in that the target's compatibility flags enable. Called without the flags, or with module facts that lack the classification, `uploadModuleProblems` still refuses every dynamic import, as before.
- The stage record's `upload` section names the final bytes: `entry {path, sha256, bytes}`, `hostImports`, `dynamicHostImports` (`{specifier, via: literal | forwarder <name>, sites}`), `additionalModules: false`, `assets {directory, files, headers}` (each public file Wrangler uploads, and the `_headers` rules it applies, by its own hash), the exact `invocation`, and `files`, every file of the staged artifact by path, size and its own sha256. The artifact digest binds the same bytes, and `prebuilt` recomputes the whole record.
- The artifact must be a self-contained final bundle. Producing it (the real SvelteKit production build and its final bundling) is parent-only and was not run here. Checks cover synthetic fixtures, real framework sources compiled by Wrangler's pinned esbuild, and the read-only parent artifact recheck recorded below.

**Dynamic host imports (NATIVE24).** The measured real bundle (`d1a6ce…`, f8d2b7b3) failed closure on three `import()` calls: two literal `import("node:async_hooks")` (SvelteKit `event.js`, Svelte `render-context.js`) and Svelte's `obfuscated_import = (module_name) => import(module_name)`, called only as `obfuscated_import("node:crypto")` in a WebCrypto fallback. With `no_bundle` and `find_additional_modules: false` the Worker is one module, so a dynamic import can only reach a runtime built-in; the rule is still narrow:

- `scanModule` classifies every `import()` call. A string literal is `literal`. An identifier is a `forwarder` only when the call is the whole concise body of a one-plain-parameter arrow; the arrow is bound to W directly or through esbuild's keep-names `__name(arrow, "W")`; W is declared once at module scope, unexported; and every other occurrence of W in the module is a direct, non-optional call with one string literal. Any alias, export, property read, `typeof`, argument use, reassignment, shadowing declaration, optional or tagged call, spread, template or concatenated specifier, import options, block body, default parameter or `arguments` makes it `unproven`, and so does an `eval` identifier anywhere.
- `__name` must be proven to be esbuild's helper `(target, value) => D(target, "name", { value, configurable: true })`, with D declared once as `Object.defineProperty`, both used only as direct calls, `Object` never declared or written and no static write to a `.defineProperty` or `.Object` property except the proven local enum below. The proof assumes intrinsics are not replaced through indirect writes; Workers refuse `eval`/`new Function` at runtime, so a string cannot reopen an import.
- A numeric enum member named `Object` or `defineProperty` is not itself an intrinsic write. The narrow exception requires an unnamed, synchronous function-expression IIFE with one plain parameter P and a body consisting entirely of `P[P["member"] = <numeric literal>] = "member"` statements. Its sole argument must be `E || (E = {})`; E must be an uninitialised, unexported module variable, and every other E occurrence must be a static member read. Other initialisers, assignments, aliases, escapes, exports, shadowing declarations, `with` lookup, extra body statements and global/aliased-global receivers stay refused. This is a receiver proof, not a name allowlist or permission for arbitrary computed writes/imports.
- Each proven specifier must be in `NATIVE_DYNAMIC_HOST_IMPORTS` and enabled by the target's flags: `node:async_hooks` needs `nodejs_als` or `nodejs_compat`, `node:crypto` needs `nodejs_compat` (a `no_` opposite disables it). This follows Wrangler 4.151.1: in its `als` mode only `node:async_hooks` is external, and any other node built-in needs `nodejs_compat`.
- Consequence: under the current `["nodejs_als"]` flags the measured bundle is still refused, now for `node:crypto` alone. It can pass only after the parent reviews target flags that include `nodejs_compat` and rebuilds the bundle with them (Wrangler's node-compat mode then changes, so the bundle bytes change too).

**Read-only real artifact recheck (25 October 2026).** The parent supplied a Wrangler `nodejs_compat` artifact built from `4fa042bd41e878a70aff08b085ad4b5b4cbccc4e`. `checkNativeArtifact({ artifact, compatibilityFlags: ['nodejs_als', 'nodejs_compat'] })` now returns no problems on those exact unchanged bytes: artifact digest `sha256:5aaab8ba86de446205220259d31c840175979725d8656f468e07d322c353e3db`, entry SHA256 `69aff7aa6017c43991e690773687e35be851537408ed0d5333ad06bf36558b2d` (1,018,531 bytes). Before the fix it refused typebox's local `ByteMarker2[ByteMarker2["Object"] = 8] = "Object"` at line 3709. The unchanged import policy now proves two literal `node:async_hooks` sites (343, 20126) and the `obfuscated_import` forwarder (20295), called with `node:crypto` at 20136; the public-assets check covers 28 files. This is static closure/layout evidence only, not a new build, stage, workerd or deployment pass. The worker report records the checker SHA and receipts. The new enum regressions and all existing adversarial tests run via `bun run --bun test --config tests/hosting-probe/deployment/native-alpha-pipeline/vitest.config.ts --maxWorkers=1` (a private include list replacing root includes).

**Public assets (NATIVE24, L1).** The artifact is two trees: `artifact/cloudflare/_worker.js`, the one uploaded module, alone, and `artifact/public/`, the one assets directory. Wrangler 4.151.1 uploads every file of the assets directory except a root `.assetsignore`, `_headers` and `_redirects`, and applies `_headers`/`_redirects` as rules (`createAssetsIgnoreFunction`). The adapter's own `.assetsignore` is a fact about adapter-cloudflare 8.0.1, not a guard, so the profile refuses:

- anything under `artifact/cloudflare/` except the entry, and anything outside the two trees;
- in `public/`: any `.assetsignore` (an empty one also silences Wrangler's `_worker.js` guard), dotfiles and dot directories, `_redirects`, `_routes.json`, `_worker.js*`, source maps, a file byte-identical to the entry, a file over 25 MiB, more than 20,000 files, and no files;
- a `_headers` other than the exact adapter-cloudflare 8.0.1 rules (`NATIVE_ADAPTER_HEADERS`: noindex and no-cache on `/_app/*`, immutable on `/_app/immutable/*`);
- any file without positive browser/static provenance. `public-assets.ts` follows the default Worker's actual `server.respond` receiver to `create_server(manifest)` and the pinned Kit manifest IIFE. Its static `assets` Set and `client` start/app/imports/stylesheets/fonts seed the allowed paths, together with Kit's required `_app/version.json`. Literal browser imports, Vite's preload dependency table and local CSS URLs extend the graph. Arbitrary manifest-shaped objects, arbitrary adapter-directory membership, an immutable-looking filename and hash inequality confer no provenance. Static PDF.js is supported when present in the actual Kit static Set; it is not a new filename exception.

The provenance helper checks the supplied public bytes against every file's own size/hash and checks the manifest text against the actual entry binding. No sidecar labels authorize files. The root of trust remains the externally reviewed artifact/entry/source pins and the pinned framework build protocol, not arbitrary attacker-authored Worker/browser code. New framework output shapes fail closed until reviewed. This is not a general JavaScript control-flow or browser-code safety proof.

**Bundle contract (`scripts/hosted-native-bundle/`).** `contract.ts` pins Wrangler 4.151.1, its esbuild 0.28.2, adapter-cloudflare 8.0.1, Kit 3.1.0 and Svelte 5.57.2, and fixes the parent's measured build-only protocol: `/usr/bin/unshare -rn` with loopback only, `/usr/bin/node <root>/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config bundle-only.jsonc --outdir bundle`, an explicit 13-key environment with nothing inherited, and a build-only config with only name, `main` (the adapter worker), the target's compatibility date and flags, `send_metrics: false` and `minify: false`. `build.ts` has `plan`, `bundle` (parent only), `assemble` and `verify`. `assemble` first runs `checkNativePublicBuild`: every public adapter file except the exact generated headers must match the corresponding trusted Kit build input under the adapter's sibling `output/client` by path **and bytes**, and the used final-entry manifest/browser graph must account for it. The complete build tree is now required; an adapter-only copy is insufficient. Unexpected files are refused, not silently dropped. It then copies the bundle's `_worker.js` bytes unchanged to `cloudflare/` and the proven public files to `public/`, refuses `_redirects`/`_routes.json` and any Wrangler out directory other than `README.md`, `_worker.js`, `_worker.js.map`, runs `checkNativeArtifact` and removes the output on any refusal. The map and README stay out of the artifact; their hashes go in the `clearcase.native-bundle/1` record beside it (`BUILT-UNVERIFIED`, every proof flag false). Additive `inputs.clientAssets` hashes the sorted JSON path/size/sha256 bindings of the actual complete `output/client` tree (including its build manifest). It records the trusted build input, not a self-certified public-file classification. The upload/stage schemas and external pins are unchanged.

**stage.** The client directory may hold only `target.json`, `wrangler.jsonc` and `migrations/`. The stage copies them and the artifact into a new directory, then judges the staged copy only:

- It refuses symlinks, special files and hard links at the root or anywhere below it. Files are copied one by one from descriptor reads, not by a recursive copy.
- It refuses a stage output inside the reviewed clients directory.
- The artifact digest must equal both `--digest` and `runtime.artifactSha256`, `_worker.js` must pass the closed-bundle check above under the target's flags, and the artifact must pass the public-assets policy.
- The migrations digest must equal `runtime.migrationsSha256`.
- `artifact/public/_app/version.json` must name `runtime.sourceSha`.
- The hosted-gate test-double marker is refused.
- The stage writes `clearcase.deploy-stage.native/1` with `state: STAGED-UNVERIFIED`, with `fundedAdmission`, `controlsProof`, `providerProof` and `deployed` all false, and with `remoteMigrations: not-applied-by-stage`.

**prebuilt.** A stage agrees with itself by construction, so the stage alone cannot prove review: rewriting the D1 UUID, the Worker entry, the config, the target and every hash and record in a stage together still passes a self-check. `prebuilt` therefore requires six external pins from the credentialed caller, never read from the stage, and a reviewed `--clients` directory outside it:

- `--pin-target` and `--pin-config` are the sha256 of the reviewed `target.json` and `wrangler.jsonc` bytes. The staged files must hash to them and be byte-identical to `<clients>/<client>/target.json` and `wrangler.jsonc`.
- `--pin-artifact`, `--pin-migrations` and `--pin-entry` are the reviewed artifact digest, migrations digest and the sha256 of the final Worker module; `--pin-source` is the 40-hex source commit. They must equal what is recomputed from the stage bytes and the reviewed target's `runtime`.
- A missing or malformed pin is a usage error, and calling `checkNativeStage` with no `pins` refuses. The reviewed clients directory must be a real directory (not a symlink) that neither holds nor sits inside the stage, and every reviewed file must be a regular, single-link file (a reviewed `target.json` symlinked into the stage is refused).
- Trust: the pins and the reviewed directory are the root of trust. They must come from the credentialed caller's own reviewed record (for example, values copied from the reviewed PR or review report), and not from a path inside the stage. A directory path or a path that exists is not a human approval, and nothing here can tell a reviewed pin from a forged one that a caller with filesystem control chose, so an attacker who controls the pins controls the upload.

It also re-verifies the whole stage:

- The stage may hold exactly `target.json`, `wrangler.jsonc`, `stage.json`, `artifact/` and `migrations/`. `.env`, `.dev.vars`, `.wrangler/`, `wrangler.toml`, cf files and symlinks are refused.
- The config check runs again, and every hash and digest is recomputed.
- `stage.json` must equal the recomputed record byte for byte.
- A legacy `/1` stage record is refused.

## Parent handoffs (not done here)

**Required provenance hook (NATIVE24 review fix).** The enum-scanner owner owns `deploy/probes/target.ts`. The parent installed these three additions inside `nativeArtifactUpload` after collecting the enum repair, before source recheck. No new import is needed:

At the start of that function:

```ts
const publicFiles = new Map<string, Buffer>();
```

Inside the existing `nativeTree` callback, just after computing `at`:

```ts
if (at.startsWith(`${NATIVE_STAGED.assets}/`)) publicFiles.set(at, bytes);
```

Extend the existing `nativeArtifactLayout` call, retaining all its current arguments:

```ts
const layout = nativeArtifactLayout({ files, entrySha256: entrySha, headersText: headers === undefined ? null : headers.toString('utf8'), entryText: entry.toString('utf8'), publicFiles });
```

This reuses the exact descriptor-read bytes, so check, stage and prebuilt judge the same inputs without a second filesystem read. Missing hook inputs fail closed. **The hook is installed; the Medium still needs the two exact server-copy probes through the final checker and assembly plus fresh source recheck.** Existing tests/fixtures are untouched in this lane. Old positive synthetic fixtures that contain no used Kit manifest or trusted `output/client` no longer establish provenance; their setup needs those inputs while preserving their assertions.

- **Artifact.** A credential-free `build:hosted` (production profile) at an exact clean SHA, then `bun scripts/hosted-native-bundle/build.ts bundle --root <checkout> --target <reviewed target.json> --work <new dir>`, which runs the pinned Wrangler build-only and assembles `<work>/artifact`. Pass that as `--artifact`. The target's `runtime.artifactSha256` is its `digestDir`. Parent-only; nothing here ran it. The synthetic fixtures prove nothing about the application. The read-only recheck above covers only the supplied 4fa042bd artifact, not a rebuild at the integrated checker SHA; the older f8d2b7b3 bundle and its receipts stay as they are. After independent review the parent must build and check the integrated SHA, then stage/prebuilt with reviewed targets and external pins before native runtime and deployment checks.
- **Compatibility flags.** The real bundle needs `node:crypto` through Svelte's forwarder, so its target needs `nodejs_compat` (beside or instead of `nodejs_als`). Choosing that is a reviewed target change for the parent; it also changes what Wrangler bundles, so new static imports must be measured, not assumed.
- **Real target.** The D1 UUIDs observed after an EU creation, the reviewed secret-name inventory, the CPU limit and compatibility settings, and the reviewed migrations directory and its digest.
- **Upload.** The command is the checked contract `wrangler deploy --config wrangler.jsonc` with the stage as cwd (`NATIVE_UPLOAD_ARGV`), and `target.ts invocation` / `nativeUploadInvocationProblems` refuse any other argument list, so an override flag is a refusal and not only a documented prohibition. The check runs nothing and sees no environment: scrubbing ambient `WRANGLER_*` and `CLOUDFLARE_*` variables, supplying credentials and choosing the Wrangler binary and version are the caller's, and the record does not pin the Wrangler version (UNMEASURED). Run it only after `prebuilt` passes on that exact stage; the gap between that check and the upload remains, and a same-user filesystem attacker could still change the stage in it. Whether `wrangler deploy` enforces `secrets.required` remotely is UNVERIFIED.
- **Migrations.** Remote migrations are never applied by stage or prebuilt. Applying them needs explicit, separately granted, bookmarked migration authority.
- **Controls.** `controls.ts` `bindStageRecord` accepts only `clearcase.deploy-stage/1`, so it does not yet link a native stage record. Changing that is a controls change, not part of this profile. The observed custom-domain and version IDs come from provider readback.
- **Binder hook (NATIVE24).** A separate native-stage binder reads a stage through `target.ts` `readNativeStage({ client, stage, clients, pins })`. It runs the same verification as `checkNativeStage` once and returns a deep-frozen `NativeStageReading`: `checker: 'checkNativeStage'`, `client`, `pins` (copied, or null), `problems`, and only when `problems` is empty the `record` recomputed from the stage bytes (`NativeStageRecord`, equal to `stage.json` byte for byte) and `files` (sha256 of the judged `stage.json`, `target.json` and `wrangler.jsonc`). It is local structural evidence: its claim flags stay false.

## Reading and staging files

All native reads go through `readRegular`: `lstat`, open with `O_NOFOLLOW|O_NONBLOCK`, `fstat` on the descriptor (same device and inode, a regular file, one link), a read from that descriptor, and a second `fstat`/`lstat` that must show the same size, times and identity. A FIFO or special file is refused without being opened and cannot hang the check, a hard link is refused, and a path that no longer resolves to its own root (a directory swapped for a symlink) is refused. Directory listings are checked for identity before and after. This detects a concurrent same-user swap on a best-effort basis. It is not an atomic or hostile-filesystem guarantee: Node has no `openat`, so a swap between a check and the open can only be caught by these comparisons, and the prebuilt-to-upload gap is not closed.

## Unrun boundaries

The provenance review-fix lane runs only targeted structural tests and TypeScript checking. Its positive real check reads the complete pre-existing 4fa042bd build tree without modifying it; mutations run only on private scratch copies. This is public-provenance evidence, not whole-bundle acceptance: the enum-scanner refusal is separately owned, and the target hook above is installed; combined post-hook checks remain parent work.

Not run here: builds or bundling (including Wrangler dry run), full suites/gates, provider/account/API/auth/credential operations, deploy/upload, workerd/browser, migrations, EU placement, DNS/certificate operations, funding, or post-hook check/stage/prebuilt acceptance. The parent owns fresh source recheck and combined exact-SHA acceptance.
