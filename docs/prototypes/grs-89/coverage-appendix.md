# Coverage appendix (GRS-89)

What the prototype contains, what it only maps, and where each entry comes from. Prepared at the revision's head; see the README for how to run it. Everything listed as *planned* is a placeholder with a visible Planned label. None of it is built, and no endpoint, route or data shape is verified.

## Counts, and what they do not mean

| Set | Count | Notes |
| --- | --: | --- |
| v5 registry views | 42 | The local parity target. Ids, labels and v5 groups checked by script against `view-registry.ts` at `8693ed886b7c641eacba76d06806f723f515cedb`. 9 behave in memory (Overview, Matter & Strategy, Chronology, Risk Matrix, Documents, Advanced Search, Timesheet, Deadlines, Annotations); 33 are summary placeholders, including Court Bundle, which maps its v5 DOCX index and print. |
| Planned case destinations | 13 | Hosted or newer-export capabilities with no v5 view, plus the client packet export. |
| Planned platform destinations | 3 | Case list, team, notifications. Outside any one case. |
| Planned operator surfaces | 3 | Private. Shown only in the prototype's Operator study mode, never in client navigation or All tools. |
| Prototype index | 1 | All tools, a navigation aid and not a capability. |

The route map records 55 production workspace routes. **42 and 55 are not equated**: several routes map to one view, three views have no route, three production slugs are unrecorded, and the 55 includes pages that the 13 planned case entries only partly cover. This table is a placement exercise for the study, not a route inventory.

## Planned client-facing destinations (16)

| Id | Label | Kind | Variant A home | Variant B home | Source and status |
| --- | --- | --- | --- | --- | --- |
| `hosted_intake` | Submissions & publication | case | Hosted · planned (sidebar group) | Desk task, chip marked Planned | v2-owned (GRS-28 uploads, GRS-29 operator notification and download, GRS-31 publication). Client upload path not recorded in the route map. |
| `hosted_emails` | Emails | case | Hosted · planned (sidebar group) | Find task, chip marked Planned | Newer-export page (CC-12), production route emails; not in v5. |
| `hosted_silences` | Email silences | case | Hosted · planned (sidebar group) | Find task, chip marked Planned | Newer-export page (CC-12), production route email-silences; not in v5. |
| `hosted_anchors` | Anchors | case | Hosted · planned (sidebar group) | Find task, chip marked Planned | Newer-export page (CC-12); the route slug is not recorded in the route map. |
| `hosted_organogram` | Organogram | case | Hosted · planned (sidebar group) | Find task, chip marked Planned | Newer-export page (CC-12), production route organogram; not in v5. |
| `hosted_whatsapp` | WhatsApp | case | Hosted · planned (sidebar group) | Find task, chip marked Planned | Newer-export page (CC-12), production route whatsapp; not in v5. |
| `hosted_privsugg` | Privilege suggestions | case | Hosted · planned (sidebar group) | Record task, chip marked Planned | Deferred: hosted-only derived analytic, rule unresolved (audit BA-07). If ever shown, suggestions must not be presented as findings. |
| `hosted_email` | Email drafts, templates & Outlook | case | Hosted · planned (sidebar group) | Record task, chip marked Planned | Deferred: production email-draft, email-templates and outlook routes; Outlook integration is outside parity scope; no ticket. |
| `hosted_kyc` | KYC | case | Hosted · planned (sidebar group) | System task, chip marked Planned | Deferred: not in v5, no ticket. |
| `hosted_billing` | Billing | case | Hosted · planned (sidebar group) | Record task, chip marked Planned | Deferred: not in v5, no ticket. |
| `hosted_audit` | Audit log | case | Hosted · planned (sidebar group) | System task, chip marked Planned | Deferred: not in v5, no ticket owns it. |
| `hosted_packet` | Client packet export | case | Hosted · planned (sidebar group) | Prepare task, chip marked Planned | The user's Notes decision of 15 October 2026 (notes left out of client packet exports unless chosen). No route or ticket recorded in the sources used here. Simulated. Not the v5 Court Bundle. |
| `hosted_bundles` | Bundle builder (uploads) | case | Hosted · planned (sidebar group) | Prepare task, chip marked Planned | Deferred: PDF assembly from uploads needs a scope decision. |
| `hosted_cases` | Case list | platform (outside one case) | Account & firm · planned (sidebar group) | System task, chip marked Planned | v2-owned (GRS-36 client and case provisioning); production route /cases. |
| `hosted_team` | Team | platform (outside one case) | Account & firm · planned (sidebar group) | System task, chip marked Planned | v2-owned (GRS-26 roles, GRS-36 identity); path not recorded, invitations unverified. |
| `hosted_notifications` | Notifications | platform (outside one case) | Account & firm · planned (sidebar group) | System task, chip marked Planned | V2 platform item in the component audit; no route recorded and no ticket identified in the sources used here. |

