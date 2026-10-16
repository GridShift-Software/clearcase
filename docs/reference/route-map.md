# v5 navigation against the production routes

Acceptance item 7 of GRS-9. The 42 v5 navigation entries are the local parity target. The production browser audit of 8 October 2026 inspected 55 distinct workspace routes in a hosted test case (33 main navigation destinations plus secondary tabs and linked views) over the newer 2,131-row export. The two inventories are different and **the counts are not equated**: 55 routes are not 55 V1 commitments, and a v5 view without a production route is still in V1 scope.

**Hosted alpha update, 16 October 2026.** The *Hosted alpha owner* column names the Linear issue that delivers each route for the hosted alpha, from the coordinator's planning snapshot at `b93bad0`. The classification column keeps the 8 October reading as history; where it says `deferred` or `v2-owned`, the owner column supersedes it. Hosted view owners are [GRS-131](https://linear.app/vaper/issue/GRS-131/migrate-overview-chronology-evidence-and-analysis-views-to-hosted) (overview, evidence and analysis), [GRS-132](https://linear.app/vaper/issue/GRS-132/migrate-quantum-and-case-registers-to-hosted-contracts) (quantum and registers), [GRS-133](https://linear.app/vaper/issue/GRS-133/migrate-litigation-and-existing-bundle-workspaces-to-hosted-contracts) (litigation and bundles) and [GRS-134](https://linear.app/vaper/issue/GRS-134/adapt-system-help-and-rescan-and-update-for-hosted-processing) (system). Integration owners GRS-116 and GRS-124 to GRS-128 report to [GRS-66](https://linear.app/vaper/issue/GRS-66/accept-hosted-production-integrations-and-page-coverage), which owns the route-by-route acceptance of this map. Every owner is blocked by the planning gate [GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha), and no route has hosted evidence. The hosted app keeps the v5 navigation; production route slugs are inputs, not a navigation to copy.

Sources: the audit's named routes (Linear document "Production browser audit, 8 October 2026", read by the coordinator), and the local research note `transform_map.md` sections 2 and 3, which derives hosted routes from the same audit's snapshots. Neither preserved the full 55-route list, and the raw snapshots are not on this host. No route was invented: a page evidenced without a slug is listed with an unknown route. Case IDs are written `{id}`.

## Route count

- Audit total: 55 workspace routes.
- Identified with a slug: **52** (19 named by the audit, 4 more from transform_map section 2, 29 more from section 3).
- Unknown: **3**. Three pages (contradictions, defence, anchors) are evidenced without a slug and may be these three; that is not verified.
- Uncertainty: if document detail (`doc/{ref}`) sat outside the 55, the split is 51 identified and 4 unknown. Section 3 names such as `existential-risk` are not guaranteed exact slugs. Whether query variants (`?original=missing`, `?thread=`) or tabs count as routes is unknown. Which 33 routes were main navigation is not recorded, apart from the BA-18 hints.
- Status of this sub-item: **HOLD** until the audit's route snapshots are recovered from the original host. Everything else in item 7 is complete.

## Workspace routes

Match: `equivalent` (same capability), `partial` (overlapping), `none` (no v5 view). Classification names the owner: a V1 parity ticket, CC-12 for newer-export data, a V2 issue, or an explicit deferral.

