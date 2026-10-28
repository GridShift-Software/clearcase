# 02: Staging environment
**Wave:** 0 · **Size:** 0.5–1 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
A colleague opens `https://clearcase-staging.shiny-sunset-211d.workers.dev`, passes Cloudflare Access with a one-time PIN, and signs in with the shared Clerk staging user to the sprint head. Any developer runs `scripts/preview.sh` on a ticket branch and gets a preview URL bound to the staging D1, R2 and KV. `scripts/deploy-staging.sh` builds once, bookmarks D1, applies migrations and deploys a version; `scripts/deploy-staging.sh --rollback` redeploys the previous version.

How: follow `research/cloudflare-ops.md` section 5 runbooks (a), (b), (c) option 2 and (e). Create `clearcase-staging-db` (D1, `--jurisdiction eu`), `clearcase-staging-files` (R2, eu), KV `clearcase-staging-sessions` bound as `SESSIONS`. Commit `deploy/staging/wrangler.jsonc` with the real account id, `placement: { region: "aws:eu-west-2" }`, `workers_dev: true`, `preview_urls: false`, vars (`CLEARCASE_CLIENT_ID=staging`, `CLEARCASE_APP_ORIGIN`, Clerk sign-in URLs), and a `previews` block repeating the bindings. Seed `deploy/staging/migrations/` with the files the native-alpha pipeline emits for B (`deploy/native-alpha/schema.ts`, `runtime-migration.ts`; numbers up to 0007), so staging's schema equals B's; sprint tickets add `0008` onward (README table). The deploy script runs `bun run --bun build:hosted`, `wrangler d1 time-travel info` (record the bookmark), `wrangler d1 migrations apply --remote`, `wrangler versions upload --tag $SHA`, `wrangler versions deploy`, then smokes `/health`, `/sign-in`, `/cases` (401) and `cf-placement: remote-LHR`, and prints `sha url version`. The preview script sanitises the branch name, adds the two Clerk allow-list URLs through `POST /redirect_urls` if absent, runs `wrangler preview --name $name --var CLEARCASE_APP_ORIGIN=... --json`, and prints the URL; `scripts/preview.sh --delete` removes it. Protect the Worker with Access ("All traffic", email domain `gridshift.co.za` plus named colleagues, 24 h). Put the Clerk secrets with `wrangler secret put` and `wrangler preview base-config secret put`, values pasted by the owner into the prompt, never a file. Write the runbook in `docs/sprint/runbooks/02-staging.md` (URLs, ids, rollback, who holds which token).
## Reserved paths (edit only these; new files under them are fine)
- `deploy/staging/` (except `deploy/staging/migrations/0008_*.sql` onward, which belong to the tickets in the README table)
- `scripts/deploy-staging.sh`, `scripts/preview.sh`
- `deploy/client/wrangler.toml`, `deploy/client/hosted-files.json`, `deploy/probes/clients/*/wrangler.jsonc`
- `docs/sprint/runbooks/02-staging.md`
Shared files this ticket owns, which others must not edit until it merges: all wrangler configs, `deploy/client/hosted-files.json`.
## Blocked by
- None: can start immediately. The owner's steps below gate the Access and sign-in acceptance lines, not the start.
## Owner's manual steps (exactly these; everything else is the agent's)
1. Cloudflare dashboard → Zero Trust → choose a team name, Free plan, enter payment details (not charged). Tell the agent the team name.
2. Clerk: either create the application `clearcase-staging` (development instance), read its publishable key, secret key and JWKS public key (PEM), and paste them into the agent's `wrangler secret put` prompts; or authorise the agent to create it under the owner's Clerk login. Also the staff application if staff sign-in must stay a separate issuer.
3. GitHub repo secrets `CLOUDFLARE_API_TOKEN` (account-scoped token: Workers Scripts Edit, KV Edit, D1 Edit, R2 Edit, Account Settings Read) and `CLOUDFLARE_ACCOUNT_ID`.
4. One Cloudflare API token per developer with the same scopes, 30-day expiry, handed over out of band; they export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. One R2 "Object Read & Write" S3 token scoped to `clearcase-staging-files` (EU endpoint) for rclone, held by the operator (07 and 06 use it).
## Acceptance
- [ ] `scripts/deploy-staging.sh` from a clean worktree at the sprint head prints `sha url version`; `/health` 200 shows that SHA; `cf-placement: remote-LHR`.
- [ ] Unauthenticated GET redirects to the Access login; after the PIN, a colleague signs in with the Clerk staging user in one pass (J1 step 1 reaches the case list; sign-in time recorded, target under 5 s is 09a's).
- [ ] `scripts/preview.sh` on a branch prints a URL under `*-clearcase-staging.shiny-sunset-211d.workers.dev`; `/health` 200 there; Clerk sign-in completes on it.
- [ ] `scripts/deploy-staging.sh --rollback` restores the previous version in under 2 min; `/health` shows the previous SHA.
- [ ] `deploy/staging/migrations/` applied to the fresh D1 produces every table B has (`wrangler d1 execute --command "select name from sqlite_master"` diffed against B).
- [ ] No secret value in Git, the PR, logs or `docs/sprint/runbooks/02-staging.md`.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bun run --bun check:hosted-imports && bun run --bun build:hosted
bun run --bun test tests/hosted-foundation/native-runtime-config tests/hosted-foundation/native-runtime-migration tests/hosted-foundation/native-schema
scripts/deploy-staging.sh && scripts/preview.sh      # then walk the acceptance steps, note ms
```
## Read first
`docs/sprint/README.md` "Branches and environments"; `research/cloudflare-ops.md` (all); `docs/acceptance/hosting/workers-dev-bootstrap.md`; `docs/hosted-foundation/identity.md` (Clerk vars and secrets).
## Decisions already made (don't re-decide)
- One Worker `clearcase-staging`, one EU D1, one EU R2, one KV; London placement pinned in config; Access covers staging and every preview.
- One Clerk development application for staging and all previews; test users with `+clerk_test` addresses (code 424242); exact allow-list URLs per origin, added by the preview script.
- Wrangler 4.151.1 as pinned; no upgrade. Deploy through `bunx wrangler` under real Node; `versions upload` then `versions deploy`.
- Deploy-on-merge starts as the committed script run by the merger; 01's workflow calls the same script once the repo secrets exist.
- Sprint D1 migration numbers are pre-assigned per ticket (README table); this ticket seeds the existing set only. Previews share staging's D1, so schema changes are additive and applied to staging first.
- Staging case id is `v5-demo`; the case label comes from the package and may be the real one.
- Sandboxes A and B stay frozen.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git (values never in files, PR text or runbook); new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; any paid plan or spend change beyond the existing Workers Paid; touching `src/`.
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA by the script; J1 step 1 (Access, sign-in, case list) passes there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
