# Transactional notifications: the local legs (GRS-111)

[GRS-111](https://linear.app/vaper/issue/GRS-111) asks for a proven minimal notification on the Cloudflare-native route, with safe configuration and bounded failure behaviour. Cloudflare stays pinned (GRS-26, decisions of 17 and 20 October 2026), so this unit runs the **local legs** only: `wrangler dev`'s simulated `send_email` binding on native workerd, which saves each message and sends nothing. No account, token, login, DNS change, deploy or real message is involved. The cloud legs wait for moment M3 and its owner (GitHub `dianbrown`) and run before GRS-137.

**Verdict: PASS for the local legs at `0493a66d06206fae872bb03f8cee01ddc6e732cb`; HOLD for the cloud legs.** The committed run is [evidence/notifications-summary.json](evidence/notifications-summary.json). What stays HOLD is listed [at the end](#what-stays-hold).

## Run it

From `tests/hosting-probe/notifications/`, a workspace with its own pins and `bun.lock`, apart from the root workspace.

```sh
bun install --frozen-lockfile      # once, online
bun run --bun probe                # ~17 s; writes .local/hosting-probe/notifications/summary.json at the repo root
bun run --bun probe --check ../../../docs/acceptance/hosting/evidence/notifications-summary.json
                                   # exit 0 only for this runner's PASS summary for a commit of this checkout (see below)
bun run --bun test                 # the content check, the retry policy, and the same check over the committed evidence
bun run --bun tamper               # ~2 s; proves `test` refuses evidence that names the wrong commit, artifact or count
bun run --bun adverse              # ~70 s, offline; proves the run fails when the Worker sends a cc, bcc, replyTo or header
```

[`probe.ts`](../../../tests/hosting-probe/notifications/probe.ts) follows GRS-106's runner ([runtime.md](runtime.md)). It refuses to run (exit 2) on a dirty tree, on any Bun but 1.4.2, when an installed package differs from its pin, or when the only `node` it finds is Bun. It re-runs itself inside [`tests/e2e/pilot/offline.sh`](../../../tests/e2e/pilot/offline.sh), checks again that `lo` is the only interface and that no route exists, and gives every child the same environment allowlist: a fresh `HOME` and XDG directories, `CI=1`, and telemetry, error reports, the banner, the `cf.json` fetch and dotenv loading off. The summary says `evidence: true` only when every leg passes, `/health` serves the HEAD stamp, HEAD and the tree are unchanged at the end, and the runner's own checker refuses every mutation of the summary (1,336 at the product head) and the check of committed evidence below passes.

**Checking committed evidence.** `--check FILE` and `test` call one function ([`evidence.ts`](../../../tests/hosting-probe/notifications/evidence.ts)) that compares the summary with one exact shape for its own `sourceSha` ([`summary.ts`](../../../tests/hosting-probe/notifications/summary.ts): `finishedAt` not before `startedAt`, `runDir` the directory `startedAt` names), and then requires: `sourceSha` is an ancestor of HEAD; nothing under `tests/hosting-probe/notifications/` or in `tests/e2e/pilot/offline.sh` (the namespace the probe runs in) differs from it, committed or not, tracked or not; a rebuild of `src/worker.ts` stamped with it has the digest in `artifact`; and `checker.mutationsRefused` equals the count the mutation walk gives for the summary now. It never points the summary's SHAs at HEAD. A shallow clone that lacks `sourceSha` fails it, and `tamper` shows the failures for the branch base, an older probe commit, a commit that is no ancestor, a zeroed artifact, a count of 1, reversed times and another run's directory. The evidence file is in `docs/`, outside the directory, so committing it after a run does not invalidate the run.

## What runs where

| Step | Host or kind |
| --- | --- |
| Build of [`src/worker.ts`](../../../tests/hosting-probe/notifications/src/worker.ts) to one self-contained module | Bun 1.4.2 (`Bun.build`), stamped with HEAD. Wrangler serves it as built (`no_bundle`) |
| Runner, requests, assertions, summary | Bun 1.4.2 |
| `wrangler dev --local`, `wrangler d1 execute --local` | Node 26.10.0 hosts Wrangler 4.151.1 only |
| The Worker | native workerd 1.20261012.1, a descendant of Wrangler's process |
| D1, R2 | real local Miniflare bindings |
| `send_email` | **simulated**: the local binding checks its restrictions, saves the message under the dev session's temp directory, logs where, and sends nothing |
| Provider failures (`E_*` codes, a lost response, no answer) | **double**: `FAULT_PLAN`, declared only by `wrangler.toml`'s `faults` environment |
| Identity | **double**: the `x-probe-identity: <client>/<user>` header stands in for a Clerk session (GRS-108 owns Clerk) |

The doubles are named in the summary's `boundaries`. No result here is evidence for Cloudflare Email Sending, DNS, Clerk or a deployment.

## The design under test

- **Order.** A publication puts the results file in R2, under a key that carries its digest, then one D1 batch writes the publication, the in-app notice and its outbox row. A racing publish of the same version with another file writes another object and answers 409 when its batch loses; the losing racer's object `publications/<case>/<version>/<digest>.txt` stays in R2, unreferenced and never removed (the product needs a sweep or a content-addressed store before real files). Only then is the email tried. Email never gates or rolls back what came before it: the outbox row records the attempt, and a failed first attempt still answers the committed publication with 200. The in-app notice is authoritative (GRS-93).
- **Content.** [`src/notice.ts`](../../../tests/hosting-probe/notifications/src/notice.ts) has one fixed subject and plain-text body per kind, publication and input-needed. The only variable part is one link, `<client origin>/n/<uuid>`: an opaque notice id, with no query, token, case id or case wording. The content check is an allowlist: exactly the keys `from`, `to`, `subject` and `text`, each a string; `from` is the client's sender; `to` is the uploader alone, as one bare address of printable ASCII (no space, comma, semicolon, angle bracket, quote, parenthesis, backslash or second `@`, and no control or non-ASCII character such as NUL, U+0085 or U+200B), so a data-borne recipient cannot add a second address or a header or hide one; subject and body equal the kind's template around one such link. The origin and the sender the Worker was configured with are checked against the values derived from `CLIENT_ID`, never against themselves, and a `CLIENT_ID` that is not one of the two clients this probe configures (`client-a`, `client-b`) is refused, so a mistyped id fails closed instead of deriving its own origin. A denylist of the case's own strings (title, reference, id, document titles, file names) runs on the subject and body. The Worker runs the check before every send and refuses the send on any problem (`NOTICE_CONTENT_REFUSED`). The runner reads every saved message independently ([below](#the-runners-check-of-a-saved-message)).
- **Authenticated link.** `/n/<id>` needs the signed-in recipient of that notice on this client's instance: no session 401, another client's session 401, another user of the client 404, the uploader 303 to the case inside the app.
- **Retry.** [`src/policy.ts`](../../../tests/hosting-probe/notifications/src/policy.ts) classifies each failed `send()`: 16 of the 20 codes on Cloudflare's Workers API page (updated 15 October 2026) are permanent (the message was refused) and get no retry. `E_RATE_LIMIT_EXCEEDED` and `E_DAILY_LIMIT_EXCEEDED` are transient. `E_INTERNAL_SERVER_ERROR`, `E_DELIVERY_FAILED`, a timeout, an attempt cut off mid-send, a missing `messageId` and any unknown code are ambiguous: acceptance is unknown. Transient and ambiguous failures retry, at most three attempts in all, 5 and 30 minutes apart, from a cron sweep. No Queues.
- **Duplicates.** Email Sending has no idempotency key and sets `Message-ID` itself, so a retry after an ambiguous attempt can deliver twice. The policy accepts that, as the user decided on 16 October 2026 (GRS-93: a possible duplicate generic notice over a missed one). The notice id deduplicates the app's own work: one in-app notice and one outbox row per event, and publishing the same version again sends nothing. The operator view marks a notice `possibleDuplicate` when two or more of its attempts may have reached the recipient.
- **Operator view.** `/ops/notifications`, operators only, lists every notice of the instance with its state, attempts, bound, and each attempt's outcome and code. It keeps provider acceptance, delivery and inbox arrival as three fields. It carries no address, title or message text.

### The runner's check of a saved message

One function (`savedProblems` in `probe.ts`) judges every message the simulated binding saved, from three readings that must agree. The log may carry only `From`, `To`, `Subject` and `Text` lines, so a `Cc`, `Bcc`, HTML part or attachment is refused. The simulator's sent-mail store (the local explorer's `/cdn-cgi/explorer/api/local/email/sending`, which keeps `cc`, `bcc`, `replyTo` and `headers` where the log does not) must hold a row with exactly the fields `attachments`, `from`, `messageId`, `sentAt`, `subject`, `text`, `to` and `worker`, with one recipient and no attachment, saying what the log says. A store that cannot be read fails the run. Then the message passes the content check above. `bun run --bun adverse` patches the one `send.send(message)` call site after the Worker's own check to add a `cc`, `bcc`, `replyTo` or `X-Case` header, and requires the run to fail in that check, the saved-message check, itself: an adverse run that fails some other assertion is not counted as caught. All four were caught at the product head (`replyTo` and the header are visible only in the store).

## Acceptance items

| GRS-111 acceptance item | Local leg | Cloud leg (M3) |
| --- | --- | --- |
| Start with the Workers Paid route, current primary documentation and disposable synthetic recipients | **PASS**: one `send_email` binding per client Worker restricted by `allowed_sender_addresses` (`binding-config`); reserved `.test` addresses only; the error codes and binding fields re-read on 21 October 2026 | **HOLD**: no Paid account |
| Resolve the Paid qualifier, selected-route against core checks, the pricing and binding conflicts, and actual SPF, DKIM and DMARC evidence | Settled for the simulator only: it enforces `allowed_sender_addresses` (`sender-restriction`), GRS-103's unresolved fact 7 | **HOLD**: every item needs the account and the zone |
| Investigate the provisional branding, per-client sender subdomain and preview-off defaults | **Investigated**, provisional ([below](#provisional-defaults)) | **HOLD**: the subdomain records, the preview setting and its scope |
| Minimal publication and input-needed notices to the uploader, authenticated links only, no case text, sensitive identifiers or attachments; acceptance, delivery and inbox arrival kept apart | **PASS**: `publication-notice`, `input-needed-notice`, `authenticated-link`, `content-refused`, `wrong-client`, `no-leak`. Each saved message records provider acceptance (simulated), delivery (HOLD) and inbox arrival (HOLD) as separate fields | **HOLD**: real acceptance, `message.delivered`, inbox and spam placement |
| Bounded retry, operator visibility, possible ambiguous duplicates; email failure leaves publication, files and in-app state intact; no Queues | **PASS**: `retry-bounded`, `ambiguous-duplicate`, `interrupted-send`, `permanent-no-retry`, `operator-visibility`, `recipient-missing`, `binding-missing`, `app-deduplication` | **HOLD**: real `E_*` responses and their timing |

## Legs

All PASS at `0493a66d`, offline, in one run of 19 s ([summary](evidence/notifications-summary.json)).

| Leg | What it asserts |
| --- | --- |
| build | Bun builds one module that imports nothing and carries the HEAD stamp; a second build of the same source and stamp has the same digest, which is recorded as `artifact` and recomputable from a checkout |
| binding-config | `wrangler d1 execute --local` applies [`schema.sql`](../../../tests/hosting-probe/notifications/schema.sql) (synthetic clients A and B). Wrangler, on Node, starts native workerd. It lists `env.EMAIL` as a local Send Email binding restricted to client A's sender, and D1 and R2 as local; no binding is remote. `/health` sees `DB`, `BUCKET` and `EMAIL.send` and reports the HEAD stamp |
| publication-notice | publishing answers 200 with the file digest; the notice is sent once and the binding returns a `messageId`. Exactly one message is saved, the one the app recorded: from client A's sender to the uploader alone, the generic subject, the template around one link to this notice, and in the log and the sent-mail store no field beyond from, to, subject and text (no cc, bcc, replyTo, header, HTML part or attachment). Delivery and inbox arrival are reported as not observed |
| input-needed-notice | the same for the input-needed template, with its own notice id |
| authenticated-link | the link alone answers 401 with no redirect; client B's session 401; another client A user 404; the uploader 303 to the case. The uploader then sees the publication, reads the file byte for byte, and sees the two in-app notices the emails link to |
| app-deduplication | publishing the same version again returns the same notice and sends nothing; other content under the same version answers 409; file, publication and notices are unchanged. Two concurrent publishes of one version with different files: one answers 200 and the other 409, and the file served is the one the publication names, with one in-app notice and one email |
| wrong-client | client B's case is not found through client A's instance though its row is in the same store (404); client B's publisher gets 401 on A's publish and operator routes; nothing is saved |
| content-refused | a case titled "New results", which is template wording, has its notice refused by the Worker's own check, with no retry; the publication, file and in-app notice are intact |
| recipient-missing | an uploader with no address fails closed (`RECIPIENT_MISSING`), with no retry; the publication is intact |
| interrupted-send | an attempt left `sending` by a Worker cut off mid-send (seeded with `wrangler d1 execute`) is settled by the next sweep as ambiguous (`INTERRUPTED`) and retried; the retry is accepted and the notice marked a possible duplicate |
| retry-bounded | `E_RATE_LIMIT_EXCEEDED` three times: attempt 2 is due 5 minutes after attempt 1 and attempt 3 30 minutes after attempt 2, and a sweep before an attempt is due sends nothing. After attempt 3 the notice is failed with acceptance refused, and a later sweep makes no fourth attempt. Nothing is saved; publication, file and in-app notice are intact |
| ambiguous-duplicate | case A3: the binding saves the message, then the Worker sees `E_INTERNAL_SERVER_ERROR`; the retry is accepted, so two copies of the same generic notice are saved under two provider `messageId`s, a real duplicate. The operator view marks it a possible duplicate and knows only the second `messageId`; the uploader has one in-app notice. Case A4: no answer within the timeout is ambiguous too, and its retry is accepted |
| permanent-no-retry | `E_RECIPIENT_SUPPRESSED` fails after one attempt; no sweep retries it |
| operator-visibility | a client user who is not an operator gets 403. The operator sees all five notices of the faults run with attempts and codes; failed notices and possible duplicates are listed, and the view carries no address, title or reference |
| sender-restriction | three misconfigurations of client A's Worker, each with the publication, its file and the in-app notice intact and nothing saved. `SENDER` is client B's address, or `APP_ORIGIN` is client B's: the Worker's own check refuses before the binding (`NOTICE_CONTENT_REFUSED`, permanent). The binding allows only client B's sender: the local binding refuses the send (`email from … not allowed`), recorded as permanent |
| binding-missing | the same Worker without its `send_email` binding starts, `/health` reports `EMAIL` absent, and publishing answers 200 with the notice failed closed (`EMAIL_BINDING_MISSING`) |
| no-leak | the run saved exactly seven messages, all plain text with no attachment, each passing the check of a saved message for its own case. No saved message, in the log or the sent-mail store, carries any case's title, reference, id, document title, file name or file text, or any address but the uploader's, and the store holds no row the log did not show. The synthetic Authorization and cookie canaries sent on every request appear in no saved message, Wrangler log or operator response |

## Provisional defaults

GRS-93 (16 October 2026) accepted these as the initial profile "at this point", for investigation here. None is a fixed product constraint.

- **ClearCase branding.** The subject and body say ClearCase and nothing about the client, case or firm. The probe's `from` is a bare address. A display name ("ClearCase", or the firm's name) is an open choice: the firm's name is not case content, but it tells anyone reading the mailbox which firm the uploader works with. HTML, images and tracking pixels are left out: the plain-text body is enough for one link, and every extra part widens the content check.
- **One sending subdomain per client.** Each client Worker gets its own binding, restricted with `allowed_sender_addresses` to its own sender; the probe proves the local restriction refuses another client's sender. A subdomain per client gives each client its own bounce and complaint suppressions and per-domain events. Each needs onboarding records (MX, SPF and DKIM on `cf-bounce.<domain>`, and `_dmarc.<domain>`), and a zone holds at most 30 Routing and Sending domains together, so the GridShift zone caps the count. A shared sending subdomain is simpler but mixes reputation and suppressions across clients. The names under `sandbox.gridshift.co.za` are for the M3 owner to choose.
- **Full-message preview off.** Email preview keeps the whole message for about seven days and is on by default for new sending domains. These messages carry only the template, one opaque link and the uploader's address, so a preview exposes little; turning it off still removes a store of recipient addresses. Whether it can be turned off per sending domain, through which API or tool, and what an account token can read are UNRUN (GRS-103 proof 8) and wait for M3.

## Findings for GRS-137

- The local binding enforces `allowed_sender_addresses` and the destination restrictions. It throws plain errors without a `code` (`email from <address> not allowed`), so the policy matches their text locally. Which code the real binding throws for a sender outside the list is unknown until M3.
- The local binding saves each message as `.wrangler/tmp/email/<session>/email-text/<messageId>.txt` beside `wrangler.toml` and logs the path after `send()` resolves. Wrangler deletes the session directory at shutdown, so a test must read the files while the server runs.
- `GET /cdn-cgi/local/scheduled?cron=…&time=<ms>&format=json` fires the `scheduled` handler with a chosen `scheduledTime`, without `--test-scheduled`.
- Named Wrangler environments inherit none of `vars`, D1, R2 or `send_email`; each must redeclare them.
- Wrangler's binding table prints a sender-restricted binding as `unrestricted - senders: …`; "unrestricted" refers to the recipients.
- The denylist scans the subject and body and fails closed: a case whose title is template wording ("New results") gets no email, only its in-app notice, and the operator sees `NOTICE_CONTENT_REFUSED`. A case word that occurs only in an address does not refuse a notice. A case word that the subject or body template contains ("New results", "Sign in", a single letter) refuses it permanently, without a retry; the product could check a case against the templates once, when the case is created.
- The first attempt runs inline, so the publish response waits for it, at most `SEND_TIMEOUT_MS` (10 s by default; a value that is not a positive number of at most 60 s is the default, because `Number()` of it would be NaN, a 0 ms timer that marks every send a timeout while it may have sent, and a value past 2^31 - 1 ms fires at once too). The product may prefer to move it to `waitUntil` and report the notice state from the outbox.

## Residuals for GRS-137

Found in review and not probed: the product's own sweep design must settle them.

- **Starvation.** The sweep takes the 50 oldest due rows (`ORDER BY o.updated_at LIMIT 50`). A row that is due and can never be settled stays first in the queue, and 50 of them starve every other row.
- **A deleted case.** `attempt` returns before it claims anything when the case row is gone, so such a row stays due and first in the queue (the previous point) forever. The probe has no deletion path.
- **Swallowed errors.** A D1 error in the first attempt or in a sweep step is caught so that it cannot fail the publication or stop the rows after it, and is written to the Worker's log as one `notification-error` line (the notice id and the error's name, never its message). D1 may be what failed, so the outbox row cannot record it; the row stays as it was and the next sweep takes it. No leg makes D1 fail, so this is not probed, and the log is not yet an operator view.

## What stays HOLD

These are the cloud legs at moment M3, owned by `dianbrown`, on Workers Paid, with a sending subdomain under `sandbox.gridshift.co.za` in the GridShift zone and its own `_dmarc` record. They run before GRS-137.

- **Provider acceptance against delivery and inbox arrival.** A resolved `send()` with a `messageId`, then `message.delivered` or the Activity log's Delivered status, then inbox or spam placement checked by hand in an operator-owned mailbox. Locally only acceptance by the simulator is observed. An event source for delivery (Queues event subscriptions or GraphQL analytics) is not adopted and is a GRS-137 decision with evidence.
- **SPF, DKIM and DMARC** in the received headers of a real message from the onboarded sending subdomain.
- **`allowed_sender_addresses`** enforced by the real binding, and the code it throws.
- **The Paid qualifier and the Free conflict.** Whether arbitrary-recipient sending needs Workers Paid on this account, and whether Workers Free can send at all: the pricing page's plan table lists outbound email as unavailable on Free while its prose calls verified-destination sends free on all plans.
- **Real failure responses.** The `E_*` failures here come from the faults double; their real timing and the soft-bounce retry schedule are unknown until M3.
- **Follow-ups:** run this probe from `gate:hosted` (a shared-file change); decide the display name, the subdomain names and the preview setting at M3; reconcile ambiguous sends against provider events once an event source is chosen.
