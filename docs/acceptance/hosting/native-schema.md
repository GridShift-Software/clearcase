# Pinned native sandbox D1 schema

Offline preparation only; **no Cloudflare D1, workerd or deployed-service evidence**. Source migrations are pinned to
`c6f0d9536e381dc8eebbf2035f49834409434761`, not to the caller's current HEAD. A later integration commit may use this
assembler only while all eleven source files still match the pinned bytes. Migration changes need a reviewed repin.

## Order and prerequisites

`deploy/native-alpha/schema.ts` emits one deterministic `migrations/0001_native_alpha.sql`, in this order:

0. Generated runtime sentinel DDL, identical to the runtime fixture's table declaration, with **no sentinel row**.
1. `src/lib/audit/migrations/0001_native_audit.sql`
2. `src/lib/storage/cloud/migrations/0001_rs_results_storage.sql`
3. `src/lib/tenancy/migrations/0001_tenant_case_grants.sql`
4. `src/lib/tenancy/migrations/0002_tenant_grant_operations.sql`
5. `src/lib/tenancy/migrations/0003_tenant_upload_grants.sql`
6. `src/lib/storage/cloud/migrations/0002_rs_verification_work.sql`
7. `src/lib/submissions/migrations/0001_submissions_intake.sql`
8. `src/lib/user-work/hosted/migrations/0001_uw_user_work.sql`
9. `src/lib/results-review/native/migrations/0001_native_candidate_import.sql`
10. `src/lib/publication/hosted/migrations/0001_publication_ledger.sql`
11. `src/lib/publication/hosted/migrations/0002_atomic_publication.sql`

Storage precedes verification and publication. Tenancy's upload extension follows both earlier tenancy migrations.
Candidate audit intent/settlement and the ledger's audit/signed-identity columns precede atomic publication. See the
[atomic publication contract](../atomic-d1-publication.md), [storage](../../hosted-foundation/storage.md),
[audit](../../hosted-foundation/audit.md), [user work](../../hosted-foundation/user-work.md) and
[intake](../hosted-intake-slice.md) for their owners' contracts. No migration is redesigned or SQL statement split.

This is a **fresh-schema installation**, not an additive upgrade or a drift detector for existing databases. Before
execution the parent must inspect existing remote tables and migration history. Stop if any service schema already
exists; `IF NOT EXISTS` in some sources cannot upgrade older tables. A runtime sentinel table alone is compatible.
Wrangler owns its migration history and application transaction semantics; SQLite tests do not certify either.

## API and stage

- `NATIVE_SCHEMA_SOURCE`, `NATIVE_SCHEMA_INPUTS`: fixed source SHA and ordered path/byte-count/SHA-256 inventory.
- `assembleNativeSchema(inputs)`: pure assembly from exactly `{path, bytes: Uint8Array}[]` in the pinned order.
  Missing, extra, reordered, renamed or modified inputs fail. Returns `{sql, manifest, manifestText}`.
- `prepareNativeSchema({root, out})`: reads pinned files, creates a new stage, cleans its newly created stage on failure.
- `readNativeSchema({root, stage})`: rechecks source pins and every exact staged byte; rejects extra files/directories,
  missing files, config/manifest/SQL edits and symlinks, including symlink ancestors.
- `checkNativeSchemaInvocation({root, stage, cwd, slot, argv})`: repeats verification, requires stage cwd and the exact
  planned argument array, and returns the checked plan plus `target`. Never executes a process.

The stage holds only `schema.json`, `client-a.wrangler.json`, `client-b.wrangler.json` and the one SQL migration.
The manifest includes generated sentinel inventory, ordered source inventory, combined SQL bytes/hash, source pin,
fixed configs/argv and explicit `providerProof: false`, `provisioned: false`. It is not its own authority: verification
reconstructs it from hard-coded pins and freshly checked sources. No timestamps or absolute paths enter stage bytes.

Only account `fb4c31b91c5d89b7a54afbdc34823170` and these existing approved D1 targets are named:

| Slot | Database | UUID |
| --- | --- | --- |
| client-a | cc-sbx-a-20261023-db | cd257736-7bf3-49f6-8544-ac58c2207802 |
| client-b | cc-sbx-b-20261025-r1-db | 7c340891-9fcc-4398-8128-68abe726f130 |

There is no staff database target, arbitrary SQL input, source-pin override, ID override or additional argv option.

## Parent commands and execution seam

From the integration checkout, with dependencies already installed:

```sh
mkdir -p .local/native-schema
bun scripts/hosted-native-schema.ts prepare .local/native-schema/stage
bun scripts/hosted-native-schema.ts verify .local/native-schema/stage
```

CLI accepts only `prepare|verify` and one stage path. Both are offline. Reuse requires verification; preparation refuses
an existing output. After remote freshness inspection, the parent imports `checkNativeSchemaInvocation` and calls it
immediately before **each** remote command with the corresponding returned `target.argv` and stage cwd:

```text
wrangler d1 migrations apply cc-sbx-a-20261023-db --remote --config client-a.wrangler.json
wrangler d1 migrations apply cc-sbx-b-20261025-r1-db --remote --config client-b.wrangler.json
```

These are logical Wrangler argument arrays; the parent launches the installed pinned Wrangler through real Node,
from the checked stage, with its own credential-safe environment. No shell interpolation, additional flags, alternate
config/cwd or environment-derived account/target overrides. The module supplies no executor or credentials. Parent
owns same-user check-to-execution races, exclusive stage custody, provider acknowledgements, retries and readback.
No remote command was run by this implementation worker.

## Separate trusted provisioning

The bundle creates tables/triggers/views only. Parent still provisions `rs_storage_identity` with `clearcase.rs/1`,
real synthetic `rs_case` rows, `native_audit_binding` via `provisionAuditBinding`, `uw_binding` via
`provisionD1UserWork`, the upload binding, explicit audited case/upload grants, and the R2 identity and runtime sentinel
object plus matching `runtime_sentinel` digest row. Use the owners' trusted provisioning APIs, never request paths or
schema-generated authority. No actor/session, case, grant, candidate, sign-off or publication is fabricated here.
Parent separately composes services and performs real D1/workerd validation before exposing routes.

## Light checks

```sh
scripts/agent-tools/receipt --name native24-schema-tests -- bun run --bun test --config tests/hosted-foundation/native-schema/vitest.config.ts
scripts/agent-tools/receipt --name native24-schema-types -- bun node_modules/typescript/bin/tsc --noEmit -p tests/hosted-foundation/native-schema/tsconfig.json
```

The private Vitest config replaces root discovery and uses one worker. Tests execute the combined real DDL on
lightweight synthetic SQLite, enumerate all migration tables, check integrity/foreign keys, exercise constraints and
missing atomic prerequisites, and reject altered/missing/reordered inputs and staged config/SQL/inventory changes.
They also exercise CLI refusal and bounded invocation guards. This remains local component evidence only.
