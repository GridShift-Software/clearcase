# GRS-100: Hosted software audit (dependencies, Clerk on SvelteKit and Workers, Void, pstack discovery)

Decision support for [GRS-100](https://linear.app/vaper/issue/GRS-100). It blocks the GRS-86 stack decision. App base `b93bad097fdd7b3c076d68025267c36395fc9921`, branch `research/grs-100-hosted-software-audit`. Sources were read on 15 October 2026. Labels: **[F]** fact from the cited source or the repository, **[I]** inference, **[R]** recommendation, not yet tested.

This is a planning audit. It is not a security certification, a full transitive CVE clearance or hosted evidence. Nothing was installed, relocked, upgraded, deployed or provisioned, and no app code changed. It makes no runtime PASS claim, and no app probe has run: every probe named here is unrun. The inputs are GRS-95 (`docs/research/grs-95-d1-r2-alpha-workload.md` on branch `research/grs-95-d1-r2-storage`: D1 and R2 layout, integrity) and GRS-96 (`docs/research/grs-96-file-viewer-feasibility.md` on branch `research/grs-96-file-viewer-feasibility`: viewers). This note does not retest them.

## Verdict

1. **The current pins are the inventory and research reference, not approval to ship known unresolved security issues.** Patch bumps (vitest 5.0.5, typebox 1.3.37) go in later reviewed commits. Bun stays at 1.4.2 until a reviewed upgrade. Three Kit advisories are fixed only in 3.0.0. Before any client-serving release, each must be closed by a patched supported release (Kit 3 is the migration candidate and the next ticket; no deferral is approved beyond the alpha) or by a verified inapplicability or mitigation recorded in the release checks. The [source recheck](#kit-advisory-applicability-source-read-no-probes-run) finds the preconditions absent at this revision, but no app probe has run. The only Svelte Clerk SDK does not yet support Kit 3. Kit 3 is not chosen here. [R]
2. **There is no first-party Clerk SDK for Svelte or SvelteKit.** The lowest-risk path is the official `@clerk/backend` `authenticateRequest()` in a SvelteKit `handle` hook, plus official Clerk browser code (ClerkJS or the hosted Account Portal). `svelte-clerk` stays an optional convenience, not a foundation. [F]/[R]
3. **Clerk identity data is in the US, whatever region the case stores use.** Clerk offers no region selection. Treat this as a fact separate from the Cloudflare case-store choice (South Africa preferred, EU acceptable), and keep case data out of Clerk. [F]
4. **Clerk membership never grants case access.** Case authority is an app-side grant per client instance, and the hook fails closed. [R]
5. **Void (announced on 15 October 2026): provisional recommendation not to adopt now, not a closed decision.** In framework mode it adds little for SvelteKit and Clerk. Which of its dependencies reach a Worker bundle is unproven, and its Bun CLI support is unproven. The user is researching the local agent test platform (101, separate worker), so the candidate stays open for the user. See [Void](#void-candidate-bounded-comparison). [R]
6. **The doctor's pstack lookup is out of date.** It fails at the legacy path, and it fails against the user's canonical t3-pstack r7 path too. [Discovery](#pstack-discovery-mismatch) proposes a small later fix with no reinstall. [F]/[R]

## Inventory: what actually runs where

Sources: `package.json`, `bun.lock` and an import scan of `src`, `scripts`, `tests` and the config files at the base revision. [F]

| Package or module (pin) | Declared | Where it runs | Evidence |
| --- | --- | --- | --- |
| `svelte` 5.57.2 | devDependency | Browser and server runtime (bundled) | 45 imports in `src` |
| `@sveltejs/kit` 2.70.3 | devDependency | Browser router and server runtime (bundled), build | 51 imports in `src`, `vite.config.ts` |
| `cookie` 0.7.2 (override) | `overrides` | Server runtime, inside Kit's `cookies` | Kit 2.70.3 declares `cookie ^0.6.0`. Commit `c148e93` pins the patched release for [GHSA-pxg6-pf52-xh8x](https://github.com/advisories/GHSA-pxg6-pf52-xh8x) (fixed in 0.7.0) |
| `typebox` 1.3.36 | dependency | Server: package validate and read (`Value.Check`, `Value.Errors`) and the local converter | `src/lib/case-package/*`. Browser code imports only `browser.ts` and `refs.ts`, which import nothing |
| `pdfjs-dist` 6.4.299 | devDependency | **Browser**: copied by `scripts/pilot/copy-pdfjs.ts` to `build/pdfjs` and served on the originals site. Also scripts and tests (legacy build) | `src/lib/local-case/viewer/viewer.mjs` |
| `@sveltejs/adapter-node` 5.5.7 | devDependency | Local server output (`build/handler.js`) for `scripts/pilot/start.ts` | `svelte.config.js` |
| `vite` 8.3.4, `@sveltejs/vite-plugin-svelte` 7.3.1 | devDependency | Build | config files |
| `typescript` 6.0.3, `svelte-check` 4.7.6, `@types/node` 26.6.4 | devDependency | `check` only | `package.json` scripts |
| `vitest` 5.0.3 | devDependency | Tests | 135 imports |
| `@cfworker/json-schema` 4.1.1 | devDependency | Local scripts only (schema check). Last npm release January 2025 | `scripts/case-package/*` |
| `node:sqlite`, `node:fs`, `node:child_process`, `node:net`, `node:http` | built-in | **Local operator server only**: `db.server.ts` (`DatabaseSync`), `local-case/*.server.ts`, `case-package/{originals,zip,writer}.ts`, backup and rescan | import scan |
| `bun:sqlite` (tests), `bun:ffi` (`scripts/pidfile.ts`) | Bun built-in | Tests and local tooling | import scan |
| Vendored: `static/fonts` (Schibsted Grotesk, Instrument Serif) | files | Browser | `static/fonts/LICENSE.txt`: SIL OFL 1.1. No other vendored third-party code; `viewer.mjs` is first-party |

Inferences [I]:
- Kit's server runtime also pulls in `devalue` and `set-cookie-parser`, and `sirv` and `mrmime` (adapter-node static files). Being devDependencies does not stop these being bundled into the runtime.
- `bun audit` 1.4.2 checked 154 packages and found no vulnerabilities [F]. It misses the three Kit advisories below, which are not in GitHub's global advisory database yet (HTTP 404 on 15 October 2026). A clean `bun audit` is therefore not evidence that an advisory is inapplicable.

**Guard the incompatible modules, not every `node:*` import.** Cloudflare lists `node:fs`, `node:net` and `node:http` as supported, and `node:sqlite` and `node:child_process` as non-functional stubs that can be imported but "are not suitable for direct use in application code" [F][S7]. `node:fs` is a virtual file system: `/bundle` is read-only, `/tmp` is writable but "not persistent and unique to each request", operations are synchronous, and temp files count toward the memory limit [F][S24]. It is not a durable case filesystem [I]. The local case code depends on a persistent disk, on `node:sqlite` and on child processes, so `$lib/local-case/*.server.ts` and the originals, backup and rescan modules must stay out of hosted routes. The hosted adapter needs a separate server entry, and a build-time import guard should block those modules and any persistence-dependent `node:fs` use (a probe, below). [R]

## Runtime-critical dependencies: pin, candidate, recommendation

| Dependency | Pin | Stable now | Peer compatibility | Recommendation |
| --- | --- | --- | --- | --- |
| `@sveltejs/kit` | 2.70.3 (latest 2.x) | 3.1.0 [S1] | Kit 3 needs Vite ^8.0.12, Svelte ^5.57.1, TS ^6, vite-plugin-svelte ^7 and Node ≥22.17. The current pins satisfy all of these [F] | **Reference pin for the alpha inventory; Kit 3 is the next migration ticket (open decision).** [GHSA-prjg-x2qj-wj3g](https://github.com/sveltejs/kit/security/advisories/GHSA-prjg-x2qj-wj3g) (SSRF in self-fetch fallbacks, moderate), [GHSA-pfhg-q3qv-9q6r](https://github.com/sveltejs/kit/security/advisories/GHSA-pfhg-q3qv-9q6r) (open redirect with `use:enhance`) and [GHSA-27mw-82g8-phjj](https://github.com/sveltejs/kit/security/advisories/GHSA-27mw-82g8-phjj) (prerender XSS) are patched only in 3.0.0 [F]. See [applicability](#kit-advisory-applicability-source-read-no-probes-run). Kit 3 removes `svelte.config.js`, renames `$lib` to `#lib`, replaces `$env` and changes adapter-cloudflare to `cloudflare:workers` [S2], so it is real migration work, not a bump |
| `svelte` | 5.57.2 | 5.57.2 | n/a | Retain |
| `vite` / `vite-plugin-svelte` | 8.3.4 / 7.3.1 | same | Kit 2 and 3 accept both | Retain |
| `typescript` | 6.0.3 | 7.0.2 | `svelte-check` 4.7.6 peers `^5 \|\| ^6`, and Kit 3 peers `^6` [F] | **Retain 6.0.3; do not move to 7** |
| `vitest` | 5.0.3 | 5.0.5 | Vite ^8 accepted | Patch upgrade in a reviewed commit. Local Workers-runtime tests: use `@cloudflare/vitest-plugin`, not the old pool. See [local Workers tests](#local-workers-runtime-tests). Local tests do not replace hosted acceptance |
| `typebox` | 1.3.36 | 1.3.37 | n/a | Patch upgrade later. Before hosted use, prove `Value.Check` and `Value.Errors` under workerd: Workers forbid `eval` and `new Function` [S8], and TypeBox advertises a JIT compiler [S9] |
| `pdfjs-dist` | 6.4.299 | 6.4.299 | n/a | Retain. [GHSA-hq66-cqwq-w95j](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j) is patched in 6.2.108; the pin is past it [F]. Serving from R2 follows GRS-96 |
| `cookie` override | 0.7.2 | 2.0.1 | Kit 3 depends on `cookie ^2.0.1` [F] | Retain on Kit 2; **remove it in the Kit 3 commit**, or it forces 0.7.2 against `^2` |
| `@sveltejs/adapter-node` | 5.5.7 | 6.0.0 | 6.x needs Kit ^3 [F] | Retain for local. The hosted target needs `adapter-cloudflare` 7.2.9 (Kit ^2, wrangler ^4) or 8.0.1 (Kit ^3, wrangler ^4.118). Neither is adopted here |
| `@cfworker/json-schema` | 4.1.1 | 4.1.1 | n/a | Retain, scripts only. Low release activity; not runtime |
| Bun | 1.4.2 (`packageManager`) | 1.4.3, released October 2026 [S10] | n/a | Upgrade later with `bun upgrade --stable` and a reviewed `packageManager` commit. **Bun is dev and build only.** The hosted runtime is workerd, so Bun evidence is not hosted evidence |

Licenses [F, npm registry `license` field, read 15 October 2026; no matrix exists in the repo]: MIT for `@sveltejs/kit`, `svelte`, `vite`, `typebox`, `cookie`, `@sveltejs/adapter-node`, `@clerk/backend`, `svelte-clerk`, `@cloudflare/vitest-plugin`, and Kit's runtime `devalue`, `set-cookie-parser`, `sirv`, `mrmime`. Apache-2.0 for `pdfjs-dist` (shipped to browsers). Fonts are SIL OFL 1.1. This is a registry-field check, not a legal review or a transitive clearance. [Void](#void-candidate-bounded-comparison) and `@clerk/clerk-js` licences were read the same way (MIT).

### Kit advisory applicability (source read, no probes run)

Sources: the three GitHub advisories linked above and `src`, `svelte.config.js`, `scripts/pilot/start.ts` at `77d5a49` [F].
- **GHSA-prjg (SSRF, below 3.0.0):** needs an attacker-influenced request origin and one of Kit's server self-fetch fallbacks (prerendered data, rerouted prerendered content, unresolved same-origin subrequests, error pages). The advisory's workarounds are `paths.origin` for adapter-node, and a trusted proxy that validates `Host`. The repo has no prerendering and no `handleFetch`. Local `scripts/pilot/start.ts` sets `ORIGIN`. The hosted adapter-cloudflare path is **not assessed**: whether it uses these fallbacks and who controls `Host` there are open. Must be a release check. [I]
- **GHSA-pfhg (open redirect):** needs `use:enhance` on a route that accepts a `//`-prefixed path, such as a catch-all. The repo uses `use:enhance` 18 times in 12 files but has no rest-parameter routes. Its workaround (reject a pathname starting `//` in `handle`) is cheap. Not shown inapplicable until the hosted route table is checked. [I]
- **GHSA-27mw (prerender XSS):** needs prerendered pages plus `setHeaders` from untrusted `cache-control`. The repo has neither. [I]
- None of this was run against the app. "Inapplicable" needs a recorded probe or a patched release before the release checks pass.

### Local Workers runtime tests

- Cloudflare's current page recommends the Workers Vitest integration, `@cloudflare/vitest-plugin`: "Runs tests fully-locally using Miniflare" with "isolated per-test-file storage", direct access to Workers APIs and bindings [F][S25]. `@cloudflare/vitest-pool-workers` is the same package under its old name: npm marks 0.23.0 (published 7 October 2026) deprecated, "renamed to `@cloudflare/vitest-plugin`" [F, npm].
- Registry now [F, npm]: `@cloudflare/vitest-plugin` 1.4.3 (MIT, published 15 October 2026) peers `vitest ^4.1.0 || ^5.0.0`. Versions 1.0.0 to 1.3.x peered `^4.1.0` only; `^5.0.0` was added in 1.4.0. It depends on `wrangler` 4.151.0 (Node ≥22) and a beta `miniflare`. Vitest 5.0.5 accepts Vite ^6.4, ^7 or ^8, and Node ^22.12, ^24 or ≥26.
- Migration [F][S26]: run `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` (supports `--dry-run`), or rename the dependency, the `cloudflareTest` import and the `types` entry. "The package API and Vitest configuration are unchanged." Outbound-request mocking moves to `@msw/cloudflare`.
- Not run: the plugin was not installed or exercised with this repo's Vite 8, Vitest 5.0.3 or Bun 1.4.2. Third-party reports that it fails on Vitest 5.0.3 conflict with the registry peer range and are unverified. [I]
- These local tests can cover the hook, bundle guard and TypeBox in workerd. They do not replace hosted acceptance on a deployed preview (D1, R2, Access, custom domains, caching). [R]

## Clerk on SvelteKit and Workers

**SDK status [F].** Clerk's SDK index lists official SDKs for Next.js, React, Astro, Nuxt, Vue, React Router, TanStack and plain JavaScript, among others. Svelte appears only under "Build with community-maintained SDKs" [S3]. Clerk "does not have an official support system for community developers" [S4]. `svelte-clerk` 1.2.0 is MIT, published by one npm maintainer under the `clerk-community` GitHub organization, and depends on `@clerk/backend` and `@clerk/shared`. It peers `@sveltejs/kit ^2.20.0`. Its Kit 3 pull request ([#460](https://github.com/clerk-community/svelte-clerk/pull/460)) was open with no review on 15 October 2026 and reports that 1.2.0 fails on Kit 3. `clerk-sveltekit` (0.4.3, last release August 2025) is deprecated in favour of `svelte-clerk`.

**Official path [F].** `@clerk/backend` 3.23.2 `authenticateRequest(request: Request, options)` takes a standard `Request` and returns `signed-in`, `signed-out` or `handshake`. It verifies without a network call when given `jwtKey`, and `authorizedParties` is "highly recommended" [S5]. The session JWT lives in `__session` on the app domain for same-origin requests and in `Authorization` for cross-origin ones. It expires after 60 seconds and is not HttpOnly. Browser SDKs refresh it every 50 seconds; server-rendered requests with an expired token get a 307 handshake to the Frontend API [S6].

**Hook shape [R].**
- `hooks.server.ts` calls `authenticateRequest` with `jwtKey`, `authorizedParties` set to that client's origin, and that client's keys from Worker secrets.
- A `handshake` result returns Clerk's redirect headers unchanged.
- A missing secret, a JWKS failure or an unknown status returns 503, never the page.
- `locals.identity` holds only the Clerk user ID. Case authority comes from the app's own grant table in that client's database.
- Clerk organizations, roles and metadata are never read as case access.
- The shared operator queue uses an identity separate from every client Clerk app, and it sees metadata only.

**CSP and the Clerk integration options [F]/[I].** Clerk's CSP page lists `script-src` and `connect-src` for the Frontend API host, `https://challenges.cloudflare.com` and `https://*.protect.clerk.com`, `worker-src 'self' blob:`, and frames from the same two hosts. It says `style-src 'unsafe-inline'` is "a requirement for Clerk's components to inject their styles", and that removing it is on Clerk's roadmap [S11]. The page does not say which of these apply to headless use or to the Account Portal. The app's CSP (`svelte.config.js`) allows one style hash and no third-party script, and both Clerk and strict case pages stay as chosen. Supported options, none proved here:
1. **Clerk's hosted Account Portal** for sign-in, with the server handshake and no ClerkJS on case pages. The Portal's pages "are hosted on Clerk servers" and "cannot be customized beyond the options provided in the Clerk Dashboard"; `redirect_url` must be on the instance domain or a subdomain [S27]. Open: every 60-second token expiry may be a redirect, so UX and cost are unmeasured.
2. **ClerkJS with its UI** (`mountSignIn`) on a separate sign-in route or origin, so only that route relaxes CSP, and case pages stay strict. Needs a per-route CSP and cookie/origin proof.
3. **ClerkJS without Clerk's rendered UI** for session and token refresh, with sign-in on the Portal. Clerk's `load()` lists `experimental.runtimeEnvironment: "headless"` as unstable and unexplained [S28]. `@clerk/clerk-js` 6.39.0 exports only `.` and `./no-rhc` on npm [F, npm]. Whether a loaded-without-UI build avoids `unsafe-inline`, and whether it can run without the UI bundle, is **unknown**; do not assume UI-style requirements apply or do not apply to it.
Choosing among these needs an on-preview test of the CSP header, token refresh and redirect behaviour. [R]

**Per-client apps and domains [F].**
- A production instance needs "a domain you own" and DNS records [S12].
- Setting a root domain makes authentication work across its subdomains, and Clerk recommends a subdomain allowlist [S12].
- Since 2024 Clerk scopes cookies so that several apps can share one domain, with `dashboard.` and `admin.` subdomains as its examples [S13].
- Isolation between sibling client subdomains (`a.` and `b.` of one root) is therefore documented in principle but **not proven here** (a probe).
- Development instances are capped at 100 users and use a query-string dev-browser token. Clerk says never to run them in production [S14].

**Pricing (USD, [S15], read 15 October 2026) [F].**

| Plan | Price | Notes |
| --- | --- | --- |
| Hobby | Free | 50,000 MRU per app; custom domain; fixed 7-day session; no MFA, passkeys, allowlist or SSO |
| Pro | $25/mo, or $20/mo billed annually | MFA and passkeys; 1 SSO connection included per app, then $75/mo each (2–15); satellite domains $10/mo each |
| Business | $300/mo | |
| Enterprise | custom | HIPAA BAA on Enterprise only [S16] |

- Every plan has "unlimited applications".
- Directory Sync billing starts January 2027.
- **Account unknown:** the pricing page does not say whether the Pro base fee is per application or per account. Confirm this with Clerk before you estimate cost for 1–2 clients.
- MFA, passkeys and allowlists require Pro or higher.
- No ZAR figure is given; convert at a dated rate when you budget.

**Identity data region [F].** "Clerk does not offer regional data residency or region selection". Data is on US infrastructure (Google Cloud and Cloudflare), and EU, UK and Swiss data moves to the US under the Data Privacy Framework [S16]. Clerk holds SOC 2 Type 2, but Clerk itself does not hold ISO 27001 [S16]. Unknowns: Enterprise or contract terms, and whether the user's clients accept US identity storage.

## Minimal proofs on a Wrangler-deployed preview (synthetic data only)

Workers version URLs exist only on `workers.dev`. They are public by default (protect them with Cloudflare Access), they use that version's existing bindings rather than a separate environment, and Durable Object Workers get none [S17] [F]. Use a dedicated proof Worker with its own synthetic D1 and R2, never a client Worker.

1. The hook fails closed: no cookie, an expired token, a token from client app B on client A, a wrong `azp`, and missing secrets (503).
2. The handshake works on SSR with and without ClerkJS, for each [Clerk option](#clerk-on-sveltekit-and-workers) above. The CSP stays strict on case pages.
3. Two Clerk apps on sibling subdomains don't share cookies (needs a production-style custom domain, not `workers.dev`).
4. The build-time guard: no `node:sqlite`, `node:fs` or `local-case` module in the Worker bundle.
5. TypeBox `Value.Check` works in workerd.
6. Kit 2.70.3 self-fetch fallback paths (GHSA-prjg) run with a hostile `Host`.
7. Private SSR, `/api` and asset responses carry `cache-control: private, no-store` and never enter a shared cache.

## Void candidate (bounded comparison)

Sources: [S18]–[S23], read 15 October 2026. Void comes in three parts: an SDK, a CLI and a Platform. The npm package is `void` 1.1.11, MIT. The repo was created in February 2026 and v1.1.11 was released on 15 October 2026. Publishers are Evan You and Christoph Pojer [F].

- **(A) Direct to your own Cloudflare account, no Platform [F].**
  - What it does: `voidPlugin()` plus the CLI deploy to your own account, and SvelteKit keeps `adapter-cloudflare` and its own routing [S19][S20]. It supports Kit 2.62 and later with adapter 7, or Kit 3 with adapter 8.
  - Auth: Void-managed auth "is not supported in framework mode yet"; the docs say to use Better Auth's SvelteKit integration directly. That is an opt-in suggestion and does not replace the user's Clerk choice.
  - Database: the SvelteKit page offers "typed database queries, and migrations" through `void/db`, an opt-in import. Adopting Drizzle or Better Auth is a separate choice; their presence in `void`'s dependencies alone does not make this project use them [F][S19].
  - Deploy: `void deploy` provisions inferred bindings, applies migrations, runs a readiness check, then shifts traffic. A failed readiness check restores the previous deployment. "Rollback does not reverse database migrations". `--atomic` sends traffic before the readiness check, and a failed build can leave provisioned resources behind [S21][S22].
  - Isolation: named Cloudflare environments are unsupported, so each client needs its own Void project config [S21]. Binding inference from source does not prove per-client isolation [I].
  - Readiness: the check needs `/__void/ready` or Access credentials, which conflicts with a fail-closed Clerk hook unless it is exempted [I].
  - Caching: "revalidation caches public HTML", but a response with `Set-Cookie` or `Cache-Control: private` is never shared [S20].
  - Installed toolchain tree, not the Worker bundle [F, npm]: `void` 1.1.11 declares `better-auth`, `drizzle-orm`, `drizzle-kit`, `pg`, `mysql2`, `better-sqlite3`, a beta `miniflare` and a beta `cf` CLI, and `engines.node >=24.21.0`. A developer installs this tree for the CLI. Which of it reaches a deployed Worker bundle depends on what the app imports and is **unproven** (a bundle inspection would show it). The tree still adds supply-chain surface to dev and CI.
- **(B) A self-hosted Void Platform [F].** It needs Workers for Platforms, R2, PostgreSQL, a login provider and a domain [S18]. That would be a shared self-hosted control plane plus a Postgres server. A shared control plane does not automatically violate per-client data isolation (it could hold deployment metadata only) [I], but it needs a proof of what it can read and an operations and cost assessment. Neither is done here.
- **Bun [F]/[I].** The quickstart shows `bun add -D void` and `bunx void init` [S23]. The README requires Node 24.21+, and `target: "bun"` is a runtime output (`bun dist/ssr/index.js`), not evidence that Bun can run the tooling. Bun CLI support remains an explicit future proof.
- **Provisional recommendation [R], not a decision.** Do not adopt Void now: Wrangler plus adapter-cloudflare already covers SvelteKit routing and deploys, and Void adds no Clerk support. The candidate stays open for the user, who is researching the local agent test platform (101, a separate worker). Local hardware and platform questions, and Void against workerd locally, belong to that research and are not repeated here. Proofs that would reopen it, on a throwaway Worker with no adoption or deploy: Bun running the CLI, Worker bundle contents, per-client isolation with separate project configs, and the readiness check beside a fail-closed hook.

## pstack discovery mismatch

- `skills_dir()` (`scripts/agent-tools/agent_tools.py:596`) looks for `poteto-mode/SKILL.md` in `.local/agent-tools/skills`, then `~/.agents/skills`, then `~/.claude/skills`. `~/.agents/skills` no longer holds `poteto-mode`, so the doctor fails `skills-dir` (receipt `.local/agent-receipts/…182812…-doctor`) [F].
- With `CLEARCASE_SKILLS_DIR` set to the canonical `~/.codex/plugins/cache/t3-pstack/t3-pstack/2.0.0-rc.6/skills` (62 skills, MIT, chhoumann/t3-pstack), the results were [F]:
  - every required file passed;
  - 25 pstack pins drifted, because t3-pstack rewrites skill content;
  - `make-bot-ui` was missing;
  - the three Matt Pocock skills were missing, because they live in `~/.agents/skills`;
  - 10 plugin skills are unpinned.
- Claude's cache holds 2.0.0-rc.5, not rc.6. `docs/agent-tooling.md` says the project "does not pin" t3-pstack [F].
- **Proposed later fix [R], in a reviewed tooling commit:**
  - Add a `t3-pstack` source to the lock: a pin of plugin version and content hash, `requiredFiles` only, no per-skill pins.
  - Have `skills_dir()` resolve the canonical plugin path from an explicit `CLEARCASE_PSTACK_PLUGIN` or the T3 plugin cache's highest version.
  - Look up the Matt Pocock skills in `~/.agents/skills` separately.
  - Do not reinstall the backnotprop mirror.

## Remaining choices (nothing adopted here)

- Kit 3 timing, before or after the Clerk proof.
- Clerk UI: ClerkJS in the app, or the hosted Account Portal.
- Operator identity: a separate Clerk app or Cloudflare Access.
- The hosted adapter version.
- Whether US identity storage is acceptable to each client.
- Void: provisional "not now" only. The user decides after the 101 research and the proofs.
- Clerk integration option (Account Portal, ClerkJS UI on a separate route, or unproven headless).
- ORM, backend framework and provider: none chosen.

## Sources (all read 15 October 2026)

[S1] https://www.npmjs.com/package/@sveltejs/kit · [S2] https://svelte.dev/docs/kit/migrating-to-sveltekit-3 · [S3] https://clerk.com/docs/reference/overview · [S4] https://clerk.com/docs/references/sdk/overview · [S5] https://clerk.com/docs/references/backend/authenticate-request · [S6] https://clerk.com/docs/guides/sessions/session-tokens, https://clerk.com/docs/guides/sessions/manual-jwt-verification · [S7] https://developers.cloudflare.com/workers/runtime-apis/nodejs/ · [S8] https://developers.cloudflare.com/workers/runtime-apis/web-standards/ · [S9] https://github.com/sinclairzx81/typebox · [S10] https://github.com/oven-sh/bun/releases · [S11] https://clerk.com/docs/guides/secure/best-practices/csp-headers · [S12] https://clerk.com/docs/guides/development/deployment/production · [S13] https://clerk.com/changelog/2024-09-09-multiple-apps-same-domain · [S14] https://clerk.com/docs/guides/development/managing-environments · [S15] https://clerk.com/pricing · [S16] https://clerk.com/security · [S17] https://developers.cloudflare.com/workers/configuration/previews/ · [S18] https://blog.cloudflare.com/deploy-with-void/ · [S19] https://void.cloud/integrations/frameworks/sveltekit · [S20] https://void.cloud/integrations/frameworks/overview · [S21] https://void.cloud/integrations/cloudflare · [S22] https://void.cloud/guide/deployment · [S23] https://github.com/voidzero-dev/void (README, docs/guide/quickstart.md, docs/integrations/nodejs-bun-deno.md) · [S24] https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/ · [S25] https://developers.cloudflare.com/workers/testing/vitest-integration/ · [S26] https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/ · [S27] https://clerk.com/docs/guides/account-portal/overview, https://clerk.com/docs/guides/account-portal/direct-links · [S28] https://clerk.com/docs/js-frontend/reference/objects/clerk. Package facts come from `npm view` on the public registry, and advisories from the GitHub advisory pages linked inline.
