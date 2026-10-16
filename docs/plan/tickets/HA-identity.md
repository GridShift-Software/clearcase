# Implement Clerk invitations, sessions and hosted access checks

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-113/implement-clerk-invitations-sessions-and-hosted-access-checks) is the execution authority.

Planning key `HA-identity`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Invited client/staff users sign in through their correct identity application with revocable sessions and server-enforced role checks.

## Reserved write scope

* src/lib/auth/\*\*
* src/routes/auth/\*\*
* src/routes/support/\*\*
* src/routes/information-handling/\*\*
* tests/hosted-foundation/identity/\*\*
* docs/hosted-foundation/identity.md
* src/hooks.server.ts (serial handoff after framework owner)

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Implement the approved per-client/internal Clerk topology and invite flows; keep case grants/content outside identity metadata.
- [ ] Enforce issuer/client/subdomain, session expiry/revocation, unauthenticated and wrong-case denial through a reusable server contract. GA/firm admin is not automatic case-content access.
- [ ] Provide sign-in interruption/retry guidance and reviewed logged-out support/information entry points (BA-19/BA-20). Never silently invent legal/information-handling copy; surface content for review.
- [ ] Keep MFA behind the initially-off flag. Prove callers cannot rely solely on UI visibility.
- [ ] Freeze a role/case-authorization API consumed by provisioning, assets and feature callers; only one writer owns hooks at a time.

## Verification and handoff

Exercise invite/login/retry/expiry/revocation and wrong-issuer/client/case direct requests plus logged-out links using genuine disposable identity where needed. Record exact SHA and independent review.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate the hosted design before client intake implementation](<https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation>)
* [Migrate the app build and shared server entry points to Workers](<https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers>)

Public entry ownership: include the hosted root entry route (src/routes/+page.server.ts) and its login/cases navigation plus the existing logged-out support/information-handling entry points. Keep invite-only authentication. This does not add a marketing-site redesign, payment checkout or public self-registration. Framework owner hands the root entry route to this owner serially before implementation.
