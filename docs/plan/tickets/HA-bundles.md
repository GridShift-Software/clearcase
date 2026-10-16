# Persist PDF bundles with pinned inputs and protected version history

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-128/persist-pdf-bundles-with-pinned-inputs-and-protected-version-history) is the execution authority.

Planning key `HA-bundles`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Users assemble/reopen durable PDF bundle versions without losing their original inputs or protected history.

## Reserved write scope

* src/lib/bundle-assets/\*\*
* src/routes/v/\[vid\]/bundles/\*\*
* src/lib/views/bundles/\*\*
* src/lib/bundles/\*\*
* tests/hosted-features/bundle-assets/\*\* (serial handoff after bundle caller migration)

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Preserve the inherited PDF assembly, ordering/index and source selection behavior; persist uploaded inputs that currently exist only as browser object URLs.
- [ ] Each saved bundle pins exact input/rendition versions, ordering and index; regeneration creates a new durable version rather than overwriting a file.
- [ ] Default retain all versions. Only an explicitly configured limit keeps latest plus N previous unpinned versions; Keep-marked versions and every source file remain protected.
- [ ] Honor confirmed-privilege disclosure defaults/explicit override, show final scope before download and include shared Notes only on explicit selection.
- [ ] Original inputs, current bundles and kept versions remain accessible in-app using accepted viewers; authorized history/pruning never removes protected/source assets.

## Verification and handoff

Assemble from fresh uploads and mixed source versions, reopen after restart and regenerate after publication. Verify byte/manifest pins, default retention, latest+N boundary, Keep protection, notes/privilege scope, revoked access and export completeness.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Require explicit privilege confirmation and disclosure scope review](<https://linear.app/vaper/issue/GRS-127/require-explicit-privilege-confirmation-and-disclosure-scope-review>)
* [Unify document notes and annotations into contextual case Notes](<https://linear.app/vaper/issue/GRS-119/unify-document-notes-and-annotations-into-contextual-case-notes>)
* [Migrate litigation and existing bundle workspaces to hosted contracts](<https://linear.app/vaper/issue/GRS-133/migrate-litigation-and-existing-bundle-workspaces-to-hosted-contracts>)
