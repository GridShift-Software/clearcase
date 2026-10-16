# GRS-103: Cloudflare-first transactional alpha notifications

Research for [GRS-103](https://linear.app/vaper/issue/GRS-103), feeding the notification and failure items of [GRS-93](https://linear.app/vaper/issue/GRS-93). Base `b93bad097fdd`. Sources were read on 16 October 2026. Labels:

- **[F]** documented fact;
- **[S]** read in published package source, not executed;
- **[I]** inference;
- **[R]** recommendation;
- **[U]** unknown.

**UNRUN** means there is no execution evidence. "Not found" means absent from the pages and source searched; it does not claim the feature is missing.

Scope. Alpha sends a minimal transactional email to the uploader (an invited client user) of one client instance when a publication is ready or input is needed. The email carries a secure app link only: no case text, sensitive case identifiers or attachments. Topology: one owned Cloudflare account; per client a subdomain, Worker, D1, R2, secrets and a Clerk application; a separate staff Clerk application. There is no live Outlook or Gmail connector.

Decision state. From [GRS-93](https://linear.app/vaper/issue/GRS-93), only the in-app notification plus a minimal email to the uploader (channel and contents) is accepted. All four recovery questions are still **pending user decisions**: the four staffed hours, the one hour of recent edit loss with originals recoverable, the 30-day recovery window, and the email-failure policy (question 4). Everything below that depends on the email-failure policy is conditional on the option the user selects. The shared Cloudflare account and its operators are the accepted topology; this note does not widen it to cross-client access for app users.

Nothing was provisioned, logged in, sent or executed. The `cf` 1.0.0-beta.17 and `void` 1.1.11 npm tarballs were downloaded to a scratch directory and read as text. No item below is a runtime PASS.

## Recommendation and constraints

1. **Cloudflare Email Sending fits this scope technically [I]; sending to arbitrary recipients needs Workers Paid [F][P1][O1].** It is a public beta since 16 April 2026 [F][CH]. Which route to use is item 2, a pending user decision.
   - Each client Worker gets its own `send_email` binding and calls `env.EMAIL.send()` [F][W1].
   - Restrict each binding with `allowed_sender_addresses` to that client's sender [F][B1].
   - Sending to arbitrary recipients needs Workers Paid and an onboarded sending domain [F][O1][L1].
2. **Route: Paid arbitrary-recipient sending is the recommendation [R], pending the user's cost and onboarding decision.** The free verified-destination route is not ruled out.
   - **Free verified destinations** are free on every plan [F][P1]. At one or two clients' alpha scale they are workable [I], but they add steps:
     - each recipient must click a verification email from Cloudflare, an extra verification step outside the app [F][D1];
     - the address list is account-wide, shared by every client, and capped at 200 [F][D1][L1];
     - the sender must be on an Email Routing domain [F][L1];
     - Clerk's email verification does not add an address to that list. Nothing found links the two [I].
   - **Paid** removes the per-recipient click and the 200 cap, at the $5 per month minimum if the account is not already on Workers Paid [F][P1][WP].
   - **Unresolved documentation conflict [U].** The pricing page's plan table lists outbound email as "Unavailable" on Workers Free, while its prose says verified-destination sends are free on all plans [P1]. Proof 3 settles it for this account on the day it runs. It is evidence, not a runtime guarantee, because the beta can change.
   - Open question: the user's choice between the two routes, weighing monthly cost against onboarding friction for invited uploaders.
3. **Provider acceptance, MX acceptance and inbox placement are three different facts [F].**
   - A resolved `send()` returns only a `messageId` [F][W1].
   - `message.delivered` and the "Delivered" status mean the recipient mail server accepted the message [F][E1][LG].
   - Cloudflare says there is "no guarantee it reaches the recipient's inbox" [F][DV]. Spam-folder placement is not reported by any source found.
   - Proposed [R]: the in-app status stays authoritative. This is a recommendation; the accepted GRS-93 answer covers only the in-app plus minimal-email channel and contents. What happens when an email fails is item 8.
4. **No idempotency key was found for Email Sending [F].** `Message-ID` is platform-set and cannot be supplied [F][H1].
   - Void's `idempotencyKey` applies only on the Void Platform, which is not adopted [F][VS].
   - A thrown `E_INTERNAL_SERVER_ERROR`, a REST 500 or 503, or a Worker interrupted mid-call leaves acceptance unknown [I].
   - Retrying after any of those can send a duplicate [I].
   - A notification ID can only be an app-side key. It deduplicates the app's own outbox and consumers but cannot guarantee exactly-once delivery to the recipient [I].
5. **Cloudflare metadata about recipients is account-level, not per client, in the documented APIs [F][I].** The shared account and its operators are the accepted topology, so this is not app-client cross-access. The sources document:
   - suppressions: an account-level API that needs **Email Sending: Edit** [F][SC];
   - verified destination addresses: an account-wide list [F][D1];
   - analytics: per-event sender, recipient, subject and message ID, held for 31 days [F][M1];
   - the Activity log, whose **Email preview** keeps the full message for about seven days and is on by default for new sending domains [F][DM][LG];
   - event payloads, which carry recipient and subject [F][E1].

   What is **unknown [U]** is whether narrower token or zone scopes can limit any of these to one client's sending domain (unresolved fact 6). Who can read them in practice depends on the account and zone roles issued, which are an operator matter. Proof 8 records it. Two consequences follow [R]:
   - Keep subjects generic, and make the link require the client's Clerk sign-in rather than carry a bearer secret.
   - Decide whether to turn off Email preview per sending domain (pending decision in the next section).
6. **Use cf, or the plain binding, for configuration; do not adopt Void's email layer [S][R].**
   - cf beta.17 has a `bindings.sendEmail` builder with sender and recipient restrictions, and `email-sending` and `queues subscriptions` commands [S][CF1][CF2].
   - Void 1.1.11 writes its `send_email` binding with no restriction attributes [S][V0].
   - Void's email setup also takes over Email Routing [F][VD], and its dev inbox returns `BINDING_MISSING` under SvelteKit [F][VS].
   - Wrangler is needed only if cf proofs fail (proof 9).
7. **No low-cost alternative was compared [R].** No Cloudflare gap found blocks this scope.
   - The missing idempotency key matters less here, because a duplicate email carries only a link [I].
   - The beta status, the unpublished daily quota and the account-level metadata are risks to accept or reject, not blockers.
   - Compare one alternative only if proof 4 or 5 fails, the account cannot get the entitlement (`10105 not_entitled`) [F][R1], or proof 8 shows metadata exposure the user will not accept.
8. **The email-failure policy is a pending user decision: GRS-93 recovery question 4, proposed and not accepted.** The proposal is that a failed email leaves publication available, is retried a bounded number of times, and is shown to operators. Until the user answers, no behaviour below is accepted. The facts allow at least two shapes:
   - **At most once.** Mark an ambiguous send `unknown` and show it to operators without resending. There are no duplicates, but an email can be missed.
   - **At least once.** Retry ambiguous sends a bounded number of times and accept a possible duplicate link email. Any notification ID is app-side only (item 4).

   Whatever is chosen, reconciliation of ambiguous sends is best effort [I]. Events and analytics are keyed by `messageId`, which an ambiguous send does not have. Matching on recipient, subject and time is unreliable when subjects are generic, so some sends may stay `unknown` (proof 7).

## Pending decisions and proof owners

All of these are pending. This note makes no decision. Each proof is owned by the future implementing ticket (to be named), and each is UNRUN.

| Decision | Options | Evidence that informs it | Decided by |
| --- | --- | --- | --- |
| Sending route | Paid arbitrary recipients, or free verified destinations at alpha scale | Proofs 3 and 4 | User: cost and onboarding |
| Sender domains and branding | One shared sending domain, or one per client; the visible From name and address | Proofs 5 and 6 (bounce scope, per-domain events); 30-domain-per-zone limit | User |
| Preview retention | Email preview on (about 7 days of stored messages) or off per sending domain | Proof 8 | User |
| Retry, missed or duplicate email | GRS-93 question 4: at most once, at least once, or another bounded policy | Proofs 2 and 7 | User |
| Event delivery for reconciliation | Cloudflare Queues event subscriptions, or GraphQL analytics only | Proofs 6 and 7 | Implementing ticket, with evidence |

Event subscriptions deliver only to Queues [F][E1]. Adopting Queues is an implementation choice that needs evidence. It is not adopted here, and it is not by itself a new human permission wall. GraphQL-only reconciliation is the alternative, limited to the 31-day retention and to polling [F][M1].

## Capability and cost

| Topic | Finding | Labels |
| --- | --- | --- |
| Availability | Sending is public beta and needs Workers Paid. Routing works on Free and Paid. No GA date, SLA or uptime statement was found. | [F][O1][CH] |
| Free route | Verified destinations are described as free on every plan. They count toward neither the monthly quota nor the daily limits, and are capped at 200 per account. Each recipient must click Cloudflare's verification link. The same pricing page's plan table lists outbound email as "Unavailable" on Workers Free: an unresolved conflict [U] for proof 3. | [F][U][P1][L1][D1] |
| Onboarding | The domain must use Cloudflare DNS. Onboarding adds MX, SPF and DKIM records on `cf-bounce.<domain>` and a DMARC record on `_dmarc.<domain>`; the documented example is `p=reject`, while the domains page recommends `p=none` for a new setup. Do not overwrite an existing DMARC record blindly; unresolved fact 8 covers it. Those records stay locked while the domain is configured. Each subdomain is a separate sending domain. A zone holds at most 30 Routing and Sending domains combined. | [F][O1][DM][SD][L1] |
| Per-client configuration [R] | Use one binding per client Worker, restricted with `allowed_sender_addresses`. A shared sending domain is simpler. One sending subdomain per client gives separate bounce and complaint suppressions and per-domain event subscriptions, but counts toward the 30-per-zone limit. Sender domains and branding are a pending user decision. | [F][B1][S1][E1] |
| Price | 3,000 outbound emails per month are included per account, then $0.35 per 1,000. Hard bounces count. Messages rejected at the API, including suppressed ones, do not. | [F][P1] |
| Idle cost | No email charge without sends. Workers Paid has a minimum of $5 per month per account. If the stack already needs Workers Paid, email adds no idle cost [I]. | [F][P1][WP] |
| Event cost | Only if Queues are adopted: 1,000,000 operations per month included on Paid, then $0.40 per million, at about 3 operations per message. This is negligible at alpha volume [I]. | [F][QP] |
| Daily limit | Applies per account and starts conservative, but no number is published. One client's burst uses the whole account's quota [I]. Increases go through a request form. | [F][L1] |
| Message limits | 50 recipients per message, 5 MiB total, 16 KB of custom headers. `X-` headers are allowed. Marketing email is not allowed. | [F][L1][H1][FQ] |
| Suppression | Hard bounces suppress for 7 days, or with no expiry when the mailbox or domain does not exist. Soft bounces suppress for 24 hours. Complaints never expire. Bounce and complaint entries are scoped to the sending domain. With "Drop suppressed recipients" off (the default), a send to a suppressed recipient throws `E_RECIPIENT_SUPPRESSED`. | [F][SC][DM] |
| Retries | Cloudflare retries soft bounces (4xx) with exponential backoff and does not retry hard bounces (5xx). The schedule and maximum retry period are not published. | [F][U][LC] |
| Visibility | Six events per sending domain: `delivered`, `deferred`, `bounced`, `failed`, `rejected` and `complained`. Activity log statuses are Sent, Delivered, Delivery failed, Rejected and Failed. GraphQL keeps 31 days. Event subscriptions deliver only to Queues, which deliver at least once. | [F][E1][LG][M1][QD] |
| Binding result | The binding returns `{ messageId }` or throws an `E_*` code. The REST API also returns `delivered`, `queued` and `permanent_bounces` per recipient. | [F][W1][R1][AR] |
| Local test | Without `remote`, `wrangler dev` simulates the binding: it logs and saves the message and sends nothing. With `remote: true`, it sends real email. | [F][LD] |

## Tooling: cf, Void and Wrangler

- **cf 1.0.0-beta.17 [S][CF1][CF2].**
  - `bindings.sendEmail` maps `destinationAddress`, `allowedDestinationAddresses` and `allowedSenderAddresses` to the Wrangler fields. Wrangler-config migration carries `send_email` across.
  - Commands that touch Email Sending:
    - `email-sending`: `send`, `send-raw`, `get <message-id>`, `limits get` and `reputation get`;
    - `email-sending subdomains`: `create`, `get`, `update`, `delete`, `preview` and `dns get|status|fix`;
    - `email-sending suppressions`: `list`, `create`, `edit`, `import` and `delete`;
    - `queues subscriptions create|update|delete`.
  - The public API reference lists `send`, `send_raw`, suppressions and zone sending subdomains [AR]. No published endpoint was found for `get <message-id>`, `limits` or `reputation`, so their output is **[U]**.
  - GRS-102's beta caveats (pinning, Node host, `--dry-run` coverage) apply unchanged.
- **Void 1.1.11 [S][F].**
  - Direct-Cloudflare email needs `email.from` and `void email setup`. That sets up Email Routing and Email Sending on the sender's domain, with a token holding Email Routing Edit and Email Sending Edit [F][VD][VC].
  - Its adopted-binding Wrangler patch writes `send_email` with no restriction attributes [S][V0]. Whether an override can add them was not traced.
  - SvelteKit gets no dev inbox [F][VS].
  - `void email logs` and `void email usage` apply to Void platforms only [F][VD].
  - Using `void/email` would adopt the Void SDK, which is not requested.
- **Wrangler.** Wrangler is needed only if cf proofs fail: for example, if cf cannot onboard a sending domain or create the queue subscription, or the adapter's local simulation needs Wrangler config (proofs 1 and 9). The dashboard and REST API remain alternatives for one-time onboarding [F][O1][AR].

## Unresolved facts

1. The account's actual daily sending limit and how it grows [U][L1]. `cf email-sending limits get` may report it (UNRUN).
2. A documentation conflict on arbitrary recipients: the send-bindings page says an unrestricted binding sends "to any verified destination address in your account" [B1], while the limits page says that after onboarding "you can send to any recipient immediately" [L1]. Proof 4 settles it.
3. The soft-bounce retry schedule, its maximum, and when `deferred` becomes `bounced` [U][LC][E1].
4. What the binding does when a Worker is interrupted or times out mid-`send()`, and whether a thrown `E_INTERNAL_SERVER_ERROR` can follow an acceptance [U].
5. The region and residency of sending logs, previews, analytics and events: not found.
6. The **Email Sending: Edit** permission group is named in [SC] and [SM] but missing from the permissions reference [T1]. The suppression API is documented as account-level; whether a narrower token or zone scope exists, and whether a token can be limited to one sending domain, is unknown [U].
7. Whether local simulation through the adapter or Miniflare enforces sender and recipient restrictions [U][LD].
8. How onboarding a client subdomain interacts with an existing apex DMARC record. The domains page's example uses `p=reject`, but it recommends `p=none` for new setups [F][DM]. Void's docs warn that existing DMARC or bounce records can block onboarding [F][VD]. Cloudflare's behaviour for subdomains is [U]; do not overwrite an existing record without checking it.
9. The end of the beta, and whether prices or limits change at GA [U][CH].
10. The pricing page's plan table (outbound "Unavailable" on Workers Free) against its prose (verified-destination sends free on all plans) [U][P1]. Proof 3 settles it for this account at one date only.

## Future proofs (all UNRUN)

The planning phase authorizes no emails, sends or account changes. The future implementing ticket's authorized scope should cover one controlled batch of owned-inbox proofs, so that no separate approval is needed per proof or per send. Any billing or plan change outside the authority that ticket already holds needs the applicable approval; no standing approval flow is assumed here. Use only synthetic content. Reserved `example.test` names are for offline proofs 1 and 2 only. Proofs 3 to 8 use real domains and inboxes that operators own, because `.test` cannot receive mail and onboarding needs a zone on Cloudflare DNS [F][O1]. Record each proof as PASS or FAIL at an exact SHA with a receipt.

Branch on the approach chosen. If the user or ticket rejects an option (Queues event subscriptions, the free route or the Paid route), the proofs that depend only on it are skipped, not failed; all nine are not mandatory.

1. **Local synthetic send. UNRUN.** Kit 3 app with a cf `bindings.sendEmail` binding (or the adapter's platform proxy) in an offline network namespace.
   - A publication or input-needed event produces one simulated message.
   - The saved message contains only a generic subject and an app link; a scanner finds no case fields.
   - A sender outside `allowed_sender_addresses` is rejected, which settles unresolved fact 7.
2. **Outbox classification. UNRUN.** Fake binding that throws each `E_*` code.
   - The proof asserts the policy the user selects for GRS-93 question 4, not an assumed one. Publication availability, retry count and operator display are checked against that selection.
   - Each code maps to retry, permanent or ambiguous under that policy.
   - An app-side notification ID keeps the app's own queue consumers idempotent. It makes no claim about exactly-once delivery to the recipient.
3. **Free verified-destination delivery. UNRUN.** Only if the free route is still under consideration.
   - Deploy a test Worker that sends from a test Routing domain that operators own to an operator-owned, verified Gmail address and Outlook.com address.
   - Record the `messageId`, Activity log status, SPF, DKIM and DMARC results in the received headers, and inbox or spam placement by hand.
   - Record whether a send on the Workers Free plan succeeds, which settles unresolved fact 10 for this account on that date.
4. **Paid arbitrary-recipient send. UNRUN.**
   - Ensure the account is on Workers Paid (upgrade only if it is not already), and onboard a sending subdomain on an operator-owned zone.
   - Send to an unverified operator-owned address. This settles unresolved fact 2.
   - Read `cf email-sending limits get` for unresolved fact 1, and confirm the quota counts the send.
5. **Bounce and suppression scope. UNRUN.**
   - Send to a non-existent mailbox on an operator-owned domain.
   - Expect `message.bounced` with type `hard`, a suppression scoped to the sending domain, and `E_RECIPIENT_SUPPRESSED` on the next send.
   - A second synthetic client's sending domain is unaffected.
6. **Per-client event isolation. UNRUN.** Only if Queues event subscriptions are chosen.
   - Create one queue subscription per sending domain with `cf queues subscriptions create`.
   - Client A's consumer receives only A's events.
   - A replayed `eventId` is deduplicated.
7. **Reconciling ambiguous sends. UNRUN.**
   - For sends from proofs 3 to 5, find each event in GraphQL `emailSendingAdaptive` by `messageId`, and also by recipient, subject and time window without the `messageId`.
   - Record how often the second method is ambiguous with generic subjects, and which sends stay unreconciled.
   - Measure how long after a send its event appears. The event leg runs only if proof 6 ran.
8. **Control-plane visibility. UNRUN.**
   - For each planned token role, record whether it can read suppressions, analytics recipients and subjects, previews and destination addresses, and whether any narrower scope exists.
   - Confirm that turning preview off stops message storage.
   - Settles unresolved facts 6 and 8.
9. **cf coverage. UNRUN.**
   - `cf email-sending subdomains create` and `dns status`, a `--prebuilt` deploy with the `send_email` binding, and `queues subscriptions create` if Queues are chosen, each `--dry-run` first.
   - Use Wrangler, the dashboard or REST only for steps that fail.

## Sources (read 16 October 2026)

- [O1] https://developers.cloudflare.com/email-service/ (updated 15 October 2026) and https://developers.cloudflare.com/email-service/get-started/send-emails/ · [P1] https://developers.cloudflare.com/email-service/platform/pricing/ (updated 9 June 2026) · [L1] https://developers.cloudflare.com/email-service/platform/limits/ (updated 25 September 2026)
- [B1] https://developers.cloudflare.com/email-service/configuration/send-bindings/ · [W1] https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ · [R1] https://developers.cloudflare.com/email-service/api/send-emails/rest-api/ · [AR] https://developers.cloudflare.com/api/resources/email_sending/ (all updated 15 October 2026 except [AR], undated)
- [DM] https://developers.cloudflare.com/email-service/configuration/domains/ · [SD] https://developers.cloudflare.com/email-service/configuration/subdomains/ · [D1] https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#destination-addresses · [SM] https://developers.cloudflare.com/email-service/get-started/send-emails/ (SMTP section)
- [LC] https://developers.cloudflare.com/email-service/concepts/email-lifecycle/ · [SC] https://developers.cloudflare.com/email-service/concepts/suppressions/ and https://developers.cloudflare.com/email-service/configuration/suppressions/ · [DV] https://developers.cloudflare.com/email-service/concepts/deliverability/ · [H1] https://developers.cloudflare.com/email-service/reference/headers/ · [FQ] https://developers.cloudflare.com/email-service/reference/faq/
- [E1] https://developers.cloudflare.com/email-service/reference/event-subscriptions/ · [LG] https://developers.cloudflare.com/email-service/observability/logs/ · [M1] https://developers.cloudflare.com/email-service/observability/metrics-analytics/ · [LD] https://developers.cloudflare.com/email-service/observability/local-development/sending/ · [CH] https://developers.cloudflare.com/email-service/platform/changelog/ (entries 16 April to 25 September 2026) · [S1] the suppression scope entry of 25 September 2026 in [CH]
- [WP] https://developers.cloudflare.com/workers/platform/pricing/ (updated 2 October 2026) · [QP] https://developers.cloudflare.com/queues/platform/pricing/ · [QD] https://developers.cloudflare.com/queues/reference/delivery-guarantees/ · [T1] https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (updated 12 October 2026)
- [CF1] https://developers.cloudflare.com/cf/projects/cloudflare-config/ (builder table, updated 29 September 2026) · [CF2] `cf-1.0.0-beta.17.tgz` from https://registry.npmjs.org/cf/1.0.0-beta.17, read as text: `dist/_meta/commands.json`, `dist/wrangler-migration-*.mjs` and `dist/containers-*.mjs`
- [V0] `void-1.1.11.tgz` from https://registry.npmjs.org/void/1.1.11, read as text: `dist/wrangler-*.mjs` (`upsertAdoptedBinding("send_email", …, {})`), `schema.json` (`email.from`) · [VD] its `docs/guide/email/domains.md` · [VS] its `docs/guide/email/sending.md` · [VC] its `docs/integrations/cloudflare.md`, published as https://void.cloud/integrations/cloudflare
- Context: GRS-93 of 16 October 2026, where only the in-app plus minimal uploader email (channel and contents) is accepted and recovery questions 1 to 4, including the email-failure policy, are pending; GRS-86 resolution; `docs/research/grs-102-cf-void-agent-tooling.md` on `origin/research/grs-102-cf-void-agent-tooling`.