| # | Production route | Page | Evidence | v5 views | Match | Classification, 8 Oct (historical) | Hosted alpha owner | Findings |
| --: | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `/cases/{id}/results` | Overview | both (audit BA-09; transform_map §2 C1) | `overview` | partial | v1-parity (owner CC-03) | GRS-131 | BA-09 |
| 2 | `/cases/{id}/results/chronology` | Chronology | both (audit BA-04; transform_map §2 C2) | `chronology` | equivalent | v1-parity (owner CC-03) | GRS-131 | BA-04 |
| 3 | `/cases/{id}/results/documents` | All documents (query ?original=missing) | both (audit BA-09, BA-17; transform_map §2 C3) | `documents` | equivalent | v1-parity (owner CC-04) | GRS-131; originals open in GRS-120 to GRS-123 | BA-09, BA-17 |
| 4 | `/cases/{id}/results/doc/{ref}` | Document detail | both (audit BA-04, BA-09; transform_map §2 C4) | none | none | v1-parity (owner CC-03; document detail is in CC-03 build scope) | GRS-120 viewer shell, with GRS-121 to GRS-123 by format | BA-04, BA-09 |
| 5 | `/cases/{id}/results/quantum` | Quantum & interest (with interest recalculator) | both (audit BA-03; transform_map §2 C5) | `quantum_tab`, `interest_calc_tab` | partial | v1-parity (owner CC-06); per-invoice interest mode over quantum.postArb is v1-newer-export (CC-12) | GRS-132; per-invoice interest GRS-22 (newer export; gate GRS-24) | BA-03 |
| 6 | `/cases/{id}/results/invoice-ledger` | Invoice ledger | transform_map §2 C6 | `invoice_ledger_tab` | equivalent | v1-parity (owner CC-06) | GRS-132 |  |
| 7 | `/cases/{id}/results/emails` | Emails (thread list, ?thread=) | transform_map §2 C7 | none | none | v1-newer-export (CC-12) | GRS-22 (newer export; gate GRS-24) | BA-11 |
| 8 | `/cases/{id}/results/email-silences` | Email silences | both (audit BA-11; transform_map §2 C7) | none | none | v1-newer-export (CC-12) | GRS-22 (newer export; gate GRS-24) | BA-11 |
| 9 | `/cases/{id}/results/search` | Advanced search (with Action items tab) | both (audit BA-08, BA-15; transform_map §2 C8) | `search` | equivalent | v1-parity (owner CC-04) | GRS-131 | BA-08, BA-15 |
| 10 | `/cases/{id}/results/matter` | Matter & strategy | transform_map §2 C9 | `matter` | equivalent | v1-parity (owner CC-05) | GRS-131 |  |
| 11 | `/cases/{id}/results/timeline` | Timeline | transform_map §2 C9 | `timeline` | partial | v1-parity (owner CC-05) | GRS-131 |  |
| 12 | unknown | Contradictions (route slug not recorded) | transform_map §2 C10 | `contradictions_tab` | equivalent | v1-parity (owner CC-05) | GRS-131; slug unknown |  |
| 13 | `/cases/{id}/results/risk-matrix` | Risk matrix | both (audit BA-21; transform_map §2 C10) | `risk_matrix_tab` | partial | v1-parity (owner CC-05); category/owner/refs presentation v1-newer-export (CC-12) | GRS-131 | BA-21 |
| 14 | unknown | Defence (route slug not recorded) | transform_map §2 C10 | `vdm_matrix_tab` | equivalent | v1-parity (owner CC-05) | GRS-131; slug unknown |  |
| 15 | unknown | Anchors (route slug not recorded) | transform_map §2 C10 | none | none | v1-newer-export (CC-12) | GRS-22 (newer export; gate GRS-24); slug unknown |  |
| 16 | `/cases/{id}/results/agreements` | Agreements | both (audit BA-06; transform_map §3) | `contracts_tab` | equivalent | v1-parity (owner CC-04) | GRS-131 | BA-06 |
| 17 | `/cases/{id}/results/filings` | Filings and affidavits | both (audit BA-05; transform_map §3) | `filings_tab` | partial | v1-parity (owner CC-04) | GRS-131 | BA-05 |
| 18 | `/cases/{id}/results/legal-filings` | Legal filings | both (audit BA-04, BA-05; transform_map §3) | `filings_tab` | partial | v1-parity (owner CC-04); cls-based split v1-newer-export (CC-12) | GRS-131; split GRS-22 (newer export; gate GRS-24) | BA-04, BA-05 |
| 19 | `/cases/{id}/results/court-filings` | Court filings | both (audit BA-05; transform_map §3) | `filings_tab` | partial | v1-parity (owner CC-04); cls-based split v1-newer-export (CC-12) | GRS-131; split GRS-22 (newer export; gate GRS-24) | BA-05 |
| 20 | `/cases/{id}/results/document-difference` | Document difference | both (audit BA-08; transform_map §3) | `hoa_diff_tab` | partial | v1-parity (owner CC-04) | GRS-131 | BA-06, BA-08 |
| 21 | `/cases/{id}/results/caselines` | CaseLines | both (audit BA-08; transform_map §3) | `caselines_tab` | equivalent | v1-parity (owner CC-09) | GRS-133 | BA-08 |
| 22 | `/cases/{id}/results/discovery` | Discovery schedule | both (audit BA-10; transform_map §3) | `discovery_tab` | partial | v1-parity (owner CC-09); reshaped schedules v1-newer-export (CC-12) | GRS-133 | BA-10 |
| 23 | `/cases/{id}/results/court-bundles` | Court bundles | transform_map §3 | `court_bundle_tab` | partial | v1-parity (owner CC-09) | GRS-133; durable versions GRS-128 |  |
| 24 | `/cases/{id}/results/bundle-builder` | Bundle builder | transform_map §3 | `court_bundle_tab` | partial | v1-parity (owner CC-09) for v5 custom-bundle composition; hosted PDF assembly from uploads deferred (product brief: additional PDF assembly needs a separate scope decision) | GRS-128 durable PDF bundles, after GRS-133 |  |
| 25 | `/cases/{id}/results/people` | People | transform_map §3 | `people` | equivalent | v1-parity (owner CC-04) | GRS-131 | BA-07 |
| 26 | `/cases/{id}/results/entities` | Entities | transform_map §3 | `entity_ledger_tab` | equivalent | v1-parity (owner CC-04) | GRS-131 |  |
| 27 | `/cases/{id}/results/witnesses` | Witnesses | transform_map §3 | `witness_tab` | equivalent | v1-parity (owner CC-05) | GRS-131 |  |
| 28 | `/cases/{id}/results/organogram` | Organogram | transform_map §3 | none | none | v1-newer-export (CC-12) | GRS-22 (newer export; gate GRS-24) |  |
| 29 | `/cases/{id}/results/information-required` | Information required | transform_map §3 | `info_required_tab` | equivalent | v1-parity (owner CC-05); per-row Outlook draft deferred (no ticket) | GRS-131; per-row drafts GRS-126 | BA-18 |
| 30 | `/cases/{id}/results/reconciliation` | Reconciliation | transform_map §3 | `payments_tab` | partial | v1-parity (owner CC-06) | GRS-132 |  |
| 31 | `/cases/{id}/results/prescription` | Prescription | both (audit BA-01, BA-02; transform_map §3) | `prescription_tab` | equivalent | v1-parity (owner CC-06) | GRS-132 | BA-01, BA-02 |
| 32 | `/cases/{id}/results/cause-of-action` | Cause of action | transform_map §3 | `elements_tab` | equivalent | v1-parity (owner CC-08) | GRS-133 |  |
| 33 | `/cases/{id}/results/cross-examination` | Cross-examination | transform_map §3 (audit BA-18 names it as a tab of the authorities view) | `crossexam_tab` | equivalent | v1-parity (owner CC-08) | GRS-133 | BA-18 |
| 34 | `/cases/{id}/results/authorities` | Authorities (hosted nav label "Heads of Argument") | both (audit BA-18 label; transform_map §3) | `authorities_tab` | partial | v1-parity (owner CC-08) | GRS-133 | BA-18 |
| 35 | `/cases/{id}/results/enforcement` | Enforcement | transform_map §3 | `enforcement_tab` | equivalent | v1-parity (owner CC-08) | GRS-133 |  |
| 36 | `/cases/{id}/results/settlement` | Settlement | transform_map §3 | `settlement_tab` | equivalent | v1-parity (owner CC-06) | GRS-132 |  |
| 37 | `/cases/{id}/results/existential-risk` | Existential risk | both (audit BA-12; transform_map §3 as "existential (sub)") | `legality_tab` | partial | v1-parity (owner CC-08) | GRS-133 | BA-12 |
| 38 | `/cases/{id}/results/transcriptions` | Transcriptions | transform_map §3 | `transcriptions_tab` | partial | v1-parity (owner CC-07) for the register; imported transcripts dataset v1-newer-export (CC-12) | GRS-132; imported transcripts GRS-22 (newer export; gate GRS-24) |  |
| 39 | `/cases/{id}/results/whatsapp` | WhatsApp | transform_map §3 | none | none | v1-newer-export (CC-12) | GRS-22 (newer export; gate GRS-24) |  |
| 40 | `/cases/{id}/results/no-text` | Needs a manual read | both (audit BA-08; transform_map §3) | `manual` | partial | v1-parity (owner CC-10, v5 Manual lists scanned documents); BA-08 absent-text disclosure owned by CC-04/CC-09/CC-12 | GRS-134; absent-text disclosure GRS-131 and GRS-22 | BA-08 |
| 41 | `/cases/{id}/results/build-report` | Build report | transform_map §3 | `manual` | partial | v1-parity (owner CC-10) for v5 Manual build data and link check; per-dataset row/unreadable counts v1-newer-export (CC-12) | GRS-134; per-dataset counts GRS-22 |  |
| 42 | `/cases/{id}/results/privilege-suggestions` | Privilege suggestions | both (audit BA-07; transform_map §3) | none | none | deferred (hosted-only derived analytic; rule unresolved, not in v5. If ever shown, BA-07 requires suggestions not to be presented as privilege findings) | GRS-127 (suggestions until confirmed) | BA-07 |
| 43 | `/cases/{id}/results/conflict-check` | Conflict check | transform_map §3 | `conflict_tab` | equivalent | v1-parity (owner CC-08); organogram inclusion v1-newer-export (CC-12) | GRS-133 |  |
| 44 | `/cases/{id}/results/email-draft` | Email draft | transform_map §3 | none | none | deferred (production-only email drafting/Outlook integration; product brief excludes Outlook from parity; no V1 or V2 ticket) | GRS-126 |  |
| 45 | `/cases/{id}/results/deadlines` | Deadlines | transform_map §3 | `deadlines_tab` | equivalent | v1-parity (owner CC-07); hosted shared firm persistence v2-owned (GRS-36) | GRS-132 |  |
| 46 | `/cases/{id}/results/popia` | POPIA register | transform_map §3 | `popia_tab` | equivalent | v1-parity (owner CC-07); hosted persistence v2-owned (GRS-36) | GRS-132 |  |
| 47 | `/cases/{id}/results/kyc` | KYC | transform_map §3 | none | none | deferred (not in v5; production-only firm compliance register; no ticket) | GRS-124 |  |
| 48 | `/cases/{id}/results/annotations` | Annotations | transform_map §3 | `annotations_tab` | equivalent | v1-parity (owner CC-07); hosted persistence v2-owned (GRS-36) | GRS-119 Notes |  |
| 49 | `/cases/{id}/results/privilege-log` | Privilege log | transform_map §3 (audit BA-18 "Nice-to-have" category) | `privilege_tab` | equivalent | v1-parity (owner CC-07); hosted persistence v2-owned (GRS-36) | GRS-132; confirmed privilege GRS-127 | BA-18 |
| 50 | `/cases/{id}/results/timesheets` | Timesheets | transform_map §3 | `timesheet_tab` | equivalent | v1-parity (owner CC-07); hosted persistence v2-owned (GRS-36) | GRS-132; case costs GRS-125 |  |
| 51 | `/cases/{id}/results/billing` | Billing | transform_map §3 | none | none | deferred (case billing/fee notes are not in v5; no V1 or V2 ticket. If this is platform quote/payment it is V2-owned and unticketed) | GRS-125 case costs (no Pay ClearCase) |  |
| 52 | `/cases/{id}/results/disbursements` | Disbursements | transform_map §3 | `disbursements_tab` | equivalent | v1-parity (owner CC-07); hosted persistence v2-owned (GRS-36) | GRS-132; case costs GRS-125 |  |
| 53 | `/cases/{id}/results/audit-log` | Audit log | transform_map §3 | none | none | deferred (production-only firm activity log; not in v5; GRS-31 records publication approval but no ticket owns this view) | GRS-116 |  |
| 54 | `/cases/{id}/results/outlook` | Outlook | transform_map §3 | none | none | deferred (Outlook integration excluded from parity scope by the product brief; no ticket) | Later: live mailbox GRS-99. Alpha email files: GRS-122 |  |
| 55 | `/cases/{id}/results/email-templates` | Email templates | transform_map §3 | none | none | deferred (production-only; tied to email-draft/Outlook; no ticket) | GRS-126 firm templates |  |

