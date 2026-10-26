# Offline native runtime increment

This stages an increment, not a replacement initial schema. It does not execute Wrangler, contact a provider, inspect credentials or environment, query Git, or provision anything. Native application is **UNRUN**. The integration owner must read back the actual initial migration history and exact database identity before application; this offline checker cannot certify them.

## Immutable inputs and output

Source pin: `79c0ee92a858e55a12c727760e258ce8e293a86b`. Only these ordered source bytes are admitted (hashes are SHA-256):

| Source | Bytes | Hash |
| --- | ---: | --- |
| `src/lib/server/runtime/hosted/migrations/0001_audit_recovery_cursor.sql` | 735 | `5021e7d048c6716ac238d6ecefc3cb0215446e44293ae495e244f5e89d64d1e6` |
| `src/lib/viewer/hosted/migrations/0001_preview_render_work.sql` | 11317 | `06fedb50c3da237d8565038195d77bf6f90c965be0ae3c84614b25c92c0e2112` |
| `src/lib/publication/hosted/migrations/0003_provenance_generation.sql` | 8175 | `7d6fad7a0b9551693f59bfb2dd5090d5a90d55af141fc5657fb58ee9d6fb7be0` |

Generated `migrations/0002_native_runtime.sql`: **20618 bytes**, SHA-256 `e854e9d1c6bca7a439dd5903ace1a3e7d01382dae3a7e79e624146f870cda97f`.
Stable `runtime-migration.json`: **2846 bytes**, SHA-256 `4151a457444576641ad7413b5308d10502f1062c1ba79111844f1caed8557dba`.

The manifest records `providerProof: false`, `provisioned: false`, and immutable `initialSchemaDependency`: `migrations/0001_native_alpha.sql`, **85251 bytes**, SHA-256 `42c5047823256b5bfbc25ba7f8d04b6a05decb2ad19683599d89801011040d89`, source `c6f0d9536e381dc8eebbf2035f49834409434761`. That file is not emitted, rewritten, renamed or replayed. Its prior genuine application remains a parent-owned precondition.

SQL object delta: **5 tables, 2 explicit indexes, 39 triggers**, no removed or changed existing object definitions. Tables: `native_audit_recovery_cursor`, `npr_client_days`, `npr_case_days`, `npr_reservations`, `npr_success_receipts`. The provenance migration also advances existing `pub_candidate_generation` rows, invalidating earlier sign-offs through existing triggers. This is not a purely additive data change.

## Fixed targets

Account: `fb4c31b91c5d89b7a54afbdc34823170`. Configurations and argv exactly match the pinned initial-schema plan:

| Slot | Database | Database ID | Config |
| --- | --- | --- | --- |
| `client-a` | `cc-sbx-a-20261023-db` | `cd257736-7bf3-49f6-8544-ac58c2207802` | `client-a.wrangler.json` |
| `client-b` | `cc-sbx-b-20261025-r1-db` | `7c340891-9fcc-4398-8128-68abe726f130` | `client-b.wrangler.json` |

The latter is replacement B, not the denied original B. Exact argv is `["wrangler", "d1", "migrations", "apply", databaseName, "--remote", "--config", configFile]`, with cwd equal to the verified stage. There are no caller SQL, source, account, database or config overrides.

## API and CLI

Exports from `deploy/native-alpha/runtime-migration.ts`:

- `NATIVE_RUNTIME_MIGRATION_SOURCE`, `NATIVE_RUNTIME_MIGRATION_INPUTS`, `NATIVE_RUNTIME_INITIAL_SCHEMA`, type `NativeRuntimeMigrationSlot`.
- `assembleNativeRuntimeMigration(inputs: readonly { path: string; bytes: Uint8Array }[])`: pure deterministic `{ sql, manifest, manifestText }`.
- `prepareNativeRuntimeMigration({ root, out })`: exclusive new stage; returns `{ stage, sql, manifest, manifestText }`.
- `readNativeRuntimeMigration({ root, stage })`: re-reads exact source and stage bytes and returns the same checked shape.
- `checkNativeRuntimeMigrationInvocation({ root, stage, cwd, slot, argv })`: re-reads before returning the checked shape plus fixed `target`; never executes it.

The owner calls the invocation check immediately before each separately owned execution, after actual history/identity readback. Execution `cwd` must be the exact returned absolute `stage` string: relative paths, trailing/duplicate slashes, dot segments and ancestor aliases are refused, not normalized into acceptance. Both the increment and initial-schema guards enforce this. Helper root/stage/output paths reject raw `.` and `..` components before resolution, then check every ancestor for symlinks; a `link/..` traversal cannot disappear before validation. Ordinary relative prepare/read locations and trailing directory slashes remain supported.

Keep the stage private and unchanged between check and execution; the returned plan is not a filesystem lock. Missing/extra files, symlinks in any ancestor, hard-linked files, unexpected directories, or source/config/manifest/SQL tampering are refused. Only the newly created incomplete stage is removed on preparation failure; an existing stage is never changed.

```sh
bun scripts/hosted-native-runtime-migration.ts prepare /absolute/new-stage
bun scripts/hosted-native-runtime-migration.ts verify /absolute/new-stage
```

