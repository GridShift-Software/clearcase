# Deployment proof: cf, Void, the trusted parent and disposable resources, the local legs (GRS-107)

[GRS-107](https://linear.app/vaper/issue/GRS-107) asks for proof of the cf and Void deployment, migration and credential boundaries. Under the local-first plan on GRS-26, this unit runs GRS-102's P1 to P9 offline under `unshare -rn`, with a placeholder account (`00000000000000000000000000000107`) and synthetic data. There is no account, token, login or deploy. Cloudflare stays pinned. P10 and the janitor's real sweep wait for the account owner at moment M1.

**Verdict: PASS for the local legs at `37f892afb9e117f70b7d22477651fc5de36be912`; HOLD for the cloud legs.** All 13 probe legs pass, and so do the 99 tests of the trusted parent, the resource kit, the secrets reader and the scan. The committed run is [evidence/deployment-summary.json](evidence/deployment-summary.json), which names the SHA it ran at. What stays HOLD is listed [at the end](#what-stays-hold).

## Run it

From `tests/hosting-probe/deployment/`, a workspace with its own pins and `bun.lock`. It is not a member of the root workspace.

```sh
bun install --frozen-lockfile   # once, online
bun run --bun test              # 99 tests of deploy/probes/, about 2 s
bun run --bun probe             # about 60 s; writes .local/hosting-probe/deployment/summary.json at the repo root
```

[`probe.ts`](../../../tests/hosting-probe/deployment/probe.ts) refuses to run (exit 2) on a dirty tree, on a Bun other than 1.4.2, when an installed package differs from its pin, or when no real Node is on `PATH`. It re-runs itself inside [`tests/e2e/pilot/offline.sh`](../../../tests/e2e/pilot/offline.sh), which gives it a network namespace with only loopback and hides the host resolver. Every child gets an allowlisted environment: a fresh `HOME`, `CI=1`, and telemetry, error reports, the update banner, the `cf.json` fetch and dotenv loading turned off. A Node preload ([`net-recorder.mjs`](../../../tests/hosting-probe/deployment/net-recorder.mjs)) records every connect and DNS lookup that a Node tool attempts, so a leg can assert "no network" from evidence rather than from the sandbox. The runner exits 0 only when every leg passes, the tree and HEAD are unchanged, and its own summary holds no canary.

Receipts for the run at `37f892af` (ignored, local): `grs-107-probe` (exit 0) and `grs-107-probe-tests` (exit 0) under `.local/agent-receipts/`.

## What runs where

| Step | Host |
| --- | --- |
| Runner, target check, stage, janitor, scan, secrets reader | Bun 1.4.2 |
| Kit 3.1.0 build with adapter-cloudflare 8.0.1 (`bun run --bun build`) | Bun 1.4.2; the build prints its host and the runner asserts it |
| cf 1.0.0-beta.20, Wrangler 4.151.3, Void 1.1.12, Vitest 5.0.5 with @cloudflare/vitest-plugin 1.4.6 | Node 26.10.0 |
| The app | workerd 1.20261019.1 under `wrangler dev --local` |

cf declares `engines: ^22.23.0 || ^24.22.0 || ^26.12.0`. Node 26.10.0 is outside that range, and cf ran anyway because its bin checks only the major version. CI's Node 24.22.0 is inside it.

## Acceptance items

| Item | Verdict | Evidence |
| --- | --- | --- |
| Evaluate the job matrix against fresh versions; a refused or unsupported job gets a measured fallback | PASS (local) | P1 to P9 below; [job matrix](#job-matrix) |
| App builds stay credential-free; a trusted parent applies a checked target manifest to reviewed config and a prebuilt artifact; same-account wrong-client identifiers are refused | PASS (local) | P9; [the trusted parent](#the-trusted-parent); `target.test.ts` |
| Migration grants, bookmarks, failure and rollback; Void's config evaluation and automatic D1 migrations accounted for | PASS for local D1 and Void's source; HOLD for remote grants and Void's remote migration | `migration-failure-rollback`, P4, P6; [Void](#void) |
| No account credentials in shared pools, build artifacts or logs; actual token breadth documented | PASS (local scan); breadth as documented, enforcement HOLD | `credential-scan`; [token breadth](#token-breadth-as-documented) |
| Shared deploy and config writes reserved to one future owner; commands and a fallback per unsupported job | PASS | [one owner](#one-owner-for-shared-deploy-and-config-writes); [job matrix](#job-matrix) |
| P1 to P9 offline with placeholder IDs, and the credential scan | PASS | the legs below |
| `cc-<ticket>-<worker>-<sha7>` naming, run manifest, exit-trap teardown, janitor with one local dry run | PASS | `janitor-dry-run`; `cloud-run.test.ts`; [disposable resources](#disposable-resources) |
| The janitor's real sweep; P10 | HOLD (M1) | [what stays HOLD](#what-stays-hold) |

## Legs

Each leg's commands, hosts, exit codes, network attempts and assertions are in the summary. `net` is what the recorder saw; "loopback" means only local sockets.

| Leg | Verdict | Commands (exit) | Finding |
| --- | --- | --- | --- |
| P1 discovery | PASS | `cf --version` (0), `cf cli search "create D1 database"` (0), `cf schema d1 create` (0) under Node; `cf --version` (0) and `cf deploy --dry-run --no-provision` (0) under Bun | Discovery answers offline with JSON and no network. The documented Bun config-loading failure did not reproduce at beta.20: Bun completed a dry run of a plain project with `cloudflare.config.ts` |
| P2a Kit, no config | PASS | `cf init . --dry-run` (0), `cf build` (1), `cf deploy --dry-run` (1) | `init --dry-run` validates arguments only (`"validated": "arguments only"`) and never reaches automatic setup. Build and deploy refuse with "cf does not support SvelteKit projects yet" and write nothing |
| P2b Kit, hand-written `cloudflare.config.ts` | PASS | `cf build` (1), `cf deploy --dry-run --no-provision` (1) | cf runs the Kit build (adapter 8 writes `_worker.js`), then fails: "Build Output Specification: no root config found at .cloudflare/output/v0/config.json". cf cannot build Kit 3 |
| P3 build and workerd | PASS | `bun run --bun build` (0), `wrangler d1 migrations apply --local` (0), `wrangler dev --local`, `node harness.mjs` (0), `bun harness.mjs` (1) | The Bun build writes `_worker.js`, `.assetsignore` and `cloudflare-tmp/server.js`. `/api/health` answers 200 from workerd with D1 and R2. `createTestHarness` works under Node and exits 1 under Bun |
| P4 local migrations | PASS | `cf d1 migrations apply --local --persist-to X` (0), `wrangler d1 migrations apply --local --persist-to Y` (0), `cf d1 query --local` (1), `cf d1 raw --local` (0), `wrangler d1 execute --local` (0) | Both write the same `d1_migrations` rows. `cf d1 query` has no local form; `cf d1 raw --local` reads it. Wrangler reads cf's `--persist-to` state, and `wrangler dev` on that state serves the schema: one local layout |
| migration failure and rollback | PASS | `wrangler d1 migrations apply --local` (0, then 1, then 1 on retry) | A broken 0003 exits 1, is not recorded, and keeps none of its statements. A retry fails the same way; nothing skips a broken migration. Restoring the bookmark (locally, a copy of the persisted state) returns schema and rows. Remotely the same step is `wrangler d1 time-travel restore` or `void db restore --bookmark`, then a fix-forward migration |
| P5 Vitest pool | PASS | `vitest run` with the Workers pool under Node (0) and under Bun (0) | The bindings test runs in workerd on both hosts |
| P6 Void, native D1 | PASS (measured refusal) | `void info --json` (0), `vite build` with Void's plugin (1), `void deploy --platform cloudflare` (1, attempted `api.cloudflare.com`) | See [Void](#void). Void's build of this app fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME` on `cloudflare:`, so there is no bundle to inspect for Drizzle or Better Auth modules |
| P7 cf dry run, committed config | PASS | `cf deploy --dry-run --no-provision` in a fresh plain project (0) | Loopback only: the sockets are cf's local Miniflare type generator. It writes `.cloudflare/output` and `.cloudflare/types` inside the project, so "no file changes" does not hold; nothing is written outside the project |
| P8 unforced destructive | PASS | `cf d1 delete` with no token (1); `cf d1 delete`, `cf workers delete`, `cf d1 delete --local` with a synthetic token (1 each); `wrangler d1 delete` (1) | With stdin not a terminal, cf prints its prompt, "(non-interactive; pass --force to confirm) Aborted." and exits 1, which settles the docs and release notes on exit 1 at beta.20. With no token cf stops at authentication first. Wrangler asks the API before any prompt, so offline it fails on the request. The aborted local delete left the local database intact |
| P9 wrong client | PASS | `target.ts stage` (0 per client); `cf deploy --dry-run --no-provision` (0) and `wrangler deploy --dry-run` (0) per stage; `cf build` (0), `target.ts prebuilt` (0) and `cf deploy --prebuilt --dry-run --no-provision` (0) per client; `target.ts check` on the swapped configs (1, 1); `target.ts prebuilt` on the swapped Build Output (1) | Each dry run names exactly its own D1, bucket and client var. With client B's D1 id in client A's config or Build Output, the target check refuses and names client B, while the dry runs alone exit 0 and print only the binding's name, `DB=clearcase-client-a-db`. The check is what catches it |
| janitor dry run | PASS | `cloud-run.ts name` (0), `cloud-run.ts janitor` (0), and with no manifests directory (1) | See [disposable resources](#disposable-resources) |
| credential scan | PASS | `scanPaths` over 562 files | No canary or credential shape in the Kit build output, the artifact, every stage and Build Output, the logs and the tool homes. A control file with the canary is found, so the scan is not blind |

## Job matrix

| Job | Preferred tool, measured | Fallback, measured |
| --- | --- | --- |
| Build Kit 3 | cf refuses (P2a) or fails after the Vite build (P2b) | `bun run --bun build` with adapter 8 (P3) |
| Local dev | `wrangler dev --local` on the built `_worker.js` (P3) | none needed |
| Prebuilt upload | cf: a credential-free `cf build` of the staged artifact, then `cf deploy --prebuilt --no-provision` with the token (P9, dry run) | `wrangler deploy` from the stage (P9, dry run). Real upload: P10 |
| Binding selection | the reviewed config, checked against `target.json` before and after `cf build` (P9) | none; a dry run alone does not catch a foreign id |
| Local migrations | cf and Wrangler share one `--persist-to` layout (P4) | `cf d1 raw --local` where `cf d1 query --local` is missing |
| Remote migrations | Void applies them during `void deploy`, after a bookmark (P6, source) | `wrangler d1 migrations apply --remote` after `wrangler d1 time-travel info`; HOLD |
| Rollback | bookmark restore, then fix forward (local) | Worker rollback: HOLD |
| Test pool | @cloudflare/vitest-plugin 1.4.6 on Node and Bun (P5) | none needed |
| Void build | fails with `cloudflare:` imports under Node (P6) | the Bun build and a cf or Wrangler upload |

Neither cf nor Void is adopted for its Platform SDK, ORM or auth. The probe app uses native `env.DB` and hand-written SQL.

## The trusted parent

All clients share one account, so the account is no boundary, and a token that can deploy one client's Worker can deploy another's. The parent is the only process that would hold an upload token. It never evaluates config code.

- [`deploy/probes/clients/<client>/target.json`](../../../deploy/probes/clients/client-a/target.json) is the reviewed manifest: account, Worker, one D1 (binding, name, id), one R2 (binding, bucket), secret names and vars, with `CLEARCASE_CLIENT_ID` equal to the client. `loadTargets` refuses a malformed manifest, a client that does not match its directory, and two clients that share an identifier.
- [`target.ts`](../../../deploy/probes/target.ts) `check` reads `wrangler.jsonc` and `cloudflare.config.ts` as data. A cf config must be `export default <JSON literal>;`; anything else is refused unread. It refuses a missing field, an unknown key or binding type, more than one D1 or R2, a Worker entry or assets directory outside the staged artifact, and any other client's identifier anywhere in the config, naming that client.
- `stage` checks both configs and the artifact's sha256 digest, then copies the configs, the manifest and the artifact into a new directory with a `stage.json` record. `prebuilt` checks the Build Output that `cf build` wrote there, because `cf deploy --prebuilt` uploads those bindings, not the cf config's.
- Mutation tests delete, null and retype every field of the manifest, both configs and the Build Output, and expect a refusal. The only keys the check leaves unread are the compatibility date and flags, `send_metrics`, the assets binding name and the migrations directory. None names a client or the uploaded code.
- The adapter's `_worker.js` imports `../cloudflare-tmp/server.js`, so the artifact is `.svelte-kit/cloudflare`, `.svelte-kit/cloudflare-tmp` and `.svelte-kit/output/server` together. A stage of `cloudflare/` alone fails to bundle.

## Void

- `void.config.ts` is code. The Void CLI evaluates it (`void info`, `void deploy`), and so does the Vite build through Void's plugin. A preload in the probe recorded six evaluations by the Void CLI during `void deploy`, and in each the config read the canary deploy token, because it runs in the process that holds the token. Void scrubs auth variables only from its build child (`scrubWranglerAuthCredentials`), so scrubbing a child's environment does not protect the token from config code. A credentialed Void deploy may run only on a reviewed `void.config.ts` that is data, in a stage the trusted parent built.
- `void deploy --platform cloudflare` inferred a D1 database and, offline, stopped in provisioning: "Cloudflare d1 list failed … refusing to create a possible duplicate". `void info --json` listed no resources.
- Void 1.1.12 applies remote D1 migrations during deploy (`applyAndVerifyRemoteD1Migrations` in `void/dist/deploy-*.mjs`): it lists pending migrations, takes a time-travel bookmark and refuses to migrate without one, applies, then lists again. No flag skips it. A Void deploy is therefore a migration step and needs D1 Edit, not a read-only upload. This was read from source, not run; the remote run is P10.

## Token breadth, as documented

From the Cloudflare token docs read for GRS-102 (create-token, account-owned tokens, R2 tokens and the permissions reference, October 2026):

- Token policies scope to User, Account (one or all) and Zone. R2 adds a Bucket scope.
- The Workers Scripts, D1 and Workers R2 Storage permission groups are account-level. No Worker-level or D1-level resource scope was found, so no resource-scoped Worker or D1 token is claimed here.
- R2 Object Read and Write tokens can be bucket-scoped only for the S3 API, not the REST API.
- A Worker's D1 and R2 bindings need no token. Account-owned tokens (`cfat_`) list Workers, D1 and R2 as compatible.

A token able to upload one client's Worker can upload any client's Worker in the account. The target check is a config check, not token scoping. The real grants, a denied action and the minimum upload set are P10.

## Disposable resources

[`cloud-run.ts`](../../../deploy/probes/cloud-run.ts):

- Names are `cc-<ticket>-<worker>-<sha7>` (`cc-107-w1-37f892a` for this run), lowercase, validated.
- `openRun` writes `.local/cloud-runs/<name>.json` before anything is created, and refuses a name that already has a manifest. Each create is recorded first.
- An exit trap tears down exactly what the manifest lists, Worker first so nothing writes to the database or bucket while they go, then D1, then R2, on normal exit, a throw, SIGINT, SIGTERM and SIGHUP. Each result, a failed delete included, is recorded, and the manifest ends `finished`.
- The janitor deletes only resources that have a run name and a run kind, are older than 24 hours, and whose manifest is finished or absent. It keeps unprefixed names, malformed `cc-` names, unreadable times, younger resources and open or unreadable manifests, and it refuses to plan without its manifests directory. The probe's dry run against a fake listing planned 2 deletions, kept 4 and deleted nothing.

## Secrets reader

[`secrets.ts`](../../../deploy/probes/secrets.ts), for GRS-108 and later:

```sh
bun deploy/probes/secrets.ts run <name> [--keys K1,K2] [--to fd|env] -- <command> [args...]
```

- It reads `$HOME/.config/clearcase/secrets/<name>.env` only. It refuses a directory that is not a real directory the caller owns with mode 700 or stricter, and a file that is not a regular file the caller owns with mode 600 or stricter, symlinks included. It also refuses a bad name, a malformed or repeated line, a missing selected key, and an option without its value.
- It never prints a value. Refusals name a path, mode, key or line number and exit 2, and no child starts.
- The values go to exactly one child over a pipe on fd 3. With `--to fd` the child reads them with `takeSecrets()` from [`secrets-child.mjs`](../../../deploy/probes/secrets-child.mjs). With `--to env`, for a Node tool that reads `process.env`, a preload serves them by name without making them enumerable. Grandchildren started through `spawn`, `execFile`, a spread copy, `Object.assign` or `sh -c` received none, which the tests prove with a synthetic secrets directory under `.local/`. A tool that names a key and passes it on by hand still can.

## Credential scan

[`scan.ts`](../../../deploy/probes/scan.ts) looks for the run's canaries and for credential shapes: token variables, `cfat_` prefixes (`cfut_` and `cfk_` too, unverified), bearer and `X-Auth-Key` headers, Clerk secret keys, private keys with key material, and OAuth state. A hit names the file and rule, never the text. It skips installed packages and symlinks, and reads binaries as latin1.

## One owner for shared deploy and config writes

One future owner: GRS-114 (client provisioning), whose reservation already holds `deploy/client/**` with a serialized manifest handoff. It takes `deploy/probes/clients/` as `deploy/client/<client>/`, with the target manifest and the generated cf, Wrangler and Void configs, and it takes the trusted parent's `check`, `stage` and `prebuilt`. No other ticket writes those configs, the deploy scripts, or the repository's ignore rules for `.cloudflare/`, `.wrangler/` and `.void/`; they ask that owner for a handoff. Until GRS-114 starts, `deploy/probes/` stays reserved to GRS-107 and its fix rounds.

## What stays HOLD

For the account owner, at M1 on Workers Free, through the run manifest and its teardown:

- **P10.** A real prebuilt upload with an upload-only token; the enforced grants and a denied action; a Void deploy with pending D1 migrations behind a time-travel bookmark; a Worker rollback; teardown of the `cc-*` resources.
- **The janitor's real sweep** of the account's `cc-*` resources.
- **Actual token breadth on the real API.** Only the documented scopes above are claimed.

Follow-ups:

- the cf config in this probe names no static assets; cf takes them as a build `assetsDirectory`, which the target check must then pin to the staged artifact;
- choose CI's Node within cf's engines range;
- Void's build of a Kit app that imports `cloudflare:` fails under Node;
- Wrangler still tries `registry.npmjs.org` on some error paths with the banner hidden (seen on `wrangler d1 delete`).