Notes on specific entries:

- *Anchors* and *Email silences* are named in the route map but their content is not specified in the sources used. The prototype labels them as such rather than inventing a purpose.
- *Privilege suggestions* carries the BA-07 constraint: if it is ever shown, suggestions are not presented as findings.
- *Client packet export* is simulated: CSV and JSON manifest downloads, notes left out unless chosen, scope shown before and after. It was split from Court Bundle in the final correction, because v5's Court Bundle builds a court bundle index (DOCX, print) and is a different tool.
- *Submissions & publication* is also simulated. It follows the V2 workflow in `docs/product-brief.md`: upload, finalize (input revision recorded, operator notified), manual operator processing, private preview and sign-off, publication that changes the active version atomically. The client sees submission, processing and publication as three separate facts with timestamps. Manual processing has no progress figure, so none is shown.
- *Team* and *Notifications* have no recorded route; Team's invitations are unverified.

## Planned operator surfaces (3), outside client navigation

| Id | Label | Source |
| --- | --- | --- |
| `op_import` | Import & validate | Operator imports a results package into the case’s private admin area; validation reports errors and warnings (GRS-25 discovery). |
| `op_review` | Private preview & correct | Operator previews the same viewer the client will use and fixes blocking errors. Clients cannot reach drafts (GRS-30). |
| `op_publish` | Sign-off & publish | An admin signs off one specific results version; publication switches the client’s active version atomically and records who approved it (GRS-31). |

They appear only on the prototype's **Operator study** page, opened from the prototype bar: not from either variant's navigation, not from All tools and not from the client's Submissions page. That page also holds the simulated operator actions (start processing, sign off and publish Results v4). It is labelled as simulated, and it models no authorization, operator sign-in or audit. `selfCheck()` asserts that neither variant's navigation, nor All tools, nor the Submissions page reaches them. The route map notes that `/admin` redirects to `/cases` for a firm admin, which is a source observation and not a design for this study.

## v5 exports, rollback and recovery: mapped, not built

- Each view's v5 export comes from the source audit's Export column: CSV, ICS (Deadlines), print, a DOCX index (Court Bundle), the HTML index and cover page (Discovery Schedule), a JSON index (Rescan) and a backup file (Backup / Restore). Placeholders and working pages name it, marked "not built".
- Overview rollback (inventory row 1): the v5 Overview can roll back. Who may do that in hosted use is undecided, so the prototype shows no control. The header's version choice only *views* an earlier version.
- `/import`, `/import/[id]` and `/recovery` are v5 operator flows outside the 42 (inventory, closing notes). Their content was not audited. Operator study maps them to the operator console.

## Placement choices that are opinions

- Conflict Check moved to Find in Variant B (it reads people and entities); in Variant A it stays under Parties & witnesses.
- Submissions & publication sits under Desk in B (it answers "what needs me") and is shown in both arms' headers and on the Overview. It is no longer filed under Admin, which R1 found misleading for a client.
- B's last task is named System (scan, backup, firm records) rather than Admin.
- Planned items in B appear in the strip of the task they would belong to, with a visible Planned badge. In A they sit in separate sidebar groups.

These are placement hypotheses for the study to test. They are not agreed taxonomy.