CLI accepts only those two positional arguments (exit 2 for usage, 1 for refusal). Its prepare/verify convenience adapter resolves relative stage arguments to an absolute location; it never certifies the raw argument as an execution cwd. Use only the returned checked stage for execution. Preparation emits exactly four files: one SQL migration, one manifest, two fixed configs.

Input objects and arrays must have exact own data fields, with dense ordinary arrays and no overridden methods. Byte buffers are copied once, then that same captured copy is hashed and decoded. Captured intrinsic TypedArray getters read the view's actual length and backing store; the intrinsic ArrayBuffer resizable getter rejects resizable and shared storage even if own properties or a forged prototype disguise it. Detached views, view accessors/overrides and inherited input records are refused. Caller-owned backing-store getters are ignored, never invoked; byte copying uses the captured intrinsic `set`, not an iterator, species or caller method. Plain Uint8Array/Buffer values, including offset views on fixed backing stores, remain supported.

## Local checks

Private test/type configurations live in `tests/hosted-foundation/native-runtime-migration/`, with `maxWorkers: 1` and `erasableSyntaxOnly: true`. Targeted tests apply the exact unchanged initial schema followed by the increment to synthetic in-memory SQLite, compare the entire object delta, exercise cursor/render invariants, compile provenance trigger writes, and check integrity/foreign keys. Refusal tests cover sparse/inherited/accessor/overridden inputs, fixed invocation, source and stage tampering, links, CLI bounds and fresh-stage cleanup. Added review regressions prove actual child-process cwd resolution for `link/..`, enforce raw path/ancestor boundaries for both guards, and cover backing getters, disguised resizable/shared/detached storage, view overrides/proxies, fixed Buffer/offset-view compatibility and unchanged output digests. They do not claim actual D1 application or seeded identities, cases or grants.

## Render case-limit increment 0004 (prepared, UNRUN)

A separate explicit mode stages `migrations/0004_native_render_case_limit.sql` after the unchanged initial `0001` and the applied `0002`. It never rewrites, renames, re-emits or replays either: `NATIVE_RENDER_CASE_LIMIT_APPLIED_RUNTIME` records `0002` (**20618 bytes**, `sha256:e854e9d1c6bca7a439dd5903ace1a3e7d01382dae3a7e79e624146f870cda97f`) and the manifest repeats the initial-schema dependency. The default `*NativeRuntimeMigration` API and its bytes are unchanged. Number `0003` is left to the separately reviewed audit-read increment; this increment does not depend on it, so either may be applied first.

**Input and output.** The only input is `src/lib/viewer/hosted/migrations/0002_preview_render_case_limit.sql`, **7565 bytes**, `sha256:83152ce69cdd56201b98b04d504d6ba220d137090500c64bb831de16f981539c`, committed at `721384470b91264f01aaa765ab29bf8373216292`. The output is two header lines, `-- <input path>`, the input verbatim and one newline. The manifest is `render-case-limit-migration.json`, `schema` `clearcase.native-render-case-limit-migration/1`, `mode` `render-case-limit-0004`, with `providerProof: false`, `provisioned: false`. A changed input fails closed until a reviewed commit updates the pin.

**What it changes.** The per-case render ceiling moves from 2 to 3; the client ceiling stays 4. SQLite cannot change a CHECK, so `npr_reservations` and `npr_case_days` are copied to side tables, dropped, recreated under their own names with `case_limit` and `runs` CHECKs of 1..3, and the rows are copied back unchanged. Their two indexes and seven triggers are recreated exactly as `0001` wrote them, after the copy-back, so the copy is not an admission. `npr_client_days` and `npr_success_receipts` are not touched. `PRAGMA defer_foreign_keys = on` covers the receipts' foreign key to the reservation token for the migration's transaction, and there is deliberately no closing `off`, which would forgive an orphan. No rename, `writable_schema`, `foreign_keys = off` or ignored CHECK is used.

**Stage, targets and execution.** It shares the `0002` assembler, byte capture, record reader, path/ancestor checks and invocation guard through a module-private packet descriptor: the same fixed account, databases and argv, a private stage (`0700` directories, `0600` files, owner-only, unchanged while read), a separate entry set that a `0002` stage cannot satisfy (and the reverse), and an invocation check that never executes. API: `NATIVE_RENDER_CASE_LIMIT_MIGRATION_MODE`, `_SOURCE`, `_INPUTS`, `NATIVE_RENDER_CASE_LIMIT_APPLIED_RUNTIME`, `assembleNativeRenderCaseLimitMigration`, `prepareNativeRenderCaseLimitMigration`, `readNativeRenderCaseLimitMigration` and `checkNativeRenderCaseLimitMigrationInvocation`.

**Tests.** `render-case-limit-migration.test.ts` applies `0001` and `0002` to synthetic SQLite with foreign keys on, writes invented reservations (an earlier day, a full client day of four, two same-case runs at the 10 s lease), counters and two success receipts, then runs the increment in one transaction. Every row of every table is identical afterwards, and every other object's SQL is identical; the two tables differ only in the two CHECKs. Afterwards the reservation, receipt and counter guards still refuse reuse, update, delete, reset, forgery, clock rollback, an early launch, a fifth client run and a case limit of 4; a third same-case run at limit 3 is admitted and a fourth refused. A failure part-way, or a copy-back that loses a reservation a receipt names, rolls back to the old schema and facts. Atomic per-file application on D1 itself is not proven here.
