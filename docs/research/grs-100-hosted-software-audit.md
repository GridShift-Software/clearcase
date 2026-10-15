# GRS-100: Hosted software audit (dependencies, Clerk on SvelteKit and Workers, Void, pstack discovery)

Decision support for [GRS-100](https://linear.app/vaper/issue/GRS-100). It blocks the GRS-86 stack decision. App base `b93bad097fdd7b3c076d68025267c36395fc9921`, branch `research/grs-100-hosted-software-audit`. Sources were read on 15 October 2026. Labels: **[F]** fact from the cited source or the repository, **[I]** inference, **[R]** recommendation, not yet tested.

This is a planning audit. It is not a security certification, a full transitive CVE clearance or hosted evidence. Nothing was installed, relocked, upgraded, deployed or provisioned, and no app code changed. It makes no runtime PASS claim. The inputs are GRS-95 (`docs/research/grs-95-d1-r2-alpha-workload.md` on branch `research/grs-95-d1-r2-storage`: D1 and R2 layout, integrity) and GRS-96 (`docs/research/grs-96-file-viewer-feasibility.md` on branch `research/grs-96-file-viewer-feasibility`: viewers). This note does not retest them.

## Verdict

1. **Keep the current toolchain pins for the alpha baseline.** Patch bumps (vitest 5.0.5, typebox 1.3.37, Bun 1.4.3) go in later reviewed commits. SvelteKit 3 is a separate migration ticket and needs a decision first: three Kit advisories are fixed only in 3.0.0, and the only Svelte Clerk SDK does not yet support Kit 3. [R]
2. **There is no first-party Clerk SDK for Svelte or SvelteKit.** The lowest-risk path is the official `@clerk/backend` `authenticateRequest()` in a SvelteKit `handle` hook, plus official Clerk browser code (ClerkJS or the hosted Account Portal). `svelte-clerk` stays an optional convenience, not a foundation. [F]/[R]
3. **Clerk identity data is in the US, whatever region the case stores use.** Clerk offers no region selection. Treat this as a fact separate from the Cloudflare case-store choice (South Africa preferred, EU acceptable), and keep case data out of Clerk. [F]
4. **Clerk membership never grants case access.** Case authority is an app-side grant per client instance, and the hook fails closed. [R]
5. **Void (announced on 15 October 2026) is not recommended for adoption now.** In framework mode it removes little work for SvelteKit, and it brings Drizzle, Better Auth, Postgres and MySQL drivers and `better-sqlite3` into the toolchain. Its Bun CLI support is unproven. See [Void](#void-candidate-bounded-comparison). [R]
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
- `bun audit` 1.4.2 checked 154 packages and found no vulnerabilities [F]. It misses the three Kit advisories below, which are not in GitHub's global advisory database yet (HTTP 404 on 15 October 2026).

**The Node-only modules must not reach the hosted runtime.** Workers' `nodejs_compat` ships `node:sqlite` and `node:child_process` as non-functional stubs [F][S7]. The hosted adapter therefore needs a separate server entry, so that `$lib/local-case/*.server.ts` cannot be imported from hosted routes. Prove this with a build-time import guard (a probe, below). [R]

## Runtime-critical dependencies: pin, candidate, recommendation

| Dependency | Pin | Stable now | Peer compatibility | Recommendation |
| --- | --- | --- | --- | --- |
| `@sveltejs/kit` | 2.70.3 (latest 2.x) | 3.1.0 [S1] | Kit 3 needs Vite ^8.0.12, Svelte ^5.57.1, TS ^6, vite-plugin-svelte ^7 and Node ≥22.17. The current pins satisfy all of these [F] | **Retain 2.70.3 for the alpha baseline; schedule a Kit 3 ticket.** [GHSA-prjg-x2qj-wj3g](https://github.com/sveltejs/kit/security/advisories/GHSA-prjg-x2qj-wj3g) (SSRF in self-fetch fallbacks, medium), [GHSA-pfhg-q3qv-9q6r](https://github.com/sveltejs/kit/security/advisories/GHSA-pfhg-q3qv-9q6r) (open redirect with `use:enhance`, low) and [GHSA-27mw-82g8-phjj](https://github.com/sveltejs/kit/security/advisories/GHSA-27mw-82g8-phjj) (prerender XSS, low) are patched only in 3.0.0 [F]. The repo has no catch-all routes and no prerendering, so the last two do not apply now [I]. Whether the SSRF reaches adapter-cloudflare's fallbacks is open (a probe). Kit 3 removes `svelte.config.js`, renames `$lib` to `#lib`, replaces `$env` and changes adapter-cloudflare to `cloudflare:workers` [S2], so it is real migration work, not a bump |
| `svelte` | 5.57.2 | 5.57.2 | n/a | Retain |
| `vite` / `vite-plugin-svelte` | 8.3.4 / 7.3.1 | same | Kit 2 and 3 accept both | Retain |
| `typescript` | 6.0.3 | 7.0.2 | `svelte-check` 4.7.6 peers `^5 \|\| ^6`, and Kit 3 peers `^6` [F] | **Retain 6.0.3; do not move to 7** |
| `vitest` | 5.0.3 | 5.0.5 | Vite ^8 accepted | Patch upgrade in a reviewed commit. `@cloudflare/vitest-pool-workers` 0.23.0 peers vitest ^4.1 [F], so Workers-runtime tests cannot use that pool on vitest 5 today. Prove hosted behaviour on a deployed preview instead |
| `typebox` | 1.3.36 | 1.3.37 | n/a | Patch upgrade later. Before hosted use, prove `Value.Check` and `Value.Errors` under workerd: Workers forbid `eval` and `new Function` [S8], and TypeBox advertises a JIT compiler [S9] |
| `pdfjs-dist` | 6.4.299 | 6.4.299 | n/a | Retain. [GHSA-hq66-cqwq-w95j](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j) is patched in 6.2.108; the pin is past it [F]. Serving from R2 follows GRS-96 |
| `cookie` override | 0.7.2 | 2.0.1 | Kit 3 depends on `cookie ^2.0.1` [F] | Retain on Kit 2; **remove it in the Kit 3 commit**, or it forces 0.7.2 against `^2` |
| `@sveltejs/adapter-node` | 5.5.7 | 6.0.0 | 6.x needs Kit ^3 [F] | Retain for local. The hosted target needs `adapter-cloudflare` 7.2.9 (Kit ^2, wrangler ^4) or 8.0.1 (Kit ^3, wrangler ^4.118). Neither is adopted here |
| `@cfworker/json-schema` | 4.1.1 | 4.1.1 | n/a | Retain, scripts only. Low release activity; not runtime |
| Bun | 1.4.2 (`packageManager`) | 1.4.3, released October 2026 [S10] | n/a | Upgrade later with `bun upgrade --stable` and a reviewed `packageManager` commit. **Bun is dev and build only.** The hosted runtime is workerd, so Bun evidence is not hosted evidence |

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

**CSP conflict [F]/[I].** Clerk's browser UI requires `style-src 'unsafe-inline'`, the Frontend API host in `script-src`, and frames from `challenges.cloudflare.com` and `*.protect.clerk.com` [S11]. The app's CSP (`svelte.config.js`) allows one style hash and no third-party script. One option keeps case pages strict: sign in on Clerk's hosted Account Portal, and rely on the server handshake rather than ClerkJS on case pages. This is unproven: without ClerkJS in the page, every token expiry is a redirect.

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
2. The handshake works on SSR with and without ClerkJS. The CSP stays strict on case pages.
3. Two Clerk apps on sibling subdomains don't share cookies (needs a production-style custom domain, not `workers.dev`).
4. The build-time guard: no `node:sqlite`, `node:fs` or `local-case` module in the Worker bundle.
5. TypeBox `Value.Check` works in workerd.
6. Kit 2.70.3 self-fetch fallback paths (GHSA-prjg) run with a hostile `Host`.
7. Private SSR, `/api` and asset responses carry `cache-control: private, no-store` and never enter a shared cache.

## Void candidate (bounded comparison)

Sources: [S18]–[S23], read 15 October 2026. Void comes in three parts: an SDK, a CLI and a Platform. The npm package is `void` 1.1.11, MIT. The repo was created in February 2026 and v1.1.11 was released on 15 October 2026. Publishers are Evan You and Christoph Pojer [F].

- **(A) Direct to your own Cloudflare account, no Platform [F].**
  - What it does: `voidPlugin()` plus the CLI deploy to your own account, and SvelteKit keeps `adapter-cloudflare` and its own routing [S19][S20]. It supports Kit 2.62 and later with adapter 7, or Kit 3 with adapter 8.
  - Auth: Void-managed auth "is not supported in framework mode yet". The docs suggest Better Auth. **That suggestion does not replace the user's Clerk choice.**
  - Database: typed DB access comes from a Drizzle schema, which is an ORM this project has not adopted.
  - Deploy: `void deploy` provisions inferred bindings, applies migrations, runs a readiness check, then shifts traffic. A failed readiness check restores the previous deployment. "Rollback does not reverse database migrations". `--atomic` sends traffic before the readiness check, and a failed build can leave provisioned resources behind [S21][S22].
  - Isolation: named Cloudflare environments are unsupported, so each client needs its own Void project config [S21]. Binding inference from source does not prove per-client isolation [I].
  - Readiness: the check needs `/__void/ready` or Access credentials, which conflicts with a fail-closed Clerk hook unless it is exempted [I].
  - Caching: "revalidation caches public HTML", but a response with `Set-Cookie` or `Cache-Control: private` is never shared [S20].
  - Runtime dependencies: `void` pulls in `better-auth`, `drizzle-orm`, `pg`, `mysql2`, `better-sqlite3`, a beta `miniflare` and a beta `cf` CLI, and needs Node ≥24.21 [F, npm].
- **(B) A self-hosted Void Platform [F].** It needs Workers for Platforms, R2, PostgreSQL, a login provider and a domain [S18]. That is a second control plane and a Postgres server, outside the user's per-client isolation model. Not recommended.
- **Bun [F]/[I].** The quickstart shows `bun add -D void` and `bunx void init` [S23]. The README requires Node 24.21+, and `target: "bun"` is a runtime output (`bun dist/ssr/index.js`), not evidence that Bun can run the tooling. Bun CLI support remains an explicit future proof.
- **Verdict [R].** Wrangler plus adapter-cloudflare already covers SvelteKit routing and deploys, and Void adds no Clerk support. Revisit only if the project wants Void's migration and readiness flow, after proofs on a throwaway Worker.

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
- Void: no.
- ORM, backend framework and provider: none chosen.

## Sources (all read 15 October 2026)

[S1] https://www.npmjs.com/package/@sveltejs/kit · [S2] https://svelte.dev/docs/kit/migrating-to-sveltekit-3 · [S3] https://clerk.com/docs/reference/overview · [S4] https://clerk.com/docs/references/sdk/overview · [S5] https://clerk.com/docs/references/backend/authenticate-request · [S6] https://clerk.com/docs/guides/sessions/session-tokens, https://clerk.com/docs/guides/sessions/manual-jwt-verification · [S7] https://developers.cloudflare.com/workers/runtime-apis/nodejs/ · [S8] https://developers.cloudflare.com/workers/runtime-apis/web-standards/ · [S9] https://github.com/sinclairzx81/typebox · [S10] https://github.com/oven-sh/bun/releases · [S11] https://clerk.com/docs/guides/secure/best-practices/csp-headers · [S12] https://clerk.com/docs/guides/development/deployment/production · [S13] https://clerk.com/changelog/2024-09-09-multiple-apps-same-domain · [S14] https://clerk.com/docs/guides/development/managing-environments · [S15] https://clerk.com/pricing · [S16] https://clerk.com/security · [S17] https://developers.cloudflare.com/workers/configuration/previews/ · [S18] https://blog.cloudflare.com/deploy-with-void/ · [S19] https://void.cloud/integrations/frameworks/sveltekit · [S20] https://void.cloud/integrations/frameworks/overview · [S21] https://void.cloud/integrations/cloudflare · [S22] https://void.cloud/guide/deployment · [S23] https://github.com/voidzero-dev/void (README, docs/guide/quickstart.md, docs/integrations/nodejs-bun-deno.md). Package facts come from `npm view` on the public registry, and advisories from the GitHub advisory pages linked inline.
