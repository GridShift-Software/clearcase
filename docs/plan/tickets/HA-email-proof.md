# Prove minimal Cloudflare transactional notifications for alpha

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-111/prove-minimal-cloudflare-transactional-notifications-for-alpha) is the execution authority.

Planning key `HA-email-proof`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

The initial Cloudflare-native provider route has a proven minimal notification, safe configuration and bounded failure behavior.

## Reserved write scope

* tests/hosting-probe/notifications/\*\*
* docs/acceptance/hosting/notifications.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Start with the accepted Cloudflare Workers Paid route, using current primary documentation and disposable synthetic recipients. Resend remains a later alternative.
- [ ] Resolve the research's Paid qualifier, selected-route versus core checks, pricing/binding conflicts and actual SPF/DKIM/DMARC DNS evidence before claiming readiness.
- [ ] Investigate provisional ClearCase branding/per-client sender subdomain/full-message-preview-off defaults in depth; do not treat them as irrevocable product constraints.
- [ ] Prove minimal publication/input-needed notices to the uploader with authenticated links only, no case text, sensitive identifiers or attachments. Differentiate provider acceptance, delivery and inbox arrival.
- [ ] Prove bounded retry/operator visibility and possible ambiguous duplicates. Email failure leaves publication/files/in-app state intact. Advanced reliability/alert tuning stays later; do not introduce CF Queues automatically.
- [ ] Added 17 October 2026 (local-first plan, <issue id="42b36cd3-282a-42ee-b4ce-e6b04374cae7" href="https://linear.app/vaper/issue/GRS-26/prove-the-hosted-architecture-and-cloudflare-deployment">GRS-26</issue>): binding configuration, minimal content with no case text, retry, duplicates, operator visibility and "failure leaves publication intact" may pass against `wrangler dev`'s simulated send, which saves the message and sends nothing. These stay cloud legs at moment M3 on Workers Paid, and run before <issue id="00e869ac-8e6b-4b5c-b961-caec74950e96" href="https://linear.app/vaper/issue/GRS-137/prove-the-first-complete-hosted-pdf-case-workflow-before-broad-view">GRS-137</issue>: provider acceptance against delivery and inbox arrival, SPF, DKIM and DMARC, `allowed_sender_addresses`, and the conflict over whether Free can send. They use a sending subdomain under `sandbox.gridshift.co.za`, inside the GridShift zone, with its own `_dmarc` record.

## Verification and handoff

Run required core and selected-route research proof legs with genuine authorized provider/DNS dependencies; dev tests use a sink. Report exact SHA, delivery evidence and residual unknowns. No live client email or paid account change is authorized merely by creating this issue.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Align agent tooling with the canonical pstack plugin and delivery controls](<https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery>)
* [Prove SvelteKit 3 and Bun builds on the Cloudflare Workers runtime](<https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime>)