## Non-workspace routes and platform capabilities

| Route | Capability | Classification, 8 Oct (historical) | Hosted alpha owner | Findings |
| --- | --- | --- | --- | --- |
| `/` | Public home | v2-owned (GRS-26 design, GRS-36 implement, GRS-32 verify) | GRS-113 root/login/support entry (no marketing redesign) | BA-20 |
| `/login` | Sign in | v2-owned (GRS-26, GRS-36, GRS-32) | GRS-113 (Clerk sessions) | BA-19 |
| `/signup` | Registration | v2-owned (GRS-26 decides whether self-registration exists; GRS-36 implements identity/provisioning) | None: alpha is invite-only through GRS-113; no self-registration |  |
| `/cases` | Cases list | v2-owned (GRS-36 client and case provisioning) | GRS-114 (cases and explicit grants) |  |
| `/admin` | Admin (redirected to /cases for firm-admin) | v2-owned (operator results import: GRS-25 discovery, GRS-30 private preview, GRS-31 publication) | Internal console: GRS-114 clients, GRS-135 queue, GRS-130 candidate editing, GRS-30 import, GRS-31 publication |  |
| not recorded | Team screen (path not recorded) | v2-owned (GRS-26 roles, GRS-36 identity; invitations unverified) | GRS-113 invitations, GRS-114 grants |  |
| not recorded | Case summary/overview outside results (path not recorded; shows uploads, open and publish dates) | v2-owned (GRS-28 intake, GRS-31 publication) | GRS-28 submission status, GRS-31 publication; notices GRS-129 |  |
| `/api/cases/{id}/documents/{ref}` | Original-file download API (not a page) | v2-owned (GRS-26/GRS-36 hosted storage); local original opening is v1-parity CC-03 | GRS-115 protected R2 assets, GRS-120 viewer | BA-09 |
| not recorded | Client upload/intake (path not recorded; uploader seen in public client chunk) | v2-owned (GRS-28 uploads, GRS-29 operator notification/download) | GRS-28 |  |
| not recorded | Quotes/payment and firm billing API (paths not recorded) | v2-owned per product scope, but no GRS ticket currently scopes it (product brief: not in parity scope) | Not alpha: no Pay ClearCase or checkout. No payment/checkout scope is approved; no implementation is inferred |  |
| not recorded | Result publication (path not recorded) | v2-owned (GRS-30 preview, GRS-31 sign-off/publish, GRS-32 verify) | GRS-31, after GRS-30 and GRS-130 |  |

