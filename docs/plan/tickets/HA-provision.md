# Provision isolated client instances, cases and explicit grants

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-114/provision-isolated-client-instances-cases-and-explicit-grants) is the execution authority.

Planning key `HA-provision`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

GA can prepare separately resourced client instances and authorized admins can manage cases/users without implicit content access.

## Reserved write scope

* src/lib/tenancy/\*\*
* src/routes/admin/clients/\*\*
* src/routes/admin/cases/\*\*
* tests/hosted-foundation/provisioning/\*\*
* docs/hosted-foundation/provisioning.md
* deploy/client/\*\* (serialized manifest handoff)
* src/routes/cases/\*\*
* src/routes/admin/team/\*\*
* src/routes/admin/+page.\*

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Implement one client subdomain/Worker/D1/R2/secrets boundary under the user's Cloudflare account and repeatable checked manifests. No coded one/two-client count restriction.
- [ ] Implement initial firm-admin and staff provisioning; firm admins manage their users, and case assignments/viewer-editor/publisher/operator grants remain explicit and audited.
- [ ] Prove adding/removing accounts per client, case grants and access revocation affect metadata, actions and asset authorization.
- [ ] Keep shared internal queue metadata separate from each client's case files/results/user work. Expose a safe provisioning failure/retry state.
- [ ] Return the target/resource identity contract and an explicit shared-path handoff to storage/deployment owners.

## Verification and handoff

Provision two synthetic client instances/cases in authorized disposable staging and test every approved role with direct requests, including same-account resource confusion and revoked grants. No public/client provisioning during this planning stage.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate the hosted design before client intake implementation](<https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation>)
* [Implement Clerk invitations, sessions and hosted access checks](<https://linear.app/vaper/issue/GRS-113/implement-clerk-invitations-sessions-and-hosted-access-checks>)

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] A case exists and has explicit assigned-user access before its first publication. Provide case-level entry/navigation without a resultsVersion, showing submissions/originals and links to independent user work; integrate the shared visual pending/unavailable-results state. After results withdrawal preserve those authorized paths and never expose private/withdrawn results.
- [ ] Coordinate later exclusive handoffs within src/routes/cases/**: the viewer core owns cases/\[caseId\]/files/**; the Notes owner owns cases/\[caseId\]/notes/**; the case-cost owner owns cases/\[caseId\]/costs/**. Do not retain concurrent write ownership over handed-off paths.
