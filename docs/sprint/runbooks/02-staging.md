# Staging runbook (ticket 02, GRS-245)

The hosted demo's staging Worker and its per-branch Previews. No secret value appears here; see "Who holds which credential".

## URLs and resources

| What | Value |
| --- | --- |
| Staging | `https://clearcase-staging.shiny-sunset-211d.workers.dev` |
| Previews | `https://<name>-clearcase-staging.shiny-sunset-211d.workers.dev`, `<name>` from `scripts/preview.sh` |
| Account | `fb4c31b91c5d89b7a54afbdc34823170` (workers.dev subdomain `shiny-sunset-211d`) |
| Worker | `clearcase-staging`, London placement (`aws:eu-west-2`, answers `cf-placement: remote-LHR`) |
| D1 (EU) | `clearcase-staging-db`, `126f680e-4c4b-4b48-98bf-5a5e82c7b1ba`, bound as `DB` |
| R2 (EU) | `clearcase-staging-files`, bound as `BUCKET` |
| KV | `clearcase-staging-sessions`, `46d612ce2eb844edacd735cfeb257344`, bound as `SESSIONS` (unused until 09a) |
| Clerk client app | `outgoing-walrus-1020` (shared with sandbox B), callback `<origin>/sign-in` |
| Clerk staff app | `renewed-moth-1294` (shared with A and B), callback `<origin>/sign-in/operator` |
| Access team | `super-limit-6f87.cloudflareaccess.com` |
| Config | `deploy/staging/wrangler.jsonc`; migrations in `deploy/staging/migrations/` |

`CLEARCASE_CLIENT_ID` is `staging`. Grants live in staging's own D1, so sharing the Clerk apps with B gives no access across Workers. Test users sign in with a `+clerk_test` address and code 424242 (the Clerk page asks for a password first: choose "Use another method", then "Email code").

## Deploy

```sh
scripts/deploy-staging.sh
```

From a clean worktree at the commit to ship. It builds once (`build:hosted`), records a D1 Time Travel bookmark, applies migrations, uploads a version tagged with the full SHA, deploys it at 100%, applies the workers.dev settings, then smokes `/health` (200 at that SHA), `/sign-in` (200), `/cases` (401) and `cf-placement: remote-LHR`. Its last line is `sha url version`. Each run appends `{at, sha, version, bookmark}` to `.local/staging/deploys.jsonl` (ignored). About 40 s.

The first run on an empty account also creates the Worker and provisions the two runtime records: the `/health` sentinel (a `runtime_sentinel` row naming the SHA-256 of `runtime/sentinel` in R2) and the storage identity (`rs_storage_identity` plus `identity/client.json`, both naming `staging`). Every case route answers 503 `storage-unavailable` without the storage identity.

