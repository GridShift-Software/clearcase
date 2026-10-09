# Developing the local ClearCase app

The local pilot (GRS-12, CC-03): an operator imports a results package for a case folder, reads its validation report, previews and activates it, and follows a citation from the chronology or overview to the original, which opens safely or downloads. This page is the developer contract for the app and for the M2 view owners who extend it. The package contract is [results-package.md](results-package.md); words follow [GLOSSARY.md](../GLOSSARY.md).

## Stack decision

SvelteKit 2 with TypeScript, `node:sqlite` storage, run and built with Bun 1.4.2.

Three stacks were built against the same scenarios and judged before this ticket (local evidence: `spikes/stack-judge/judge-result.json` with `results/*.json` and `logs/`, not in Git). Scores out of 10:

| Stack | Score | Storage |
| --- | --: | --- |
| SvelteKit 2.70.3 + `node:sqlite` | 8.7 | two SQLite files: immutable results, precious user work |
| SvelteKit 2.70.3 + plain files | 8.1 | JSON files per version; whole versions held in memory |
| Vite SPA + Hono + plain files | 6.7 | JSONL without fsync; stopped on a torn tail |

All three met every budget by a wide margin, so no measured constraint justifies leaving the planned SvelteKit and TypeScript. The minimum viable storage choices were plain files and SQLite; SQLite won on crash safety with explicit pragmas, bounded memory, chronology speed and a clean split between rebuildable results and user work. The winning prototype was then hardened, converted to Bun, attacked and fixed (`spikes/pilot-hardened/`), and this app ports it onto GRS-10's package library. The Bun requirement is the user's (8 October 2026), recorded in `AGENTS.md`.

## Toolchain and commands

Exact pins are in `package.json` (`packageManager: bun@1.4.2`); the lock is `bun.lock`. Install once with `bun install --frozen-lockfile`, then run every script with `bun run --bun <script>`:

| Script | What it does |
| --- | --- |
| `check` | `svelte-kit sync`, `tsc` over the whole project, GRS-10's schema export and independent schema check, the view-registry drift check, `svelte-check` (warnings fail) |
| `build` | `vite build` (adapter-node) into `build/`, then `scripts/pilot/copy-pdfjs.ts` bundles pdf.js and the viewer into `build/pdfjs/` and stamps `build/clearcase-build.json` with the source revision; it also replaces adapter-node's `build/index.js` with a stub that exits 1, because that entry would listen on every interface (HOST unset) without the exact-Host check |
| `test` | Vitest: GRS-10's package suite and the pilot's unit tests (`src/lib/**/*.test.ts`); run it offline as `unshare -rn env OUTER_UID="$(id -u)" OUTER_GID="$(id -g)" tests/e2e/pilot/offline.sh bun run --bun test` |
| `test:e2e` | `tests/e2e/pilot/run.mjs`: the browser and durability suites against `./build`, each in its own network namespace, then the loopback bind check |
| `verify:pilot:v5` | the ten lanes on the real v5 sample, configured by the ignored `.local/v5-verification.json`, writing `lane-NN.txt` and `.png` to `$CLEARCASE_REPORT_DIR` |
| `measure` | `--ticket CC-02` runs GRS-10's measurement unchanged; `--ticket CC-03` measures the pilot budgets |
| `start` | `scripts/pilot/start.ts`: the production entry under Bun, and the only supported one; refuses to run without a build and never installs or builds |

Start the pilot only with `bun run --bun start` (`scripts/pilot/start.ts`). It binds both listeners to 127.0.0.1 whatever `HOST` says and checks the exact Host before static assets. `bun build/index.js` refuses to start. If the handler is served some other way, `hooks.server.ts` still answers 403 to any client address outside 127.0.0.0/8, `::1` and `::ffff:127.x`.

