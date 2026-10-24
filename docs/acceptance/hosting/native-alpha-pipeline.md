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

- `name`, `account_id`, `main` and the `assets` directory and binding, all pointing at the staged artifact.
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
- `_worker.js` is parsed (TypeScript's parser, a root devDependency, run on the bytes read from the stage; nothing is executed) and must be a closed ES module graph. A static import or export-from is accepted only for `cloudflare:workers` and `node:async_hooks` (`NATIVE_HOST_IMPORTS`; the first is imported by the adapter-cloudflare 8.0.1 worker, the second is `nodejs_als`). Every bare, relative, outside-stage or other `node:` specifier, every computed specifier, every `import()` (literal or not), every `require()` and any syntax error is refused. A comment, string, regex or template text that merely mentions an import is not an import. Adding a host module is a reviewed change to `pipeline.ts`.
- The stage record's `upload` section names the final bytes: `entry {path, sha256, bytes}`, `hostImports`, `additionalModules: false`, the exact `invocation`, and `files`, every file of the staged artifact by path, size and its own sha256. The artifact digest binds the same bytes, and `prebuilt` recomputes the whole record.
- The artifact must be a self-contained final bundle. Producing it (the real SvelteKit production build and its final bundling) is parent-only and was not run here; this check is against synthetic mini fixtures. If the real bundle needs a dynamic import or another host module, this check refuses it and the profile has to be extended by review.

**stage.** The client directory may hold only `target.json`, `wrangler.jsonc` and `migrations/`. The stage copies them and the artifact into a new directory, then judges the staged copy only:

- It refuses symlinks, special files and hard links at the root or anywhere below it. Files are copied one by one from descriptor reads, not by a recursive copy.
- It refuses a stage output inside the reviewed clients directory.
- The artifact digest must equal both `--digest` and `runtime.artifactSha256`, and `_worker.js` must pass the closed-bundle check above.
- The migrations digest must equal `runtime.migrationsSha256`.
- `artifact/cloudflare/_app/version.json` must name `runtime.sourceSha`.
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

- **Artifact.** A credential-free `build:hosted` (production profile) at an exact clean SHA, then a final bundling of `_worker.js` into one closed module (the adapter's worker imports `SERVER` and the bare packages that the existing `.svelte-kit/output/server` imports). Producing that bundle is parent-only, and nothing here ran it. Copy the result as `--artifact`, so that the stage holds `artifact/cloudflare/_worker.js`. The target's `runtime.artifactSha256` is that tree's `digestDir`. The synthetic fixture artifact proves nothing about the application. Whether the real bundle satisfies the closed-graph check is UNMEASURED.
- **Real target.** The D1 UUIDs observed after an EU creation, the reviewed secret-name inventory, the CPU limit and compatibility settings, and the reviewed migrations directory and its digest.
- **Upload.** The command is the checked contract `wrangler deploy --config wrangler.jsonc` with the stage as cwd (`NATIVE_UPLOAD_ARGV`), and `target.ts invocation` / `nativeUploadInvocationProblems` refuse any other argument list, so an override flag is a refusal and not only a documented prohibition. The check runs nothing and sees no environment: scrubbing ambient `WRANGLER_*` and `CLOUDFLARE_*` variables, supplying credentials and choosing the Wrangler binary and version are the caller's, and the record does not pin the Wrangler version (UNMEASURED). Run it only after `prebuilt` passes on that exact stage; the gap between that check and the upload remains, and a same-user filesystem attacker could still change the stage in it. Whether `wrangler deploy` enforces `secrets.required` remotely is UNVERIFIED.
- **Migrations.** Remote migrations are never applied by stage or prebuilt. Applying them needs explicit, separately granted, bookmarked migration authority.
- **Controls.** `controls.ts` `bindStageRecord` accepts only `clearcase.deploy-stage/1`, so it does not yet link a native stage record. Changing that is a controls change, not part of this profile. The observed custom-domain and version IDs come from provider readback.

## Reading and staging files

All native reads go through `readRegular`: `lstat`, open with `O_NOFOLLOW|O_NONBLOCK`, `fstat` on the descriptor (same device and inode, a regular file, one link), a read from that descriptor, and a second `fstat`/`lstat` that must show the same size, times and identity. A FIFO or special file is refused without being opened and cannot hang the check, a hard link is refused, and a path that no longer resolves to its own root (a directory swapped for a symlink) is refused. Directory listings are checked for identity before and after. This detects a concurrent same-user swap on a best-effort basis. It is not an atomic or hostile-filesystem guarantee: Node has no `openat`, so a swap between a check and the open can only be caught by these comparisons, and the prebuilt-to-upload gap is not closed.

## Unrun boundaries

Not run here: any provider, account, API, auth or credential use; Wrangler or cf deploy, build, bundle or dry run; the real SvelteKit production build and its final bundling (the closed-graph check ran only on synthetic mini modules); a remote migration; real EU placement; the custom-domain attach, the DNS or certificate effect; the full build, gate, workerd and browser; funding.