## v5 views without an evidenced production route

`heads_tab`, `rescan_tab`, `backup_tab`. They remain V1 parity scope with their owners in `docs/plan/view-coverage.json`. Hosted owners: `heads_tab` GRS-133, `rescan_tab` GRS-134 (Rescan & Update through the upload, queue, review and publication path, with no server-folder scan), `backup_tab` GRS-118 (complete export, recovery and approved deletion). Partly matched:

- `payments_tab`: only its reconciliation-chain section has a hosted counterpart (reconciliation); user payments and the net claim have no evidenced route
- `manual`: only build data (build-report, no-text) has counterparts; the usage guide has none
- `interest_calc_tab`: hosted recalculator lives inside the quantum route, not a separate route
- `heads_tab`: hosted 'Heads of Argument' label opens authorities, not the v5 user-built heads list

## Production-only capabilities

Hosted alpha scope, 16 October 2026:

- **Alpha, with owners.** Email-file viewing for Outlook and Gmail exports (GRS-122); app-side email drafts and firm templates (GRS-126); manual represented-client KYC review with a warning only (GRS-124); current case costs, without Pay ClearCase (GRS-125); role- and case-scoped audit log (GRS-116); privilege suggestions that stay suggestions until confirmed (GRS-127); durable PDF bundle versions, including bundle-builder assembly from uploads (GRS-128); contextual Notes in place of annotations (GRS-119); uploader notices (GRS-129). GRS-66 accepts them together.
- **Platform.** Sign-in and invitations (GRS-113); client instances, cases and grants (GRS-114); protected originals (GRS-115, GRS-120 to GRS-123); intake (GRS-28); queue and download (GRS-135, GRS-29); private import, editing and publication (GRS-30, GRS-130, GRS-31).
- **Newer-export data, required before alpha (GRS-22, gate GRS-24).** Emails; email silences; organogram; anchors page; WhatsApp; imported transcripts; filings split (legal-filings, court-filings); per-invoice interest over quantum.postArb; build-report per-dataset counts.
- **Later.** Live Outlook and Gmail connections, provider-side drafts and syncing (GRS-99); standalone Markdown authoring (GRS-23); browser-agent product behaviour.
- **Gaps for the coordinator.** The hosted root/login/support entry belongs to GRS-113; payment/checkout is not approved scope. The three routes without a slug (rows 12, 14 and 15) and the missing route list stay unknown until the audit snapshots are recovered; nothing here is inferred from them.