Behind Access the smoke stops at the Access redirect and says so, unless a service token is exported as `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

## Migrations

`deploy/staging/migrations/` holds the files the native-alpha pipeline emits for sandbox B (`deploy/native-alpha/schema.ts` and `runtime-migration.ts`), byte for byte, so a fresh staging D1 has B's schema: 0001, 0002, 0004 to 0007, and B's `0008_native_pdf_sessions.sql` renamed `0007_native_pdf_sessions.sql`, because the sprint reserves 0008 onward (`docs/sprint/tickets/README.md`). Wrangler applies files in name order, so it still runs after `0007_native_intake_file_sets.sql`, as on B. After the first deploy, the `sqlite_master` of staging and B matched exactly: 284 objects (69 tables, 24 indexes, 190 triggers, 1 view) with the same SQL.

## Previews

```sh
scripts/preview.sh            # prints the URL
scripts/preview.sh --delete   # after the PR merges
```

The name is the branch without `sprint/`, lower-cased, other characters turned into `-`, cut to 45 characters (`sprint/grs-245-staging-environment` gives `grs-245-staging-environment`); `--name` overrides it. The script adds the two Clerk callbacks and the allowed origin for the preview origin (idempotent), and passes `CLEARCASE_APP_ORIGIN` and a `CLEARCASE_NATIVE_CONFIG` re-aimed at the preview host as `--var`: the runtime refuses a native config whose hostname differs from the app origin. Previews use staging's D1, R2 and KV, so a schema change is additive and is applied to staging (by a staging deploy) before a preview relies on it. New previews inherit the Clerk secrets from the Preview base config.

`preview_urls` must stay `true` in the config: it is the Worker's workers.dev `previews_enabled`, and `false` answers every Preview URL with Cloudflare error 1042.

## Rollback

```sh
scripts/deploy-staging.sh --rollback              # to the newest earlier version with a different SHA
scripts/deploy-staging.sh --rollback <version-id> # to that version
```

`wrangler rollback` keeps bindings and secrets and takes seconds; the script then smokes `/health` at the restored SHA. A rollback does not undo a migration. If a migration broke data, restore D1 to the bookmark that deploy recorded before migrating (30-day window):

```sh
node node_modules/wrangler/bin/wrangler.js d1 time-travel restore clearcase-staging-db --bookmark <bookmark> -c deploy/staging/wrangler.jsonc
```

## Secrets

`scripts/deploy-staging.sh --secrets` puts `CLERK_CLIENT_SECRET_KEY`, `CLERK_STAFF_SECRET_KEY`, `CLERK_CLIENT_JWT_KEY` and `CLERK_STAFF_JWT_KEY` on the Worker and on the Preview base config, through Wrangler's stdin. The JWT keys are each instance's public RSA key, read from the Backend API (`GET /v1/jwks`) and converted to PEM. Rerun it after a Clerk key rotation; secrets survive deploys.

The Clerk instance (development or production) is one setting: `scripts/clerk-instance.sh --use <mode>`; see `09c-clerk-instance.md`.

## Who holds which credential

| Credential | Holder | Used by |
| --- | --- | --- |
| Clerk secret keys (client, staff) | Owner: `.local/secrets/staging-clerk.env` in the main checkout; repo secrets `STAGING_CLERK_SECRET_KEY`, `STAGING_CLERK_STAFF_SECRET_KEY` | `deploy/staging/clerk.ts` (preview allow-lists, `--secrets`); env vars of the same names take precedence, or `STAGING_CLERK_ENV` names another file |
| Cloudflare deploy token | Owner (Wrangler login); CI token in repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; one 30-day token per developer (owner step 4) | both scripts through Wrangler |
| R2 S3 token (`clearcase-staging-files` only) | Owner: rclone remote `cc-staging` | uploads of originals (tickets 06, 07) |
| Access login | Each colleague: one-time PIN to their email | browser only |

## Cloudflare Access (owner step, open)

Staging and every preview are reachable without Access until this is done. The Wrangler login cannot manage Access: creating the one-time-PIN login method (`POST /accounts/{account}/access/identity_providers`) and the Access application (`POST /accounts/{account}/access/apps`) both answer 403 `{"code":1010,"error":"auth.forbidden"}`. With the dashboard or a token that has Access: Apps and Policies Edit:

1. Zero Trust > Settings > Authentication > Login methods: add One-time PIN.
2. Workers & Pages > `clearcase-staging` > Access > "Protect this Worker behind Access" > All traffic (staging and previews); or Zero Trust > Access > Applications > self-hosted with the domains `clearcase-staging.shiny-sunset-211d.workers.dev` and `*-clearcase-staging.shiny-sunset-211d.workers.dev`.
3. Policy: allow email domain `gridshift.co.za`, the owner's personal address and any colleague outside that domain; session 24 h.
4. Check: an unauthenticated `GET /` redirects to `super-limit-6f87.cloudflareaccess.com`; after the PIN, `/health` is 200 and Clerk sign-in completes. For the deploy smoke, create an Access service token and add it to the policy as a Service Auth rule.