`scripts/agent-tools/verify app` runs the project verification skill (`.agents/skills/verify-clearcase/`): a fresh build of the committed revision in an isolated copy, an offline Bun boot, the live doctor, a drive through import, activation and a citation to the original, and cleanup.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLEARCASE_DATA_DIR` | `${XDG_DATA_HOME:-~/.local/share}/clearcase` | data directory, always resolved to an absolute path; a relative `XDG_DATA_HOME` is ignored. Holds `results.sqlite`, `work.sqlite`, `backups/`, `serve-tmp/`, `link-key`, `instance.lock`, `instance.pid` (the owner's pid and kernel start time: a live owner refuses a second instance even if `instance.lock` was removed) |
| `PORT` | 41101 | app origin `http://127.0.0.1:$PORT` |
| `ORIGINALS_PORT` | `PORT`+1 | originals site, bound to 127.0.0.1 |
| `ORIGINALS_HOSTNAME` | `clearcase-originals.localhost` | the originals site's host name: its own site and cookie jar |
| `CLEARCASE_KEEP_CANDIDATES` / `CLEARCASE_KEEP_BACKUPS` | 3 / 10 | retention of never-activated candidates per case, and of `work.sqlite` backups |
| `CLEARCASE_BUFFER_MAX_BYTES` | 32 MiB | originals up to this size are verified in memory; larger ones through a private snapshot |
| `BUILD_DIR` | `./build` | the build `start` serves |
| `CLEARCASE_FIXED_NOW` | unset (the real clock) | tests and verification only: fixes `now()` (see "Adding a view") to an ISO-8601 date or date-time with an offset |

Both listeners bind 127.0.0.1 only. A case folder that equals, contains or lies inside the data directory is refused; nothing is ever written into a case folder.

## Architecture

- `src/lib/case-package/` is GRS-10's library (read-only here). The app calls `importCandidate`, `verifyCandidateBytes`, `readCandidate`, `canActivate`, `acceptedWarnings`, `servePolicy` and `renderNarrative`; it never reimplements the contract.
- `src/lib/local-case/` is the app's server side (`*.server.ts`) and its browser-safe models:
  - `db.server.ts`: one `node:sqlite` connection; `results.sqlite` in WAL mode, `work.sqlite` attached with a rollback journal (`DELETE`), `synchronous=FULL` on both, set after `ATTACH` and verified; an exclusive instance lock; every write is one `BEGIN IMMEDIATE` transaction that retries a lock and answers 503, never 500.
  - `store.server.ts`: versions keyed by `resultsVersion`; `package_file` holds exactly `candidate.snapshot()`; verification is `verifyCandidateBytes` plus a digest over every projected row.
  - `project.server.ts`: the tested projector from `readCandidate` into read-model rows. Raw chronology rows are stored as canonical JSON, unchanged; display fields are derived, never written back; nothing is synthesised.
  - `service.server.ts`: import, activation, rollback, recovery, backups (below).
  - `originals.server.ts` and `viewer/`: the originals site and the pdf.js viewer.
  - `user-work.server.ts`: notes, seed overlays and register rows in `work.sqlite`.
  - `results.server.ts`: typed dataset access for views.
- `src/lib/components/`: the generated view registry and the shared view contracts.
- `src/routes/`: `/import`, `/import/[id]` (validation report and activation), `/recovery`, `/v/[vid]/overview`, `/v/[vid]/chronology`, `/v/[vid]/doc/[ref]`, the extension point `/v/[vid]/[category]/[view]`, and `/api/{health,state,import-progress,v/[vid]/chronology}`. `[vid]` is the URL-encoded `resultsVersion`.

**Import.** Inputs are checked on every import. A rejection stores one attempt row with its diagnostics and nothing else; the active version is unchanged. A candidate is stored in one transaction and the results WAL is checkpointed. The same package again is a no-op while its fresh validation reproduces the stored diagnostics and read model. If the originals changed since it was stored (one went missing, say), the re-import is rejected with `APP_ORIGINALS_CHANGED` and the current diagnostics (for example `ORIG_MISSING`): a stored version never changes, so the operator either restores the originals byte for byte and activates the stored import again, or converts the case folder and imports a new results version. The activation refusal gives the same guidance. The same `resultsVersion` with another manifest, another case folder or a retired id is rejected.

**Activation.** In order: the stored bytes (`verifyCandidateBytes`); revalidation by `importCandidate({files: stored}, caseFolder, {trustedBaseline})`, which re-hashes the originals read-only; the fresh projection must equal the stored read model; `canActivate` on that fresh result with the operator's acknowledgement and the case's trusted baseline; then the pointer swap and the bound acknowledgement in `work.sqlite`, and a `VACUUM INTO` backup. The trusted baseline is the active version's accepted warnings plus an operator-accepted register, both scoped by case id. Any failure changes nothing.