On 8 October these capabilities were classed `deferred`: privilege-suggestions, email-draft, email-templates, outlook, kyc, billing, audit-log and bundle-builder PDF assembly. That classification is superseded above, except that live Outlook connections stay later.

Browser-agent product behavior is deferred. Local parity implies no browser agent, and the hosted manual workflow does not promise one.

## Newer-export datasets

The newer export (2,131 chronology rows) is GRS-22 (CC-12) scope. Keys come from earlier local research on that export (an observed sample, not a formal schema) and from archive central-directory listings; no newer archive was extracted. `partial` means a v5 view exists but new fields or shapes need the CC-12 adapter or an explicit unsupported state; nothing here is tested support.

| Dataset | In v5 | v5 view | Status | Owner |
| --- | --- | --- | --- | --- |
| `META` | yes | overview, caselines_tab, manual | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.chronology` | yes | chronology, documents, search | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.text` | no | search | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.people` | yes | people, conflict_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.entities` | yes | entity_ledger_tab, conflict_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.matter` | yes | matter, overview | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.quantum` | yes | quantum_tab, invoice_ledger_tab, interest_calc_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.timeline` | yes | timeline | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.contracts` | yes | contracts_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.filings` | yes | filings_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.contradictions` | yes | contradictions_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.riskMatrix` | yes | risk_matrix_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.defenceMatrix` | yes | vdm_matrix_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.infoRequired` | yes | info_required_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.witnesses` | yes | witness_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.lit` | yes | enforcement_tab, legality_tab, prescription_tab, elements_tab, authorities_tab, crossexam_tab, settlement_tab, payments_tab, quantum_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.bundles` | yes | court_bundle_tab, caselines_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.buildReport` | yes | manual | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.linkSample` | yes | manual | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.emails` | no | none | unsupported | CC-12 |
| `DATA.whatsapp` | no | none | unsupported | CC-12 |
| `DATA.transcripts` | no | transcriptions_tab (user register only) | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `DATA.organogram` | no | none | unsupported | CC-12 |
| `DATA.anchors` | no | none | unsupported | CC-12 |
| `DATA.profile` | no | none | unsupported | CC-12 |
| `DISCOVERY_SCHEDULES` | renamed:window.__SCHED__ | discovery_tab | partial | CC-12 (adapter); presenting view owned by the v5 view owner |
| `CASELINES_PAGE_TEXT` | renamed:window.__CASELINES_IDX__ | caselines_tab | supported | CC-12 (adapter); presenting view owned by the v5 view owner |

Unsupported by any v5 view: `DATA.emails`, `DATA.whatsapp`, `DATA.organogram`, `DATA.anchors`, `DATA.profile`. `DATA.text` is capped at 4,000 characters per document in that export; BA-08 requires the cap to be disclosed. A nested data-export zip inside the newer archive was listed but not opened.
