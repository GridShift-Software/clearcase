# Small client uploads

Client intake stores a new submission for the operator. It does not import or publish results.
Keep the existing deployed `intakeBudget`; use this flow for small PDFs only.

After migration `0012_intake_notification.sql` is applied to staging, provision the shared staging user's explicit upload grant:

```sh
bun scripts/intake/grant.ts --config deploy/staging/wrangler.jsonc --case v5-demo --subject <id>
```

Use the existing user's subject. This command neither creates a user nor grants case read access.
It uses the existing audited upload-grant producer and resumes the same operation on retry.
An audit failure leaves the grant pending. A revoked grant is not reactivated by rerunning this seed.
The command refuses configurations for other Workers. Run it with the operator's existing private credentials.

The optional webhook secret is `CLEARCASE_INTAKE_WEBHOOK`. The owner selects and configures its destination;
do not put a URL or secret value in this runbook, Git, logs or test output. With no destination configured,
the upload still succeeds and the operator sees its durable notification as **New**.

Finalizing one PDF or sealing a set records its notification atomically. Webhook delivery runs through the request's `waitUntil`,
with a bounded timeout and no redirects. It sends only the case and submission identifiers, file count,
byte count and sealing timestamp. A 2xx marks delivery; a failed or interrupted attempt remains **New**.
Delivery is best effort, with at most one attempt per submission; there is no automatic retry queue.
The marker means undelivered notification, not an unread flag or processing status.

For the preview walkthrough, sign in as the granted user, open the published case and follow **Upload documents**.
Upload two small synthetic PDFs and seal the submission. Sign in as an authorized staff operator and open
`/operator/submissions/<caseId>` to check its **New** marker with the webhook unset. Confirm that a case reader
without the explicit upload grant does not see the upload action. Record the exact SHA and elapsed milliseconds.
Never use real case files for this walkthrough or send them to a webhook double.