**Startup** never crashes: it removes its own leftovers, runs `quick_check`, verifies every active pointer against the activation log and falls back to the newest verified activation with a banner. A store that cannot be opened becomes a 503 page with restore instructions.

**An original removed or changed after import.** The document page checks its original when it renders, with the same cheap test the originals site makes before hashing (`OriginalsServer.availability`: the case folder recorded at import, the file opens inside it as a single-link regular file, the size is unchanged). If that fails, the page shows "Original missing on disk" with the reason and no Open or Download link, and the originals site answers 410; a same-size content change is still caught by the serve-time hash (410). Nothing is written and the version stays active. The operator recovers in one of two ways: restore the file at the path the page shows, byte for byte as imported (the links return on the next page load; the originals site re-hashes it against the imported sha256), or, if the case folder really changed, run the converter again, import the new results package and activate it (a still-missing original is then reported as `ORIG_MISSING` and acknowledged at activation). A container's page whose original is unavailable says so on each embedded attachment row ("the parent original is unavailable"), since those attachments are reached only through it. The overview's Originals counts are the check made at import, labelled with the import time; they are not re-checked live (the document page is). A file that was already missing at import cannot be restored into that version: the version records it as missing, and only a new results package (converter, import, activation) brings it in.

**Security.** The app origin sends a nonce CSP, `Referrer-Policy: same-origin`, COOP, CORP and `no-store`, checks the exact Host (the production listener also covers static assets) and relies on SvelteKit's Origin check for forms, which works without JavaScript. Imported values reach the DOM only as text, except GRS-10's `renderNarrative` output in `Narrative.svelte`. Originals are served only from the separate site, only through the verified mapping, only as verified bytes (else 410), with `servePolicy` headers; PDFs render only in pdf.js inside `<iframe sandbox="allow-scripts">` with scripting disabled. Cross-site or framed requests without the link capability get one constant 403.

## Adding a view

The 42 navigation entries are generated from the coordinator's inventory (`docs/plan/view-coverage.json`) into `src/lib/components/view-registry.ts` by `scripts/pilot/generate-view-registry.ts`; `check` fails on drift. Each entry has an id, label (the task name that is also the destination's heading, BA-18), group, owning planning key and Linear issue, route category, route and status.

A view owned by an M2 ticket lives at `/v/[vid]/<category>/<view-id>/`, where the category is the owner's: `evidence` (CC-04, GRS-14), `analysis` (CC-05, GRS-15), `quantum` (CC-06, GRS-16), `registers` (CC-07, GRS-17), `litigation` (CC-08, GRS-18), `bundles` (CC-09, GRS-19), `system` (CC-10, GRS-20). Until the owner's route exists, `src/routes/v/[vid]/[category]/[view]/` renders the entry's explicit "not yet available — owned by GRS-nn" state.

To build one:

