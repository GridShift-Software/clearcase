# Native alpha: the checked pipeline's native profile

Status: PREPARED / UNVERIFIED. The native profile has local unit and structural checks only. It is not funded admission, a controls proof, real EU placement, an applied migration, a Build Output proof or a deploy.

## What it is

The accepted-D GRS-107 pipeline (`deploy/probes/target.ts`: target, then stage, then prebuilt) gains an explicit native profile, selected with `--profile native`. Without `--profile`, every command and function runs the unchanged legacy `clearcase.deploy-target/1` path. The legacy parser still refuses `routes`, `workers_dev`, `preview_urls`, `limits` and an R2 `jurisdiction`, and it refuses a native target as a wrong schema. The frozen `tests/hosting-probe/deployment/target.test.ts` runs unchanged beside the native tests.

This is new native applicability on top of the legacy pipeline. It does not reopen GRS-203 and does not change its closed-ingress policy.

```
bun deploy/probes/target.ts check    <client> --profile native --clients DIR [--config FILE]
bun deploy/probes/target.ts stage    <client> --profile native --clients DIR --artifact DIR --digest sha256:<hex> --out DIR
bun deploy/probes/target.ts prebuilt <client> --profile native --clients DIR --stage DIR
```

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

**check.** The native config must have exactly these 15 keys, and each must be present:

- `name`, `account_id`, `main` and the `assets` directory and binding, all pointing at the staged artifact.
- `compatibility_date` and `compatibility_flags`.
- `send_metrics:false`, `workers_dev:false` and `preview_urls:false`.
- Exactly one `routes` entry: `{pattern: hostname, zone_id, custom_domain: true}`.
- `limits`, with exactly the target's limits.
- Exactly the target's `vars` and `secrets.required`.
- One D1 `{binding, database_name, database_id, migrations_dir: migrations}`.
- One R2 `{binding, bucket_name, jurisdiction: eu}`.

It refuses:

- Any other key, including executable config such as `build`, `define`, `rules`, `alias` and `no_bundle`, plus `env`, `route`, extra bindings, `placement`, `observability`, `unsafe` and `previews`.
- Extra route options, a wildcard or differently cased hostname, and a second route.
- Any string, key or value that equals, case-free, another native client's identifier, naming that client. Approved clients absent from the directory still count.

**stage.** The client directory may hold only `target.json`, `wrangler.jsonc` and `migrations/`. The stage copies them and the artifact into a new directory, then judges the staged copy only:

- It refuses symlinks and special files at the root or anywhere below it.
- The artifact digest must equal both `--digest` and `runtime.artifactSha256`.
- The migrations digest must equal `runtime.migrationsSha256`.
- `artifact/cloudflare/_app/version.json` must name `runtime.sourceSha`.
- The hosted-gate test-double marker is refused.
- The stage writes `clearcase.deploy-stage.native/1` with `state: STAGED-UNVERIFIED`, with `fundedAdmission`, `controlsProof`, `providerProof` and `deployed` all false, and with `remoteMigrations: not-applied-by-stage`.

**prebuilt.** It re-verifies the whole stage from the stage alone:

- The stage may hold exactly `target.json`, `wrangler.jsonc`, `stage.json`, `artifact/` and `migrations/`. `.env`, `.dev.vars`, `.wrangler/`, `wrangler.toml`, cf files and symlinks are refused.
- The config check runs again, and every hash and digest is recomputed.
- `stage.json` must equal the recomputed record byte for byte.
- A legacy `/1` stage record is refused.

## Parent handoffs (not done here)

- **Artifact.** A credential-free `build:hosted` (production profile) at an exact clean SHA. Copy its `.svelte-kit` directory as `--artifact`, so that the stage holds `artifact/cloudflare/_worker.js`. The target's `runtime.artifactSha256` is that tree's `digestDir`. The synthetic fixture artifact proves nothing about the application.
- **Real target.** The D1 UUIDs observed after an EU creation, the reviewed secret-name inventory, the CPU limit and compatibility settings, and the reviewed migrations directory and its digest.
- **Upload.** Run Wrangler with cwd at the stage and `--config wrangler.jsonc` only, with no CLI overrides (`--name`, `--route`, `--var`, `--define`, `--env`, `--keep-vars`, `--compatibility-*`, `--minify`). Run it only after `prebuilt` passes on that exact stage. Whether `wrangler deploy` enforces `secrets.required` remotely is UNVERIFIED.
- **Migrations.** Remote migrations are never applied by stage or prebuilt. Applying them needs explicit, separately granted, bookmarked migration authority.
- **Controls.** `controls.ts` `bindStageRecord` accepts only `clearcase.deploy-stage/1`, so it does not yet link a native stage record. Changing that is a controls change, not part of this profile. The observed custom-domain and version IDs come from provider readback.

## Unrun boundaries

Not run here: any provider, account, API, auth or credential use; Wrangler or cf deploy, build or dry run; a remote migration; real EU placement; the custom-domain attach, the DNS or certificate effect; the full build, gate, workerd and browser; funding.
