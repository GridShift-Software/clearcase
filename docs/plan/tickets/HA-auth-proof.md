# Prove Clerk sessions and explicit case authorization on Workers

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-108/prove-clerk-sessions-and-explicit-case-authorization-on-workers) is the execution authority.

Planning key `HA-auth-proof`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

The design gate receives a working Clerk integration and an explicit role/session/asset authorization contract.

## Reserved write scope

* tests/hosting-probe/identity/\*\*
* docs/acceptance/hosting/identity.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Use separate per-client Clerk applications plus a separate internal staff app; validate actual SvelteKit/Workers integration rather than assuming an official Svelte wrapper.
- [ ] Prove invite-only staff/initial-admin/client-user flows, server token verification, expiry/revocation and interrupted session recovery.
- [ ] Keep case grants, documents, text and Notes outside Clerk. Firm admins/GA do not automatically gain case content; operator access is explicit and audited.
- [ ] Prove wrong-client issuer/audience/subdomain, wrong-case, logged-out and revoked sessions cannot read metadata, user work, draft/published assets or mutations.
- [ ] Keep MFA flag off initially with no fabricated usage threshold. Define hooks, auth API, role matrix and public BA-19/BA-20 entry-point contracts for bounded foundation owners.
- [ ] Added 17 October 2026 (local-first plan, <issue id="42b36cd3-282a-42ee-b4ce-e6b04374cae7" href="https://linear.app/vaper/issue/GRS-26/prove-the-hosted-architecture-and-cloudflare-deployment">GRS-26</issue>): these legs may pass on workerd against the real Clerk development instances (`Clear-Case-Dev-A` client, `Clear-Case-Dev-B` staff) with no Cloudflare account: invite-only flows, server token verification, expiry, revocation and interrupted recovery, wrong-case, logged-out and revoked denial, grants outside Clerk, and staff/client app separation. The wrong-client issuer/audience leg needs one more client dev app and stays HOLD until it exists. Development instances carry sessions in `__clerk_db_jwt` rather than app-domain cookies. Sibling-subdomain session isolation, hosted CSP and production instances therefore stay cloud legs at moment M3, on custom domains under `sandbox.gridshift.co.za`.

## Verification and handoff

Exercise positive and negative direct-request/UI paths against real disposable identity/Workers dependencies where required. No mocked acceptance boundary. Record exact SHA, topology, allowed minimal identity fields and source evidence without secrets.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Align agent tooling with the canonical pstack plugin and delivery controls](<https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery>)
* [Prove SvelteKit 3 and Bun builds on the Cloudflare Workers runtime](<https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime>)
