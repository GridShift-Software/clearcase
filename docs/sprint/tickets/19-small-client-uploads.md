# 19: Small client uploads
**Wave:** 2 · **Size:** 0.5 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
A lawyer with an upload grant sees an "Upload documents" link in the case shell on staging, uploads a few small files through the existing intake flow, and the team is notified; the operator sees the new submission on the operator submissions page. Nothing here is the results-import endpoint.

How: the existing intake routes (`deploy/client/routes/client/intake/[caseId]/`) and `src/lib/submissions/`. Add the link in `src/lib/views/hosted/case-actions.ts` (06's registration point, yours now): an `Upload documents` action to `/client/intake/<caseId>` shown only when `locals` carries an upload grant for the case (the existing `createUploadAuthorizer` check, one query, or the grant already in 09b's memo if present). Notification: in `src/lib/submissions/controller.ts`, after a submission is sealed, write one `sub_notification(submission_id, case_id, created_at, delivered_at)` row (migration `src/lib/submissions/migrations/0003_intake_notification.sql`, staging `0012`) in the same batch, and in `waitUntil` POST a JSON message `{ caseId, submissionId, files, bytes, at }` to the webhook named by the secret `CLEARCASE_INTAKE_WEBHOOK` when set (fire and forget; mark `delivered_at` on 2xx). The operator submissions page (`deploy/client/routes/operator/submissions/[caseId]/`) lists undelivered notifications as "new". Provision an upload grant for the shared staging user with the existing `upload-provisioning.ts` through a one-off `bun scripts/intake/grant.ts --config deploy/staging/wrangler.jsonc --case v5-demo --subject <id>`, documented in the runbook. Keep the intake size and count budgets as deployed (`intakeBudget`).
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/client/intake/`, `deploy/client/routes/operator/submissions/`
- `src/lib/submissions/` (including `migrations/0003_intake_notification.sql`), `deploy/staging/migrations/0012_intake_notification.sql`
- `src/lib/views/hosted/case-actions.ts`, `scripts/intake/`
- `tests/hosted-smoke/intake/`, `tests/hosted-foundation/budget/19-intake.test.ts`, `docs/sprint/runbooks/19-intake.md`
Shared files this ticket owns, which others must not edit until it merges: `case-actions.ts`.
## Blocked by
- 06 TRACER (merged into the sprint branch; `case-actions.ts` exists and the shell renders actions)
## Acceptance
- [ ] On staging, signed in as the granted user, the case shell shows "Upload documents"; a user without the grant does not see it (two checks, J1 step 2 context).
- [ ] Uploading two small synthetic files on the preview completes; the operator submissions page lists the submission as new; the webhook double in tests receives one message with the right counts, and a webhook failure never fails the upload.
- [ ] Budget (`tests/hosted-foundation/budget/19-intake.test.ts`): the shell's action check adds at most 1 D1 query; the seal writes one batch; the webhook call is outside the response.
- [ ] Existing `tests/hosted-smoke/intake` and `tests/hosted-foundation/upload-grant` stay green; `tests/hosted-smoke/native-viewer/intake-*.test.ts` unchanged.
- [ ] The runbook names the grant command and the webhook secret name only.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/hosted-smoke/intake tests/hosted-foundation/upload-grant tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # upload two synthetic files, check the operator page, note ms
```
## Read first
`docs/development.md` "Import boundary"; `src/lib/submissions/README` or module headers; `src/lib/tenancy/upload-capability.ts`, `upload-provisioning.ts`; ADR 0009 (intake is not import); `research/journeys.md` (the intake link on the case page is a hosted acceptance test in `docs/sprint/README.md`).
## Decisions already made (don't re-decide)
- The link is an action in `case-actions.ts`; no shell or layout edit.
- Notification is a D1 row plus an optional webhook POST (`CLEARCASE_INTAKE_WEBHOOK`); the owner chooses the webhook target (Teams, Slack or Linear) and puts the secret. No e-mail (the zone is not active).
- Small files only, through the existing intake with its deployed budgets; bulk never passes through the Worker.
- The staging grant is provisioned by script with the existing provisioning module, audited as today.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing `tenancy/` (09b's), `services.ts`, `contracts.ts`, the version layout (06's), `intake.ts` in storage (08's area), treating the client upload API as the results-import endpoint.
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; the link shows for the granted user and an upload lands on staging; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
