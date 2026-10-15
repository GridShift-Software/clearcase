# GRS-102: cf and Void for the alpha agent tooling jobs

Addendum to [GRS-102](https://linear.app/vaper/issue/GRS-102). It adds to GRS-100 (`docs/research/grs-100-hosted-software-audit.md` at `5e1ceae`, Void subsection) and GRS-101 (`docs/research/grs-101-local-agent-test-platform.md` at `2f810e9`, local Workers capabilities) and repeats neither. Base `b93bad097fdd`. Sources were read on 15 October 2026. Labels: **[F]** documented fact; **[S]** read in published package source, not executed; **[I]** inference; **[R]** recommendation; **[U]** unknown; **UNSUPPORTED** means a first-party source says the tool cannot do it, or a search of its docs found nothing.

Nothing was installed, executed (no `npx` or `bunx`), migrated, logged in, provisioned or deployed. Three tarballs were downloaded to a scratch directory and read as text. No item below is a runtime PASS; every proof in [Proof matrix](#proof-matrix-all-unrun) is unrun.

## Verdict

1. **cf is the first choice for discovery, account and resource tasks, dry runs, version uploads and traffic splits [F][R].** Use it only in a supported Node process. It runs next to an unmigrated Wrangler project without changing it [C1][C6].
2. **The released cf build refuses SvelteKit, so it cannot dev, build or deploy SvelteKit 3 yet [S].** In beta.17's framework table, SvelteKit has `supportsCf: false` and `maximumKnownMajorVersion: 2`. Automatic configuration then throws "cf does not support SvelteKit projects yet. You can still use Wrangler to develop and deploy this project." [C13]. adapter-cloudflare 8.0.1 itself imports `getPlatformProxy` and `unstable_readConfig` from `wrangler` [C13]. A Kit 3 app therefore keeps a Wrangler config file under any tool. Whether a hand-written `cloudflare.config.ts` gets past the refusal is **[U]** (P2).
3. **Void supports Kit 3 with adapter 8 [F][V1].** It does this through a generated `.void-wrangler.jsonc` and, for direct-Cloudflare deploys, by calling cf's own `bin/cf` [S][C13]. It therefore inherits cf's beta behaviour and Node requirement. It has no dry run (UNSUPPORTED), and its database commands assume Drizzle (below).
4. **Wrangler 4.151.0 stays the fallback** for SvelteKit dev, build and deploy, built-Worker local runs, live logs, single-secret writes and `rollback`. The Workers Vitest integration and `createTestHarness` both depend on Wrangler and its config file [W1][W2][W5].
5. **Treat the cf beta as moving [F].** Eighteen betas (beta.0 to beta.17) shipped between 25 September and 14 October 2026 [C12]. beta.15 and beta.16 broke behaviour: destructive exit codes changed, and 42 commands were renamed [C11]. Pin exact versions and re-read the release notes before each bump [R].

## Release state, runtimes, licences

- **cf** `1.0.0-beta.17` (npm `latest`, published 14 October 2026) is tagged `cf@1.0.0-beta.17` at commit `a3c9939a5b41` [C11][C12]. Main was 7 commits ahead at `00b7d2a8c593` on 15 October. The only unreleased changeset bumps `@cloudflare/containers-shared` 0.22.0 and `@cloudflare/deploy-helpers` 0.20.4; the other commits are Renovate and Forge plumbing. No unreleased user-facing feature was found [C11].
  - Package name: npm versions 0.0.1 to 0.0.3 of `cf` (2013) are an unrelated config loader, so pin `cf` to an exact `1.0.0-beta.N` and never to a loose range [C12][R].
  - Licence: npm declares `MIT OR Apache-2.0` and the tarball ships both licence files. GitHub's detector reports Apache-2.0 [C11][C12].
  - Runtime: the bin uses `#!/usr/bin/env node` and exits below Node major 22. `engines.node` is `>=22` [C13]. The docs require Node 22.18 or later: "Bun is not supported. When `cf` runs on Bun, commands that load `cloudflare.config.ts` fail", and most commands load it [C2][C5].
  - Engine: depends on `miniflare` 5.20261012.0-beta, which pins `workerd` 1.20261012.1 (Apache-2.0) [C12].
- **cf delegates and does not bundle [F][C4].** `cf dev` and `cf build` run the framework command, the Cloudflare Vite plugin 2.0 beta (`2.0.0-beta.v.0`, published 15 October 2026, no Wrangler dependency), or Wrangler 4.136.0 or later. cf does not run `package.json` scripts.
- **Void** `1.1.11` (MIT, published 15 October 2026) declares `engines.node >=24.21.0` [C12].
  - It depends on `cf ^1.0.0-beta.17`, a caret range on a prerelease, so a fresh install can resolve a later beta [I].
  - It depends on `@cloudflare/vite-plugin ^1.64.0`, and vite-plugin 1.64.0 pins `wrangler` 4.151.0, so Void installs Wrangler as well.
  - It also depends on `drizzle-orm`, `drizzle-kit`, `better-auth`, `pg` and `mysql2` [C12].
- **Wrangler 4.151.0** is `MIT OR Apache-2.0`, needs Node 22 or later, and uses the same miniflare and workerd pins [C12]. The blog post promises Wrangler maintenance "for 18 months after the beta ends" [C10].
- **The three host roles are separate [R]:**
  - Bun 1.4.2 can install these packages (`bun add` forms are documented), and it keeps app dev, build and the existing tests [C2].
  - A supported Node process hosts cf, Void, Wrangler, `createTestHarness` and the Vitest plugin. cf docs explicitly say this, and the others declare Node `engines`.
  - Worker code runs in workerd, whichever host starts it.
  - Each receipt names its host. vitest-plugin 1.4.3's source refuses `cloudflare.config.ts` loading under Bun ("Please use Node.js v22.18.0 or higher") [C13].

## Job matrix

| Job | Void or cf first (status) | Fallback, exact |
| --- | --- | --- |
| Command discovery and schema | cf: `cf cli search "<task>"` (local, no credentials, up to 5 JSON matches), `cf schema <cmd>` (JSON request shape, generated commands only), `cf docs search`, `--help` [F][C3][C11]. The manifest lists 3,004 commands [S]. Void: bundled docs at `node_modules/void/docs` and two skills, no search or schema [F][V5] | `wrangler <cmd> --help` |
| JSON output and exit codes | cf: results as JSON on stdout, messages on stderr; `--version` is parseable since beta.13 [F]. Docs say an unforced destructive command exits 0 with `Aborted.`; the beta.15 notes say exit 1. Conflict, **[U]** (P8). Void: `--json` on platform commands and `void info` only; deploy writes a JSONL log to `~/.void/logs/` [F][V3] | Wrangler: `--json` on some commands [C6] |
| Log inspection | cf: live logs UNSUPPORTED [C6]. Local: the Local Explorer API, printed by `cf dev` inside supported agents, queries local traces and logs [C3][W4]. Void: `void project logs` is a live tail on Cloudflare targets, with no history [V3] | `npx wrangler tail <WORKER_NAME> --format json` [W1] (run under Node) |
| Kit 3 dev | cf: UNSUPPORTED for SvelteKit (verdict 2). Void: `voidPlugin()` beside `sveltekit()` with adapter 8 `platformProxy` [V1]. This is Vite SSR with proxied bindings, not workerd evidence [I] | `vite dev` (Bun-hosted app script) with adapter 8 `platformProxy` |
| Kit 3 build | cf: **[U]** with a hand-written config; refused by automatic configuration [S]. Void: `vite build` with the generated `.void-wrangler.jsonc` [V1] | `vite build` with adapter 8, which outputs `.svelte-kit/cloudflare/_worker.js` |
| Built Worker in local workerd | cf: `cf workers check` reports local bundle size and startup time only [C4]; no prebuilt-serve command [U]. Void: none documented [U] | `wrangler dev` on the built `_worker.js` (GRS-101), or `createTestHarness({ workers: [{ configPath }] })` from `wrangler`, which "runs production build output" in a Node test runner [W2] |
| Local D1 migrations, seed and reset | cf: `cf d1 migrations apply <DATABASE_ID> --local --persist-to <DIR>` and `cf d1 raw <DATABASE_ID> --sql ... --local`. Wire-compatible with Wrangler's `d1_migrations` table [S][C4]. cf's `--local` state (`~/.config/cloudflare/state/v3` by default, shared by every project) is **not** the dev server's `.cloudflare/state/` [C4]. `cf dev --persist-to` is rejected [C11]. Void: `void db migrate`, `reset`, `seed` and `execute` [V4], but `generate` and deploy-time drift checks need a Drizzle schema, and keeping hand-written SQL needs Drizzle `meta/` files [V4] | `wrangler d1 migrations apply <DB> --local --persist-to <DIR>`; reset by deleting the persist directory [W1] |
| Local R2 seed | cf: `cf r2 objects put <object-key> --bucket-name <B> --file <PATH> --local` [S][C4]. Void: no CLI found [U] | `wrangler r2 object put <B>/<K> --file=<PATH> --local` (GRS-101) |
| Workers Vitest integration | Neither tool. cf only names the Vitest plugin [C10] | `@cloudflare/vitest-plugin` 1.4.3 with `wrangler.configPath`, `reset()` and `applyD1Migrations()` (GRS-101). A `cloudflare.config.ts` loader exists in its source but is undocumented [S][U] |
| Per-client config and credentials | cf: [per-client boundary](#per-client-boundary). Void: "Named environments need separate Void project configs"; resource IDs are kept in `void.lock.json` [V2] | Wrangler `--env` blocks or one config file per client |
| Dry run, no provision | cf: `--dry-run` on every command; `cf deploy --dry-run` builds and validates without API requests [C4]. `cf deploy --no-provision` makes bindings without IDs fail instead of creating resources [C11]. `cf d1 migrations apply --dry-run` only "show[s] the command" [S]. `cf previews deploy` has no dry run [C4]. Void: no dry run anywhere in the 1.1.11 docs (UNSUPPORTED). Deploy provisions by default; no opt-out found [V3] | `wrangler deploy --dry-run --outdir <DIR>`; `wrangler versions upload --dry-run` [W1] |
| Resource creation | cf: `cf d1 create --name`, `cf r2 buckets create`; deploy provisions missing resources but "does not write provisioned identifiers back" [C4]. Void: infers and provisions, and a failed build can leave resources behind [V2] | `wrangler d1 create`, `wrangler r2 bucket create` |
| Candidate, readiness, traffic | cf: `cf workers versions create --prebuilt --mode <M> --preview-alias <A>`, then `cf workers deployments create --worker <W> --strategy percentage --versions '<JSON>'` [C4]. No readiness gate built in [U]. Void: uploads, checks readiness, then shifts traffic and restores the previous deployment on failure [V2]. The check needs `/__void/ready` or version metadata, which conflicts with a fail-closed Clerk hook (GRS-100) | `wrangler versions upload --preview-alias`, then `wrangler versions deploy <id>@<pct>` [W1] |
| Rollback and DB migrations | cf: no Workers rollback command in the docs or manifest. A `deployments create` back to an earlier version is the API path [I]. `cf d1 time-travel restore` is remote and overwrites data [S]. Void: `void project rollback [version]`; "Rollback does not reverse database migrations" [V2]. Wrangler: `wrangler rollback [<VERSION_ID>] --message`, limited to the 100 latest versions, and blocked when bound resources changed [W1][W3] | Every path treats D1 migrations as forward-only: expand, then contract, with a time-travel bookmark recorded first [R] |

## Per-client boundary

- **cf credentials [F][C2].** The precedence order is:
  1. `CLOUDFLARE_API_TOKEN`, which can be read from `.env` in the current directory;
  2. `--profile`;
  3. a directory-bound profile (`cf auth activate <name> [dir]`);
  4. the default profile.

  `--local` commands do not read `.env`, and cf never reuses a Wrangler login.
- **cf account selection [F][C2].** The order is `CLOUDFLARE_ACCOUNT_ID`, then `accountId` in `cloudflare.config.ts`, then a cache in `node_modules/.cache/cloudflare/`. A non-interactive run with several accounts fails.
- **One account means the account is no boundary [I].** Isolation rests on separate Worker names, resource IDs, secrets and least-privilege tokens. Whether a token can be scoped to one client's Worker, D1 and R2 is **[U]** and needs a Cloudflare token-permissions read.
- **cf modes [F][C4].** A function-form config "deploys a separate Worker only when it returns a different `name`", and prebuilt output must be deployed with the mode it recorded. One directory per client, with an exact `accountId` and `--no-provision`, avoids an accidental shared or new resource [R].
- **Repository hygiene [R].** The repo `.gitignore` covers `.env*`. It does not cover `.cloudflare/`, `.wrangler/` or `.void/`, and cf does not add `.cloudflare/` [C9]. Agents run with `DO_NOT_TRACK=1` and `CLOUDFLARE_DEPENDENCIES_INSTRUMENTATION=false`, because cf records search queries in telemetry and uploads dependency metadata by default [C8][C11].

## Local simulation versus remote work, cost and self-hosting

- **Local [F]** means `--local` cf commands, the cf, Wrangler or Vite dev servers, Miniflare and workerd. No credentials, API calls or cost are involved [C3][C4].
- **Remote [F]** means every other cf resource command, `deploy`, `previews deploy`, Void `--remote` and Void's `remote` bindings, which write real data (GRS-101). Workers Free quotas apply. cf and Wrangler themselves cost nothing [I].
- **Void's self-hosted platform [F]** needs Workers for Platforms, which "requires a paid plan", plus PostgreSQL and a login provider [V6]. It conflicts with the no-purchase direction and stays out of the alpha [R].
- **Agent hazard [F].** `void db execute --remote` skips its destructive-statement prompt when not on a TTY [V4]. A non-interactive agent could change deployed data without confirmation. Keep it off agent allowlists [R].

## Proof matrix (all unrun)

All proofs use synthetic data, a scratch worktree, exact pins and a receipt naming the host runtime. Run P1 to P9 offline with `unshare -rn` and no credentials. P10 needs user authorization.

| # | Proof | Pass condition |
| --- | --- | --- |
| P1 | `cf --version`, `cf cli search "create D1 database"` and `cf schema d1 create`, under Node 22.18+ and under Bun | JSON on stdout under Node; the documented config-loading failure under Bun inside a project |
| P2 | Kit 3.1.0 + adapter 8.0.1 app: `cf init . --dry-run`, then a hand-written `cloudflare.config.ts` and `cf build` | The refusal is recorded; then a build succeeds or fails with its message; `git status` shows every change |
| P3 | `bun run --bun build`, then `wrangler dev` on the built `_worker.js` with `--persist-to`, plus one `createTestHarness` test | `/api/health` answers from workerd; the harness test passes under Node |
| P4 | Apply the same synthetic migrations with cf `--local --persist-to X` and with Wrangler `--local --persist-to X` | The same `d1_migrations` rows; check whether either dev server can read X **[U]** |
| P5 | vitest-plugin 1.4.3 with vitest 5 (GRS-101 step 1), on Node and on `bun run --bun test` | The supported host is recorded |
| P6 | Void 1.1.11 Kit 3 app: `vite build` and a Worker bundle inspection, with no deploy | List of Drizzle or Better Auth modules in the bundle; Node 24.21+ requirement confirmed |
| P7 | `cf deploy --dry-run --no-provision` in a project with a committed config, offline | No network attempts, no file changes, exit 0 |
| P8 | An unforced destructive command, non-interactive, with a dummy account ID and offline | Exit code recorded (0 or 1); docs and release notes reconciled |
| P9 | Two client directories with distinct `accountId`, names and mode, run with `cf deploy --dry-run` | Each output names only its own Worker and bindings |
| P10 | Remote, on a throwaway Worker in the owned account: version upload, readiness on its version URL, 100% traffic, rollback; a D1 bookmark then a forward migration | Traffic and rollback behave as documented; DB stays forward-only. **Needs approval** |

## Questions for the user

1. While cf refuses SvelteKit, is it acceptable for Wrangler to run Kit 3 dev, build and deploy, with cf for discovery, resources, versions and traffic? The alternative is to wait for a cf release with `supportsCf: true` for SvelteKit.
2. Should Void be trialled only through P6? Its database tooling assumes Drizzle and it has no dry run, so Void's deploy should not run for client Workers unless chosen explicitly.
3. Which Node line should the helper host pin? cf needs 22.18 or later and Void needs 24.21 or later.
4. Per-client layout: one directory and config per client (recommended), or one config with modes?
5. Do you authorize P10 on a throwaway synthetic Worker in the owned account, on the Free plan?

## Sources (read 15 October 2026)

- [C1] https://developers.cloudflare.com/cf/ · [C2] https://developers.cloudflare.com/cf/get-started/ · [C3] https://developers.cloudflare.com/cf/agents/ · [C4] https://developers.cloudflare.com/cf/projects/ · [C5] https://developers.cloudflare.com/cf/projects/cloudflare-config/ · index https://developers.cloudflare.com/cf/llms.txt
- [C6] https://developers.cloudflare.com/cf/wrangler/ and https://developers.cloudflare.com/cf/wrangler/reference/ · [C8] https://developers.cloudflare.com/cf/ci/ and https://developers.cloudflare.com/cf/environment-variables/ · [C9] https://developers.cloudflare.com/cf/get-started/first-worker/
- [C10] https://blog.cloudflare.com/cloudflare-cf-cli-launch/ (28 September 2026)
- [C11] https://github.com/cloudflare/cf/releases (beta.13 to beta.17 notes) and https://github.com/cloudflare/cf/compare/cf@1.0.0-beta.17...main
- [C12] npm manifests: https://registry.npmjs.org/cf/1.0.0-beta.17 · https://registry.npmjs.org/void/1.1.11 · https://registry.npmjs.org/wrangler/4.151.0 · https://registry.npmjs.org/miniflare/5.20261012.0-beta · https://registry.npmjs.org/workerd/1.20261012.1 · https://registry.npmjs.org/@cloudflare%2fvite-plugin/1.64.0 · https://registry.npmjs.org/@cloudflare%2fvite-plugin/2.0.0-beta.v.0 · https://registry.npmjs.org/@cloudflare%2fvitest-plugin/1.4.3 · https://registry.npmjs.org/@sveltejs%2fadapter-cloudflare/8.0.1 · https://registry.npmjs.org/@sveltejs%2fkit (dist-tags)
- [C13] Tarballs read as text, not executed:
  - `cf-1.0.0-beta.17.tgz`: `bin/cf`, `dist/autoconfig-*.mjs`, `dist/dev-*.mjs`, `dist/_meta/commands.json`. The integrity matches the registry.
  - `adapter-cloudflare-8.0.1.tgz`: `index.js`.
  - `vitest-plugin-1.4.3.tgz`: `dist/pool/index.mjs`.
  - `void-1.1.11.tgz`: `dist/deploy-*.mjs`, `dist/cli/cloudflare-operation-process.mjs`, `docs/`.
- [W1] https://developers.cloudflare.com/workers/wrangler/commands/workers/ and https://developers.cloudflare.com/workers/wrangler/commands/d1/ · [W2] https://developers.cloudflare.com/workers/testing/ and https://developers.cloudflare.com/workers/testing/test-harness/prepare-test-state/ · [W3] https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/ · [W4] https://developers.cloudflare.com/workers/local-development/local-explorer/ · [W5] https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/
- [V1] https://void.cloud/integrations/frameworks/sveltekit · [V2] https://void.cloud/integrations/cloudflare · [V3] https://void.cloud/reference/cli/deploy and https://void.cloud/guide/deployment · [V4] https://void.cloud/reference/cli/database and https://void.cloud/guide/database · [V5] https://void.cloud/integrations/agents · [V6] https://void.cloud/guide/platform/installation/prerequisites. Void pages were read from the docs shipped in `void-1.1.11.tgz`, and the live URLs returned HTTP 200.