1. Create `src/routes/v/[vid]/<category>/<view-id>/+page.svelte` (and `+page.server.ts`). SvelteKit prefers this static route to the extension point, so nothing else changes.
2. Wrap the page in `<main id="main" tabindex="-1">` and start it with `PageHeader` (`heading` = the registry label, `section` = the label, `caseName` from the layout data); put export controls in its `actions` snippet.
3. Read results with `datasetOf(app().store, version.id, '<dataset key>')` from `$lib/local-case/results.server`; the `/v/[vid]` layout has already verified the version. Use `readCandidate`-equivalent semantics: recognized datasets only, values untrusted.
4. Read the current time only through `now()` from `$lib/components/clock` (a `Date`), never `new Date()` or `Date.now()`, for anything shown or stamped: deadline countdowns, "today", ages. It is the real clock unless `CLEARCASE_FIXED_NOW` is set (for example `CLEARCASE_FIXED_NOW=2030-01-31T09:00:00Z`), which tests and the verification skill use to make date-sensitive views deterministic; an invalid value throws rather than falling back. The server checks it first at boot: an invalid value is a configuration error that exits with one `FATAL: CLEARCASE_FIXED_NOW must be …` line and code 1 before the data directory is opened, like a taken originals port (the startup checks themselves never throw). The root layout passes the setting to the browser, so `now()` agrees on both sides. Timers, timeouts and lock stamps keep the real clock.
5. Put every imported value into text nodes. Render authored narrative only with `Narrative.svelte` (citations resolve against the version's refs from `app().store.existingRefs`). Link documents with `CitationLink.svelte` or `docPath`; open originals with `OriginalOpen.svelte` and links built on the server by `originals()`.
6. Read document rows through the document-row contract, never from the chronology dataset directly (see below).
7. Keep user work in `app().userWork`: `putRow`/`listRows`/`deleteRow` for registers (store name `^[a-z][a-z0-9-]{0,63}$`, flat fields, stable UUID row ids, optional `DocumentAnchor`), `putSeedOverlay`/`seedViews` for seeded registers, `addNote`/`notesFor` for notes. A view that needs its own table defines it once with `defineTable` (see "Defining a table" below; `scope` is required) and then reads and writes it only through:
   - `putTableRow(table, row, {owner})`: inserts or replaces one row by primary key (an upsert). Cells are checked as in a restore (a missing cell is NULL), and a case table's row needs a text `case_id`. It is refused for a table that `owner` does not own (`table-conflict`), a built-in table (`table-built-in`), and a table not defined through `defineTable` (`invalid`).
   - `deleteTableRow(table, key, {owner})`: deletes by primary key; in a case table the key also names `case_id`, so another case's row is never deleted. Returns whether a row was deleted.
   - `listTableRows(table, {caseId?})`: rows in primary-key order, with cells as `exportAll` writes them. `caseId` is required for a case table and refused for a store table.

   Every write runs in one transaction and schedules the `work.sqlite` backup, as `putRow` does. A raw `app().storage` write schedules no backup. Never key user work by array index, display position or ref alone.
8. Add tests next to your code and a feature file in the verification skill (`features/`), and drive the view in your browser tests.
9. When your ticket passes its gate, the coordinator adds the view id to `AVAILABLE` in the generator and regenerates the registry.

### Document-row read contract

`documentRows(store, resultsVersion)` and `activeDocumentRows(app(), caseId)` in `$lib/local-case/documents.server` return every document row of a version: the imported register in source order, then rows from registered providers (the equivalent of v5's `allRows()`). Each `DocumentRow` is frozen and carries `ref`, `ord`, `source` (`'results'` or `'provider:<id>'`), the raw source `row` unchanged, its list projection `list` (`ChronologyListRow`) and its `state` (`DocumentStateRow`). `listJson` is the chronology list and its ETag as served by `/api/v/[vid]/chronology`; `documentRow(store, rv, ref)` is one row by ref (the document page reads it, so provider rows have pages); `documentCounts(store, rv)` is the row count the overview shows. GRS-20's rescan publishes rescanned rows with `registerDocumentRowProvider({id: 'rescan', owner: 'GRS-20', rows, revision})`; readers do not change. A provider row whose ref already names an imported document (or one the provider already gave), or whose `list.ref` is not its own `ref`, is dropped and reported in `dropped`, never shadowing or duplicating the register. `revision()` must return a safe ETag token: 1 to 128 characters of `A-Z a-z 0-9 . _ : + / = -` (`REVISION`). A provider whose `revision()` or `rows()` throws, returns the wrong type or an unsafe revision, or whose row list cannot be read, is isolated: its rows are left out, it is reported in `failed`, the chronology API still answers 200 (with an `x-clearcase-degraded` header and a distinct ETag), and the chronology and overview say "Some documents are not shown" (`DegradedRows.svelte`). The chronology page's universal load reads that header, so `hooks.server.ts` lets exactly that header through SvelteKit's SSR serialization (`filterSerializedResponseHeaders`); the list body stays the stored bytes. A malformed provider row (not an object, no non-empty, well-formed Unicode string `ref` (`isWellFormed()`: a lone surrogate would break the page's links), `row` not an object, `list` or `state` not of the `ChronologyListRow`/`DocumentStateRow` shape, not JSON data, or a property read that throws) is dropped and reported in `dropped` (`ref` is `#<index>` when it cannot be read) and the other rows are shown. Each row is copied as JSON first, reading every property once, and the copy is what is validated and shown, so readers only ever see plain, checked data. A thrown value that cannot be turned into text is reported as such; it never escapes provider isolation. A `state.original` without a non-empty `path`, a non-negative integer `size`, a lower-case hex `sha256` and a string `mediaType` is replaced by `null` (the page shows no original) and reported in `dropped`; the row is kept. `dropped[].reason` is a `DropReason`, and no reason echoes row values.

### Enumerable user-work persistence

Every `work.sqlite` table is enumerable: `app().userWork.tables()` introspects SQLite and labels each table from `work.userwork_catalog` as `user-work`, `activation` or `unregistered` (a table created outside the API is still listed), with its `scope`. `exportAll({kinds?})` returns a `clearcase.user-work/1` snapshot of every row, each table with its metadata (`name`, `kind`, `scope`, `owner`, `description`, `columns`). BLOBs are `{"$b64": …}`; INTEGERs are read as BigInt, and one beyond the JavaScript safe range is written as `{"$int": "<decimal>"}`, so no value is rounded and no value fails the export. `importAll(snapshot)` restores it in one transaction, creating any table the snapshot defines inside that same transaction (an unregistered table stays unregistered), so a refused or failed restore leaves no table behind. A table that already exists must have the snapshot's schema (ordered column names, declared types compared case-insensitively, NOT NULL, where a key column always counts as NOT NULL, and the ordered primary key) and scope; any difference refuses the whole restore before a row is deleted or written, naming the table and the difference, so no value is coerced into another type. Migrate such a table first. Only SQLite's own `sqlite_*` tables and the catalogue (`userwork_catalog*`) are hidden from `tables()`. `registerStores(caseId)` lists the register stores in `register_row`.

**Invariant.** A snapshot from `exportAll()` always restores with the default mode, into the same store (also after later edits, except where a later edit gave another case a snapshot row's key: see `restore-key-collision`) and into a fresh store. `exportAll` applies the same table and row checks as `importAll`, and a table that would fail them is not exported but listed in `excluded` with its row count and the reason: no primary key, a column type other than the four, a name outside the rules, activation or import state, an empty or non-integer key (for example `1.5` in an `INTEGER` key), a repeated key, a non-finite number, NULL in a NOT NULL column, or a non-text `case_id` in a case table.

**Defining a table.** A ticket that needs its own table calls `defineTable({name, owner, description, columns, primaryKey, scope})`: lower-case names not starting with `sqlite` or `userwork_catalog`, `TEXT`/`INTEGER`/`REAL`/`BLOB`, unique column names and a primary key of stable ids with no column listed twice, and text `owner` and `description`. It is idempotent, and GRS-20's backup round-trips the table with no per-table code. Redefining an existing table (matched in any letter case, as SQLite does) needs the same schema, including the ordered primary key, the same owner and the same scope; a table that exists under another letter case is refused. Adopting a table created outside the API is also refused when a key column or `case_id` has a collation other than `BINARY` (for example `NOCASE`), since a restore matches keys and cases byte for byte. The built-in tables (`note`, `seed_overlay`, `register_row`, `trusted_warning`, `active`, `activation_log`) and the `results.sqlite` table names cannot be defined.

**Scope** is required and declared, never inferred from a column name. A definition without `scope` is `invalid`:

- `scope: 'case'`: every row belongs to the case in its `case_id` column, which must be `TEXT` and NOT NULL (`notNull: true`, or part of the primary key). All built-in tables are case tables. Registers and other per-case work (CC-07 "scope records to the selected case") use this.
- `scope: 'store'`: rows shared by the whole store. A store table must not have a `case_id` column, so an owner who wants per-case rows has to say `'case'`. A per-case column under another name (`case_key`, `caseId`) makes nothing per-case: the table is a store table and a restore merges it.
- Why required: a store table is merged by key, whichever case wrote a row. If a per-case table without `case_id` silently became a store table, and its keys repeat across cases (for example reused integer ids), restoring one case's backup would overwrite another case's rows with the same keys. A required scope makes the owner choose. Keep `case_id` in a case table and its key; give store-table rows keys that are unique across the whole store and never reused.
- The scope never changes once a table exists. `defineTable` with `'case'` on a table recorded or treated as `'store'` (including a table created outside the API, or catalogued before scopes were recorded), or the reverse, is `table-conflict`.
- The scope is recorded in the catalogue (the companion table `work.userwork_catalog_scope`, created on first use; `db.server.ts` seeds `userwork_catalog` without a column list, so that table gains no column). A table without a recorded scope (unregistered, or defined before scopes existed) is a store table. A snapshot table without a `scope` field (written before scopes existed) keeps the scope of the table it restores into, or becomes a store table when it creates one.

**Restore rules** (`importAll(snapshot, {replace?})`, default `'cases'`):

- The snapshot's cases are the `case_id` values of its case tables' rows, outside `trusted_warning`.
- A case table: the rows of the snapshot's cases are deleted, then the snapshot's rows are inserted; other cases' rows are kept. Before any write, no snapshot row may have the primary key of a row of **another** case here (possible only when the key does not include `case_id`, as for `note.id`). Keep `case_id` in a case table's key, or use ids unique across cases. When the snapshot holds no case rows, no case table changes.
- A store table is merged by primary key: snapshot rows replace same-key rows, and other rows are kept. It is never replaced wholesale in this mode. So a merge brings back rows deleted since the backup and overwrites later edits of the same keys, while rows added since are kept.
- `{replace: 'tables'}` replaces every snapshot table as a whole, deleting other cases' and other keys' rows too. Use it only for a full restore of one store into another.
- `trusted_warning` is never written: a restore never creates trust. Its rows are dropped and the store's own accepted warnings are kept, so the operator acknowledges those warnings again.
- `ImportResult` is `{tables, rows, cases, restored, dropped?}`. `cases` lists the snapshot's cases. `restored` has one `{name, scope, action, rows, deleted}` per snapshot table, in snapshot order, so a backup UI can show what happened. `action` is one of:
  - `replaced-for-cases`;
  - `no-cases`: a case table left unchanged because the snapshot holds no case rows;
  - `merged`;
  - `replaced` (`'tables'` mode);
  - `dropped` (`trusted_warning`).

  `rows` counts the snapshot rows written and `deleted` the rows removed first. A `merged` entry also has `inserted` (rows whose key was new here) and `replaced` (rows whose key was already here and now holds the snapshot's row), which add up to `rows`. A `replaced-for-cases` entry also has `cases`, the snapshot's cases this table had rows of here or gets rows of (sorted), so a backup UI can say "case X: 3 rows replaced". The fields are additive; a reader that ignores them sees the round 2 shape. `dropped` (`{name, rows, reason}`) is present only when trust rows were dropped.

**Every refusal or failure** is a `UserWorkError` with a `code`. Its message names tables and columns, never row values. Everything is checked before the first write except a constraint that only SQLite can see, such as another UNIQUE index on an unregistered table; that rolls back as `invalid`. The codes:

- `invalid`: bad input. This covers a missing or unknown `scope` in `defineTable`, a table-row call on a table not defined through `defineTable`, a missing `caseId` (case table) or a given one (store table) in `listTableRows`, a row with a column the table lacks, a snapshot or table entry that is not an object (including a `null` entry), a table listed twice, a name taken by an index, view or trigger here, another schema or scope, and a cell that is not a string, a finite number, null, `{$b64: <base64>}` or `{$int: <decimal in the signed 64-bit range>}` (booleans, arrays and other objects are refused). It also covers NULL in a NOT NULL column, a non-text `case_id` in a case table, bad `defineTable` input, or a write that failed for another reason, with nothing written.
- `restore-state`: the snapshot carries an activation table (`active`, `activation_log`, or any table of kind `activation`) or a `results.sqlite` (import state) table name. Activation is never restored; `exportAll({kinds: ['activation']})` lists those tables in `excluded`.
- `restore-key`: a primary-key cell of a restore or `putTableRow`/`deleteTableRow` row is empty (NULL or missing), not an integer in an `INTEGER` key column (including an `$int` outside 64 bits), or the same key appears twice in one table.
- `restore-key-collision`: a snapshot row of a case table (in case scope) or a `putTableRow` row has a key held by a row of another case here.
- `table-conflict`: `defineTable` on an existing table of another schema, owner or scope, one in another letter case, or one with a non-`BINARY` collation on a key or `case_id` column; a table-row write by an owner other than the table's.
- `table-built-in`: `defineTable` or a table-row call on a built-in or `results.sqlite` table.

### Overview widget slots

The overview has typed widget slots declared in `src/lib/components/overview-slots.ts`: `deadlines` and `unbilled-time` (GRS-17, category `registers`) and `rescan-freshness` (GRS-20, category `system`). An owner fills its slots from its own subtree: `src/lib/views/<category>/overview-widgets.ts` exports `widgets: OverviewWidget[]` (`{slot, component}`, a Svelte component receiving `{data, ctx}`) and `src/lib/views/<category>/overview-widgets.server.ts` exports `loaders: OverviewWidgetLoader[]` (`{slot, load(ctx)}`, with `ctx.app` the server's `LocalCase`). Both are discovered with `import.meta.glob`; the category in the path must be the slot owner's, a slot may be filled once, and a loader that throws, does not settle within `SLOT_LOADER_TIMEOUT_MS` (5 seconds), or returns data the page cannot carry, marks only its slot ("This summary could not be loaded."); the other slots and the overview still render. The timeout bounds only waiting on a pending promise. It cannot interrupt a loader that computes synchronously (`node:sqlite` reads are synchronous): such a loader blocks the whole server until it returns. Keep loaders asynchronous where they wait, and bounded within the overview budget where they compute. Plain data is primitives, arrays, plain objects, `Date`, `Map` and `Set`: not a function, a class instance, a symbol or a thenable, no own `__proto__`, `constructor` or `prototype` key, and nested at most `MAX_SLOT_DATA_DEPTH` (100) levels deep. That is a subset of what SvelteKit's serializer (devalue) accepts. Until a slot is filled the overview shows "Not yet available — owned by GRS-nn". New slots are added to `OVERVIEW_SLOTS` by the coordinator.

**Paths a view owner may write:** `src/routes/v/[vid]/<category>/**` for their own category, and the owner-specific paths the coordinator reserves at dispatch: proposed `src/lib/views/<category>/**` (where overview widgets live), `tests/e2e/<category>/**`, and their own feature files under `.agents/skills/verify-clearcase/features/`.

**Coordinator-serialized files** (one writer at a time, through the coordinator): `package.json`, `bun.lock`, `tsconfig.json`, `vitest.config.ts`, `svelte.config.js`, `vite.config.ts`, `src/app.*`, `src/hooks.server.ts`, `static/**`, `src/routes/+layout.*`, `src/routes/+error.svelte`, `src/routes/v/[vid]/+layout.*`, `src/routes/v/[vid]/[category]/[view]/**`, `src/lib/components/**` (shared contracts and the registry), `src/lib/local-case/**` (storage, persistence API, originals), `scripts/pilot/**`, `tests/e2e/pilot/lib/**`, and the skill's `SKILL.md` and runner.

## Shared contracts

| Contract | Where | Use |
| --- | --- | --- |
| Registry and navigation | `views.ts`, `view-registry.ts`, `ViewNav.svelte` | `VIEWS`, `viewHref`, `viewAt`, `blockedBy`; nav marks the current view with `aria-current` |
| Page header and titles | `PageHeader.svelte`, `titles.ts` | `<document> · <section> · <case> · ClearCase` (BA-16); the `[data-page-heading]` h1 receives focus after navigation, Back and Forward, including a full load reached by Back and Back from an in-page fragment link (such as the validation report's `#code-<CODE>` links) to the page's own entry, which SvelteKit handles as a same-page popstate without `afterNavigate` (the root layout's `popstate` listener focuses the heading) (BA-14); the skip link focuses `#main` without a history entry |
| Clock | `clock.ts` | `now()`: the real clock, or `CLEARCASE_FIXED_NOW` in tests and verification |
| Citation link | `CitationLink.svelte`, `cite.ts` | `/v/<rv>/doc/<ref>?page=N` via GRS-10 `documentRoute`; missing refs render broken |
| Narrative | `Narrative.svelte` | the only `{@html}`: `renderNarrative` output |
| Original open | `OriginalOpen.svelte`, `OriginalLinks` in `model.ts` | direct, parent-route and unavailable states (BA-09), and "missing on disk" when an imported original cannot be served now; labels from the verified mapping |
| Table and grid | `DataGrid.svelte` | div grid with ARIA table roles, `content-visibility`, sortable headers with `aria-sort`, rows keyed by stable id |
| Dates | `DateValue.svelte`, `format.ts` `dateBasis` | the source value with its supplied type and provenance, or "basis unknown" (BA-04) |
| Unavailable view | `UnavailableView.svelte` | the explicit state for a registry entry whose owner has not passed |
| Export | `csv.ts` | `toCSV` (quotes on `"` `,` CR LF), `userCell` neutralises formulas in user-entered cells |
| User work | `user-work.server.ts` | notes, seed overlays and register rows in `work.sqlite`, keyed by stable ids |
| Results data | `results.server.ts` | `datasetOf`, `datasetKeys` over the verified stored bytes; `viewContentOf` (the `view-content` dataset through GRS-38's `readViewContent`) and `viewText`, which fills a template from imported data and returns null when the field is absent, blank, not text or names a param the caller cannot fill |
| Document rows | `documents.server.ts`, `DegradedRows.svelte` | `documentRows`, `documentRow`, `documentCounts`, `activeDocumentRows`, `listJson`, `registerDocumentRowProvider`, `anyDateBasis` (whether any imported row has a supplied date type); the degraded state when a provider fails |
| User-work enumeration | `user-work.server.ts` | `tables`, `defineTable` (scope required), `exportAll`, `importAll`, `registerStores` |
| Defined-table rows | `user-work.server.ts` | `putTableRow(table, row, {owner})`, `deleteTableRow(table, key, {owner})`, `listTableRows(table, {caseId?})`: validated like a restore, case-scoped, backed up like `putRow` |
| Overview slots | `overview-slots.ts`, `OverviewSlots.svelte`, `overview-widgets.server.ts` | widget slots filled from `src/lib/views/<category>/` |

**Case wording from view-content.** Wording v5 hard-coded in its view code arrives as the package's `view-content` dataset (GRS-38, `docs/results-package.md`). Views read it on the server with `viewText(viewContentOf(store, rv), view, field, params)`, fill template params from imported data only, and never write case wording into app code. A missing dataset or field leaves a neutral layout: the `/v/[vid]` layout uses `_shell.documentTitle` as the case part of page titles (`version.titleName`) and `_shell.brandName` at the top of the view navigation (`version.brand`), both falling back to the case name; the overview uses `overview.subtitle` (else the matter title, else the case name) and shows `kpiDocumentsNote` and `kpiInvoicesNote` as the source's captions beside the counted figures, or only the counted figures.

## Verification

Tests use synthetic cases built by GRS-10's converter (`tests/e2e/pilot/lib/fixtures.ts`); real v5 data appears only in `verify:pilot:v5` and `measure`, which keep their outputs in `.local/` or `$CLEARCASE_REPORT_DIR`. Every browser and server test runs inside `tests/e2e/pilot/offline.sh`: a network namespace with only `lo`, the host resolver's sockets hidden in a private mount namespace (a network namespace alone still lets systemd-resolved resolve names), and the caller's uid. Runners prove loopback works and outbound TCP and DNS fail before they start; a missing `unshare`, `ip` or Chromium fails the run. Chromium is `$CLEARCASE_CHROMIUM` or the Playwright build under `~/.cache/ms-playwright/`.

The ignored locator `.local/v5-verification.json` names the accepted package identities of the real sample. `accepted` stays GRS-10's identity (`resultsVersion`, `diagnosticsSha256`); `verify:package` lane 11 recomputes it from a conversion without `view-content`. Since the converter emits the `view-content` dataset (GRS-38), `acceptedViewContent.resultsVersion` names the resultsVersion of a conversion that carries it, and `tests/e2e/pilot/v5/fixture.mjs` requires it: `loadConfig` returns it as `fx.accepted.resultsVersion` (with GRS-10's `diagnosticsSha256`, which view-content does not change) for `verify:pilot:v5` and `parity`, and GRS-10's own identity as `fx.acceptedBase`. Add the member to an existing locator from the CC-30 report; the values stay out of Git.

## Known limits

- The store API is synchronous over `node:sqlite` (writes are async transactions). The V2 move to D1 needs an async seam; the judge recommended one from the start.
- A hard-linked original is accepted by GRS-10 at import but refused (410) when served, because a hard link may share bytes with a file outside the case folder.
- Original bytes are re-read and hashed on every request; there is no `(path, size, mtime) → sha256` cache yet.
- Search, the newer 2,131-document export and every view other than overview and chronology belong to later tickets.
