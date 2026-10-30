# Clerk instance switch (ticket 09c, GRS-267)

Which Clerk instances staging and its previews sign in against, and how the owner moves them from the shared development instances to production ones. No secret value appears here; only variable names.

**Owner decision, 28 October:** the demo may run on the development instances (sign-in about 6.6 s, 11 to 13 s cold). Shortly before the demo, create production instances and switch to them as a last-minute test. If the check below fails, switch back: it is the same one command.

## What is one setting

Each mode has a profile with every non-secret value: `deploy/staging/clerk-instances/development.json` and `production.json` (publishable key, Frontend API host, sign-in URL, for the client and the staff instance). `scripts/clerk-instance.sh --use <mode>` applies one:

1. refuses a profile that still holds a `PLACEHOLDER`, or whose values disagree (key mode, key host, sign-in host, two identical instances);
2. rewrites the Clerk values in `deploy/staging/wrangler.jsonc` (`CLERK_*_PUBLISHABLE_KEY`, `CLERK_*_SIGN_IN_URL`, in the top level and in `previews`, and the two issuers inside `CLEARCASE_NATIVE_CONFIG`) and commits that one file;
3. puts `CLERK_CLIENT_SECRET_KEY`, `CLERK_STAFF_SECRET_KEY`, `CLERK_CLIENT_JWT_KEY` and `CLERK_STAFF_JWT_KEY` on the Worker and the Preview base config (the JWT keys are read from each instance's `/v1/jwks`);
4. adds the staging origin to both instances' redirect URLs and allowed origins (`--skip-allow-list` leaves that to the dashboard);
5. deploys HEAD with `scripts/deploy-staging.sh` (`--no-deploy` stops before this).

The Worker also refuses a mismatched mix by itself (`src/lib/auth/clerk/config.ts`): a `pk_live_` key with an `sk_test_` secret or the reverse, or a sign-in URL whose host is not the accounts portal of its publishable key's instance. Clerk then counts as not configured (fail closed, the reason names the variable and never a value) instead of signing in against the wrong instance. The issuers are derived from the publishable keys, and a `CLEARCASE_NATIVE_CONFIG` issuer that differs makes the case routes unavailable.

## What the owner creates in Clerk

Two **production** instances (Clerk: create application, then "Create production instance" for each), one per kind:

- **client**: the firms' users. Sign-in by email code.
- **staff**: operators and the Global Admin.

For each: a custom domain you control, so its Frontend API is `clerk.<domain>` and its accounts portal `accounts.<domain>`; add the DNS records Clerk lists (CNAMEs for `clerk`, `accounts`, the mail and DKIM records) and wait until Clerk shows them verified. The profile's sign-in URL must be `https://accounts.<domain>/sign-in`.

Per instance, in the dashboard (the redirect URLs and allowed origins for staging are also added by step 4 of the switch):

- **Allowed redirect URLs** for staging and every preview: the same two paths on the staging origin (`bun deploy/staging/origin.ts get`, now `https://clearcase-staging.gridshift.co.za`) and on `https://<name>-clearcase-staging.shiny-sunset-211d.workers.dev` (`scripts/preview.sh` adds each preview's own, to the active instance).
- **Allowed origins**: the staging origin and the preview origins.
- Test users: the `+clerk_test` address and code 424242 shortcut belongs to development instances; do not rely on it in production. Create real users with a mailbox you read (one client user, one staff user) and sign in with the email code.
- Session lifetime and MFA: leave the defaults; `AUTH_MFA_REQUIRED` stays `false` in the config.

## Where the keys go

1. Edit `deploy/staging/clerk-instances/production.json`: for each of `client` and `staff`, the `publishableKey` (Clerk: API keys, publishable key), the `frontendApi` host (the host the key encodes, `clerk.<domain>`) and the `signInUrl`. Remove every `PLACEHOLDER`. Commit it (it holds no secret).
2. Put the two secret keys in `.local/secrets/staging-clerk-production.env` in the main checkout (ignored by Git), in the format of `staging-clerk.env`:

   ```
   CLERK_SECRET_KEY=<client instance secret key>
   CLERK_STAFF_SECRET_KEY=<staff instance secret key>
   ```

   `STAGING_CLERK_ENV` names another file; the repo-secret variables `STAGING_CLERK_SECRET_KEY` and `STAGING_CLERK_STAFF_SECRET_KEY` win over the file, so unset them (or set them to the production keys) first. The switch refuses, before it writes or commits anything and in the dry run too, a key that is missing, malformed, a placeholder, the same for client and staff, or of the other mode than the profile.

## Switch

From a clean worktree on the sprint branch with real Node first on PATH and Wrangler logged in, as for a staging deploy:

```sh
scripts/clerk-instance.sh --use production --dry-run   # names of the vars and secrets it would change; no values
scripts/clerk-instance.sh --use production
```

The dry run exits 1 and lists the fields while a `PLACEHOLDER` remains. The apply ends with the deploy smoke (`/health`, `/sign-in`, `/cases`). Between the secrets and the deploy (about a minute) staging's sign-in is unavailable: the Worker has the new secrets with the old vars, and refuses that mix by design. Then **open a PR with the one commit it made into `sprint/hosted-demo-20261105`**: until it merges, the next auto-deploy puts the development vars back against the production secrets, and sign-in fails closed again. Previews already uploaded keep their old vars until `scripts/preview.sh` is run again.

## Check after the switch

1. `scripts/clerk-instance.sh --active` prints `production`.
2. `GET <staging origin>/sign-in` is 200 and its Sign in button goes to `accounts.<client domain>`, not `accounts.dev`.
3. Sign in as the client test user in a clean browser profile, then as the staff user at `/sign-in/operator`: both land on the app.
4. Time it: `SIGN_IN_MS=5000` is the default of the journeys; run J1 with `MODE=hosted BASE_URL=... CREDENTIALS_JSON=...` (`tests/journeys/README.md`). Sign-in under 5 s is the RC gate on the production instance; the sign-in step is strict below `SIGN_IN_MS`.
5. A development-instance session no longer works (expected): sign out and in.

## Rollback

```sh
scripts/clerk-instance.sh --use development
```

This restores the development vars and secrets and deploys. Merge its commit too (it undoes the production commit, merged or not). Run the journeys on the development instance with `SIGN_IN_MS=8000`: about 6.6 s is the accepted interim, not a fault.

## Names and branding (owner, dashboard)

The application name, logo and favicon are not in the Backend API, which the instance secret keys reach (`PATCH /v1/instance` has no name or branding field). Clerk's Platform API has `PATCH /platform/applications/{id}` (`name`) and `POST .../logo` and `.../favicon`, but it is in private beta and takes a Platform API access token, which no script here holds. So the owner renames each app in the dashboard (GRS-278):

1. dashboard.clerk.com > the client app (`outgoing-walrus-1020`, now "Clear-Case-Dev-C") > Settings > the application name: `ClearCase`. Save.
2. The staff app (`renewed-moth-1294`) the same way: `ClearCase staff`.
3. Optional, same Settings page > Branding: upload the logo and favicon. The accounts portal and the emails use them.
4. Check: open `<staging origin>/sign-in` in a private window. The Clerk page names the new app. The "Development mode" badge stays while the instances are development ones.

The colours of the accounts portal are set in the dashboard too, if at all. The app sends users to the hosted accounts portal and renders no Clerk component, so the SDK's `appearance` prop does not reach them.

## Notes

- The grants in staging's D1 are keyed by Clerk issuer and subject. Production instances have new issuers and new user ids, so the test users need grants again (the `scripts/publish` grant commands in `docs/sprint/runbooks/06-publish.md`).
- `scripts/clerk-instance.sh` never prints a key, a JWT key or a token; it names secrets and variables only.
