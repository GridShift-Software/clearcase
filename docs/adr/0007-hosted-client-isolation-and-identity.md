---
status: accepted
date: 2026-10-14
---

# Hosted client isolation and identity

On 14 October 2026 the user set the client boundary for the hosted alpha ([Define client instances, membership and case permissions](https://linear.app/vaper/issue/GRS-85/define-client-instances-membership-and-case-permissions)). The local app was only a proof of concept for aligning with clients; it does not set the hosted model.

- **A client is a law firm.** Each firm has several users and several cases. An individual becomes a client with one user. The alpha starts with one or two clients.
- **One client instance per client.** Each client gets its own instance and subdomain. Databases, files and secrets are fully isolated between clients. All instances run one maintained codebase, not a fork per client. In the user's words: "yes, full isolation between clients, maybe only a shared processing queue for us".
- **Cases are assigned.** A user sees only the cases assigned to them, not every case in the firm. Client membership or a management role does not reveal all case contents.
- **Case viewers and editors.** Each assignment is explicit and per case. A viewer reads and downloads. An editor also maintains user work. Neither edits originals or published analysis, so clients edit user work, not results.
- **Two admin levels.** The Global Admin is the service team's account and role for managing client instances and their administrators. Firm admins manage their own client's users and case assignments.
- **Audited access for the service team.** Operators need explicitly granted, audited access to client instances. The Global Admin likewise needs explicit, audited access to case contents. Admin management does not imply either.
- **Clerk provides authentication.** The user chose Clerk for a route to enterprise customers and single sign-on: "yes, we will use clerk for auth as it give us a way into enteprise and the wierd sso if needed". [ADR-0008](0008-workers-runtime-and-cloudflare-first-stack.md) refines this into one Clerk application per client and a separate internal one, invite-only enrollment and MFA behind an initially-off flag.

User answers of 14 October behind the access rules: "yes, but we have a GA account to do admin management" (service-team account for admin management), "yes" to viewer and editor grants, "yes" to audited operator access, and "yes" to the Global Admin and firm admin split. The rationale is least access: management roles and the service team reach case contents only through explicit, audited grants.

This resolves two of the open questions in the [product brief](../product-brief.md#delivery-sequence-and-remaining-unknowns): "client" means a firm, with an individual as a one-user client, and clients may edit user work.

Considered option: one shared multi-tenant deployment holding every firm's data. The user chose full isolation, which keeps the brief's earlier direction of a separate deployment and data boundary per client.

## Resolved since 14 October

These points were open when this record was accepted. Later records settle them; this record is not rewritten.

- **Shared processing queue.** One processing queue spans clients and holds coordination metadata only; case contents still need audited operator access ([ADR-0009](0009-manual-queue-and-candidate-import-contract.md)).
- **Clerk setup.** Separate client and internal Clerk applications, invite-only alpha and MFA initially off ([ADR-0008](0008-workers-runtime-and-cloudflare-first-stack.md)).
- **Infrastructure.** One Cloudflare account with a separate Worker, D1 database, R2 bucket, secrets and subdomain per client ([ADR-0008](0008-workers-runtime-and-cloudflare-first-stack.md)). Its proofs are UNRUN.
- **Publication mechanics.** Exact-version sign-off by an authorized publisher, who may be the preparer for alpha ([ADR-0010](0010-exact-version-signoff-and-publication.md)).

## Still open

- **Audit implementation.** What is logged, where it is kept, who may read it, how access is granted and expires, and how it is enforced. The audit owner ([GRS-116](https://linear.app/vaper/issue/GRS-116/implement-permission-scoped-audit-events-and-audit-views)) freezes the event contract; audit visibility stays scoped by role and case.
- **SSO.** Whether any client uses SSO in alpha, and current Clerk SSO features and pricing.

## Consequences

This record does not authorise hosted implementation, production changes or the transfer of real case data by agents. Dependent implementation waits for approval of the complete hosted-alpha plan ([GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha)).

Affects GRS-85.
