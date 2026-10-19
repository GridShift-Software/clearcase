# Workers runtime proof: the local workerd leg (GRS-106)

[GRS-106](https://linear.app/vaper/issue/GRS-106) asks for a synthetic probe that proves SvelteKit 3, built with Bun, on the Workers runtime, and names the app's migration work. On 19 October 2026 the user scoped this unit to the **local workerd leg**: `wrangler dev --local` with local D1 and R2, no Cloudflare account.

**Verdict: PASS for the local workerd leg; HOLD for the rest.** Every leg below passes on native workerd, offline. What stays HOLD is listed [at the end](#what-stays-hold). The probe is not the production migration.

## Run it

From `tests/hosting-probe/runtime/`, a workspace with its own pins and `bun.lock`. It is not a member of the root workspace.

```sh
bun install --frozen-lockfile        # once, online
bun run --bun probe                  # ~7 s; writes .local/hosting-probe/runtime/summary.json at the repo root
bun run --bun probe --check FILE     # exit 0 only for this runner's PASS summary for HEAD
bun run --bun surface                # prints the migration surface below
```

[`probe.ts`](../../../tests/hosting-probe/runtime/probe.ts) refuses to run (exit 2) on a dirty tree, on any Bun other than `packageManager`'s 1.4.2, when an installed package differs from its pin, or when the only `node` it finds is Bun. Under `bun run --bun`, `node` on `PATH` is Bun, so the runner looks further along `PATH` for a real Node. It re-runs itself inside [`tests/e2e/pilot/offline.sh`](../../../tests/e2e/pilot/offline.sh), which gives it a new network namespace with only loopback up and hides the host resolver. It then checks again that the only interface is `lo` and that no IPv4 or IPv6 route exists. Each child gets an explicit environment. The allowlist is the spike's: a fresh `HOME` and XDG directories, `CI=1`, and telemetry, error reports, the update banner, the `cf.json` fetch and dotenv/process-env loading all turned off. No account, login, token or Cloudflare request is possible.

The summary records the source SHA and pins. It also records the host of each step, a digest of the Worker bundle, the stamp the Worker served, every leg's commands and assertions, and the HOLD list. `evidence` is `true` only when:

- every leg passes;
- the served build stamp is HEAD;
- HEAD and the tree are unchanged at the end;
- the runner's own checker refuses its summary after any one leaf or container of it is deleted, nulled, retyped, emptied, flipped or zeroed, or after an unknown key is added to any object (`checker.mutationsRefused` counts them). `--check` compares the whole summary with one expected shape: exact key sets, types and values at every level. The standalone `bun run --bun test:check` in the runtime workspace mutates the committed summary the same way and runs the real `--check` on each mutant (550 at the time of writing).

Logs and local D1/R2 state stay in the run directory under `.local/hosting-probe/runtime/`. The committed run is [evidence/runtime-summary.json](evidence/runtime-summary.json); it names the SHA it ran at.

## What runs where

| Step | Host |
| --- | --- |
| `vite build` with adapter-cloudflare (`bun run --bun build`, offline) | Bun 1.4.2; the build prints its host, and the runner asserts it |
| Runner, HTTP requests, assertions, summary | Bun 1.4.2 |
| `wrangler dev --local`, `wrangler d1 execute --local` | Node 26.10.0 hosts Wrangler only. Bun-hosted `wrangler dev` printed Ready and then timed out on the first request in the spike (`spikes/local-workerd-20261017/report.md`), so the runner never uses it |
| The app | native workerd 1.20261012.1, a descendant of Wrangler's process; the runner asserts it from `/proc` |

Bun evidence covers the build. Only workerd evidence covers the running app.

## Legs

| Leg | What it asserts |
| --- | --- |
| build | `vite build` exits 0 offline under Bun, writes `.svelte-kit/cloudflare/_worker.js`, and stamps `_app/version.json` with HEAD (Kit's `version.name`) |
| request | `wrangler d1 execute --local` applies [`schema.sql`](../../../tests/hosting-probe/runtime/schema.sql) in its own process. Wrangler, hosted by Node, starts native workerd. `GET /` is 200 `text/html`, `/probe.txt` comes byte for byte from the ASSETS binding, `/_app/version.json` serves the HEAD stamp, and an unknown path is 404 |
| render | SSR renders the D1 row the CLI inserted, so the CLI and workerd share one local D1, and reads R2 (empty) |
| binding-access | `GET /bindings` sees `DB.prepare`, `BUCKET.put` and `ASSETS.fetch` as functions, and D1 answers a count through the binding |
| action | a same-origin `POST /?/save` writes D1, then puts the R2 object and reads it back (200). A fresh GET reads both |
| failure-action | an empty form returns 400 with its message. A duplicate id returns 409, because D1's UNIQUE refused the INSERT. A foreign Origin returns 403 from SvelteKit's Origin check and runs no action. After all three, D1 has no new row and R2 still holds the last good write |
| persistence | the server's process group gets SIGINT, then SIGTERM and SIGKILL if it must; the leg asserts that the tree ended without SIGKILL and with no process left, and records the signal that ended it. A separate `wrangler d1 execute` reads both rows from the stopped server's state. After a restart, and before any write, SSR renders the rows and the R2 object |
| failure-binding-missing | the same build runs under `--env missing-binding`, with D1 and ASSETS but no R2 (this Wrangler environment inherited ASSETS but dropped D1 and R2, so `wrangler.toml` redeclares D1 and leaves R2 out). `GET /` and the action return 503 naming `BUCKET`, with no partial page, and `/bindings` reports BUCKET absent |

The probe app ([`src/routes/`](../../../tests/hosting-probe/runtime/src/routes/+page.server.js)) reads bindings with `import { env } from 'cloudflare:workers'`, because adapter 8 drops `platform.env`. Its `binding(name)` helper turns a missing binding into `error(503)` before any I/O. GRS-112 can adopt the same shape.

## Findings for GRS-112

Local D1 refuses most of the SQLite statements that the local store issues. These results come from a throwaway `wrangler d1 execute --local` run on 19 October 2026, offline, on fresh synthetic state. They are local D1 results, not remote D1 results.

| Statement (local store site) | Local D1 |
| --- | --- |
| `PRAGMA journal_mode`, `PRAGMA synchronous` (`db.server.ts:95,148`) | refused, `SQLITE_AUTH` |
| `PRAGMA busy_timeout` (`db.server.ts:146,150,200`) | refused, `SQLITE_AUTH` |
| `PRAGMA wal_checkpoint(TRUNCATE)` (`db.server.ts:252,268`) | refused, `SQLITE_AUTH` |
| `ATTACH DATABASE … AS work` (`db.server.ts:147`) | refused, `SQLITE_AUTH`. `results.sqlite` and `work.sqlite` cannot be one connection |
| `BEGIN IMMEDIATE … COMMIT` (`db.server.ts:231-244`) | refused: D1 has no SQL transactions; atomic writes need `batch()` |
| `VACUUM work INTO ?` (`store.server.ts:185`) | refused. Pre-restore and post-activation copies need another mechanism, such as an R2 snapshot or D1 Time Travel |
| `SELECT sqlite_version()` | refused, "not authorized to use function" |
| `PRAGMA foreign_keys`, `PRAGMA quick_check(1)`, `PRAGMA data_version` | accepted |

## Pins, licences and advisories

Exact installed versions. The runner refuses any other. Publication times come from the npm registry and were read on 19 October 2026.

| Package | Pin | Published | Licence | Primary source |
| --- | --- | --- | --- | --- |
| Bun | 1.4.2 | 5 Sep 2026 | MIT (bundles LGPL-2 JavaScriptCore) | [release](https://bun.com/blog/bun-v1.4.2) |
| `@sveltejs/kit` | 3.1.0 | 14 Oct 2026 | MIT | [registry](https://registry.npmjs.org/@sveltejs/kit/3.1.0), [changelog](https://github.com/sveltejs/kit/blob/%40sveltejs/kit%403.1.0/packages/kit/CHANGELOG.md) |
| `@sveltejs/adapter-cloudflare` | 8.0.1 | 14 Oct 2026 | MIT | [registry](https://registry.npmjs.org/@sveltejs/adapter-cloudflare/8.0.1), [README](https://github.com/sveltejs/kit/blob/%40sveltejs/adapter-cloudflare%408.0.1/packages/adapter-cloudflare/README.md) |
| `svelte` | 5.57.2 | 6 Oct 2026 | MIT | [registry](https://registry.npmjs.org/svelte/5.57.2) |
| `@sveltejs/vite-plugin-svelte` | 7.3.1 | 23 Sep 2026 | MIT | [registry](https://registry.npmjs.org/@sveltejs/vite-plugin-svelte/7.3.1) |
| `vite` | 8.3.4 | 8 Oct 2026 | MIT | [registry](https://registry.npmjs.org/vite/8.3.4) |
| `wrangler` | 4.151.1 | 16 Oct 2026 | MIT OR Apache-2.0 | [registry](https://registry.npmjs.org/wrangler/4.151.1), [system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) |
| `miniflare` | 5.20261012.1-beta | 16 Oct 2026 | MIT | [registry](https://registry.npmjs.org/miniflare/5.20261012.1-beta) |
| `workerd` | 1.20261012.1 | 12 Oct 2026 | Apache-2.0 | [registry](https://registry.npmjs.org/workerd/1.20261012.1), [README](https://github.com/cloudflare/workerd/blob/v1.20261012.1/README.md) |
| Node (Wrangler host, not pinned) | 26.10.0 | | MIT | [release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) |

Compatibility date `2026-10-12` with the `nodejs_als` flag, as in the spike ([adapter guide](https://svelte.dev/docs/kit/adapter-cloudflare)). TypeScript and `@opentelemetry/api` are optional peers of Kit 3 and the probe needs neither, so it drops them.

**Advisories.** `bun audit` on 19 October 2026 found no vulnerabilities in the 157 packages of this lockfile, so no advisory is open. `bun audit` covers the npm packages in the lockfile only. It does not cover the Bun or Node binaries.

**Upgrade decision per pin.**

- Kit, the adapter, Svelte, the Svelte plugin, Vite and Wrangler: each pin is its `latest` tag on 19 October 2026. Retain them.
- `workerd`: 1.20261019.1 was published on 19 October 2026, but Wrangler 4.151.1 depends on exactly `workerd` 1.20261012.1 and `miniflare` 5.20261012.1-beta. Retain the pair. Upgrade Wrangler, Miniflare and workerd together, never workerd alone.
- Bun: retain 1.4.2. It is a user requirement (8 October) and `packageManager`'s pin. Bun moves only through `bun upgrade --stable` followed by a reviewed `packageManager` commit, and this unit did not look for a newer release.
- `miniflare`: this version comes from the `beta` dist-tag and is Wrangler's exact dependency. Retain it for local development and tests only; it never ships, since Cloudflare runs the Worker on its own workerd. Revisit it with the next Wrangler.
- Node: ADR 0008 names a Node 24 LTS helper. Node 24 enters maintenance on 20 October 2026 and Node 26 becomes LTS on 28 October 2026. This host has only Node 26.10.0, which satisfies Wrangler's `engines` (>= 22). **Open:** which Node line hosts Wrangler in CI ([follow-ups](#what-stays-hold)).

**Licences.** The 83 installed package manifests break down as:

| Licence | Packages |
| --- | --- |
| MIT | 62 |
| Apache-2.0 | 8 |
| MIT OR Apache-2.0 | 4 |
| MPL-2.0 | 3 |
| ISC | 2 |
| LGPL-3.0-or-later | 2 |
| BSD-3-Clause | 1 |
| CC0-1.0 | 1 |

The Worker bundle comes from Kit and Svelte (MIT) and their runtime dependencies. The non-permissive licences belong to development tools that the bundle never imports:

- LGPL-3.0-or-later: `@img/sharp-libvips-*`, the prebuilt libvips of Miniflare's `sharp`;
- MPL-2.0: `lightningcss`, Vite's CSS tool;
- CC0-1.0: `@speed-highlight/core`, used by Miniflare's error pages.

None ships or is distributed, so none blocks.

## Migration surface

This is GRS-112's work order. [`surface.ts`](../../../tests/hosting-probe/runtime/surface.ts) builds the hosted entry graph:

- it starts from the 115 SvelteKit entry files under `src/`: `hooks.server.ts` and every `+page`, `+layout`, `+server` and `+error` file, tests excluded;
- it follows static imports, re-exports, literal dynamic imports and `import.meta.glob` patterns through `$lib` and relative paths;
- it erases type-only imports first, as the build does.

It reaches 278 files. Of those, **24 use a local-only dependency themselves**: 17 the filesystem, 5 SQLite, 9 process state or listeners, and 2 browser-local storage. The graph reaches no `scripts/pilot/` file and no file outside `src/`. It has no dynamic import that it could not resolve.

The census was cross-checked against a plain `grep` of the same patterns over `src/` and `scripts/pilot/`, tests excluded. The grep found exactly these 24 files plus five that the census rightly leaves out:

- `scripts/pilot/start.ts`: the local entry, which binds the listeners;
- `scripts/pilot/copy-pdfjs.ts` and `scripts/pilot/generate-view-registry.ts`: build-time scripts;
- `src/lib/local-case/test-support.ts`: tests only;
- `src/lib/user-work/backup/v5-keys.ts`: `localStorage` appears only in a comment.

The line numbers below are at `4d5f7be`. This branch does not change `src/`.

| File | Uses (line) | Replacement |
| --- | --- | --- |
| `src/lib/analysis/data.server.ts` | process: `process.env` 13 (`CLEARCASE_ANALYSIS_ADDITIONS`) | read the flag from the Worker's `env` vars per request |
| `src/lib/case-package/originals.ts` | filesystem: `node:fs` 9, `node:fs/promises` 10 (open, locate, hash and verify originals) | tenant object metadata plus R2 reads, with the same size and digest checks |
| `src/lib/case-package/source.ts` | filesystem: `node:fs` 1, `node:fs/promises` 2 (directory and ZIP package source) | R2 object source; the in-memory `{files: Map}` source already avoids the disk |
| `src/lib/case-package/writer.ts` | filesystem: `node:fs/promises` 1 (writes a package directory) | converter-side only; no hosted disk destination, so write to R2 |
| `src/lib/case-package/zip.ts` | filesystem: `node:fs` 1, `node:fs/promises` 2 (FileHandle reads, extraction to disk) | stream ZIP entries from R2; no extraction to disk |
| `src/lib/components/clock.ts` | process: `process.env` 16 (`CLEARCASE_FIXED_NOW`) | request-scoped clock from `env` vars; tests inject it |
| `src/lib/components/ViewNav.svelte` | browser-local: `sessionStorage` 12 (per-tab view queries) | keep (a per-origin tab store), and clear it at sign-out |
| `src/lib/local-case/app.server.ts` | filesystem: `node:fs` 2 (build stamp); process: `process.env` 15, 25, `process.exit` 27, 41, 49, `process.once('sveltekit:shutdown')` 52 | delete from the hosted graph: inject request services (`App.Locals`) from bindings; there is no process lifecycle, instance lock or originals listener |
| `src/lib/local-case/case-pack.server.ts` | filesystem: `node:fs` 2, `node:fs/promises` 3, `node:os` 4 (folder browser, pack extraction) | uploads and object listings; `/api/browse` must 404 in the hosted build (REVIEW.md, local-only import) |
| `src/lib/local-case/config.server.ts` | filesystem: `node:os` 1 (home and data dir); process: `process.env` 20, 40 | settings from `env` bindings and vars; no data directory or ports |
| `src/lib/local-case/db.server.ts` | SQLite: `node:sqlite` 1, the connection behind every statement (`.prepare(` 93, 147, 256, 261, `db().exec(` 252); filesystem: `node:fs` 2; process: `process.pid` 194, 203, 205 (instance lock) | stays the local adapter; the hosted store is D1 with `batch()` for atomic writes (see [findings](#findings-for-grs-112)); delete the instance lock |
| `src/lib/local-case/fsafe.server.ts` | filesystem: `node:fs` 2, `node:fs/promises` 3 (descriptor containment, snapshots) | not needed over R2; integrity moves to digest checks before any byte is served |
| `src/lib/local-case/originals.server.ts` | filesystem: `node:fs` 2, `node:fs/promises` 3; process: `node:http` 4, `.listen(` 229, `process.env` 53, `process.pid` 193 | authenticated originals route over R2 (whole object verified before bytes leave); pdf.js from deployment assets; no second listener |
| `src/lib/local-case/rescan/rescan.server.ts` | filesystem: `node:fs` 2, `node:fs/promises` 3 (disk scan, hashing) | R2 object listing and metadata, with optional content checks |
| `src/lib/local-case/results.server.ts` | SQLite: `.storage.db()` 17, 29 (bypasses `CaseStore`) | awaited package-file reads through the store interface |
| `src/lib/local-case/service.server.ts` | filesystem: `node:fs/promises` 2, `node:fs` 3, `process.cwd()` 217; SQLite: `.storage.db()` 89 | awaited case state (verify, activate, rollback) over D1 and R2; no local recovery or paths |
| `src/lib/local-case/store.server.ts` | SQLite: `.storage.db()` 52, `.prepare(` on 45 lines from 55 to 267; filesystem: `node:fs` 1; process: `process.pid` 183 | an async store interface implemented on D1; `VACUUM INTO` backups become R2 snapshots |
| `src/lib/local-case/user-work.server.ts` | SQLite: `.storage.db()` 91, `.prepare(` on 35 lines from 112 to 618 | an async user-work interface on D1; restores atomic through `batch()` |
| `src/lib/user-work/backup/backup.server.ts` | filesystem: `node:fs` 2 (pre-restore JSON copy); process: `process.pid` 110 | await a durable R2 pre-restore snapshot before any D1 write |
| `src/lib/views/system/backup.server.ts` | filesystem: `node:fs/promises` 1 (restore from a path) | upload, or an R2 object, only |
| `src/lib/views/system/manual.server.ts` | filesystem: `node:fs/promises` 4 (`stat` of a linked sample) | R2 object metadata |
| `src/routes/+layout.svelte` | browser-local: `sessionStorage` 14, 43 (Back reload marker, a URL) | keep |
| `src/routes/api/health/+server.ts` | process: `process.pid` 10 (instance diagnostics) | hosted health without process facts, or remove it |
| `src/routes/import/+page.server.ts` | filesystem: `node:os` 2 (`homedir()` for the folder picker) | the upload form; no home directory |

Sixty-one more reachable files import one of these 24 directly. They reach the dependency only through that file, so each needs the file's replacement interface (awaited and injected per request) rather than a platform swap of its own. Those with the most importers:

| Module | Importers |
| --- | ---: |
| `src/lib/local-case/app.server.ts` | 42 |
| `src/lib/local-case/results.server.ts` | 30 |
| `src/lib/analysis/data.server.ts` | 7 |
| `src/lib/components/clock.ts` | 5 |

`bun run --bun surface` prints the full list. The singleton inventory of 17 October (`.orchestration/reports/CODEX-APP-SINGLETON-INVENTORY-20261017/report.md`, outside Git) gives per-file recipes for them.

The graph also reaches these Node built-ins outside the four categories:

| Built-in | Files |
| --- | ---: |
| `node:crypto` | 21 |
| `node:path` | 16 |
| `node:zlib` | 2 |
| `node:async_hooks` | 1 |
| `node:stream/promises` | 1 |
| `node:url` | 1 |

The probe runs only with `nodejs_als`, so GRS-112 must confirm each under `nodejs_compat`. Three packages reach the hosted graph: `@sveltejs/kit`, `svelte` and `typebox` (5 files). `typebox` still needs its Workers check under ADR 0008. `pdfjs-dist` and `@cfworker/json-schema` are not in the graph.

## What stays HOLD

- **The workers.dev smoke deploy on Workers Free.** Cloudflare stays pinned: there is no account and no deploy.
- **The numeric cold and warm staging budgets.** They need real Workers on Workers Paid, and an initial POC workload approved by the architecture aggregator. The probe's local timings (Ready in about 0.7 s, warm GET in about 5 ms in the spike) are not Workers isolate figures and set no budget.
- **Remote D1 and R2.** Only Miniflare-backed local bindings ran, and the D1 statement findings above are local.
- **Follow-ups:**
  - choose the Node line that hosts Wrangler in CI (ADR 0008 says 24 LTS; this host has 26);
  - check the other Node built-ins under `nodejs_compat`.
