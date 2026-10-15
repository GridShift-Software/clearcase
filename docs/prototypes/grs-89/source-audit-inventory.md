# Source-audit inventory (GRS-89)

Reviewable extract of the two read-only source audits that fed the navigation study. The audits themselves were written to ignored `.local/` files, so the parts the prototype relies on are recorded here. Both audits read source and documents only: the app was not run, no real case material or production access was used, and nothing here is usability evidence.

- Accepted app source: `8693ed886b7c641eacba76d06806f723f515cedb`.
- Component audit (slice 1): manifest and grouping audit of the 42 registry views. Sources it cites: `src/lib/components/view-registry.ts`, `views.ts`, `ViewNav.svelte`, `CitationLink.svelte`, `src/routes/v/[vid]/**`, `src/lib/views/**`, `src/app.css`, `docs/plan/view-coverage.json`, `docs/reference/route-map.md`, `docs/development.md`, `GLOSSARY.md`, Linear GRS-66 and GRS-89 (read only).
- Workflow audit (slice 2): context-loss evidence (E1 to E14), two navigation hypotheses, eight test tasks (T1 to T8) and a blind rubric.
- Both audits ended with verdict ISSUES. The `doctor` check failed only on three skill-pin drifts, which do not touch the analysis.

## 1. Grouping problems the component audit proved from source

1. Money is split across three groups: `quantum_tab` (Matter), `invoice_ledger_tab` (Case management), and `prescription_tab`, `interest_calc_tab`, `payments_tab`, `settlement_tab` (Litigation strategy). All six use `$lib/views/quantum`.
2. The invoice ledger is duplicated: Quantum & Interest has an "Invoice ledger" section and exports the same `invoices.csv`.
3. Three views list document rows with overlapping filters (`chronology`, `documents`, `search`); `hoa_diff_tab` is a fourth entry point that acts only on documents.
4. Notes exist twice: the document page "My notes" (`notesFor`/`addNote`, a CC-03 addition with no v5 store) and the `annotations_tab` register (document ref plus note). Neither shows the other. **Settled by the user on 15 October 2026: one contextual Notes feature; see the decision record in the README.**
5. Registers live in four groups; "Registers" names an implementation, not a task.
6. Edit models differ: generic registers add, edit and delete; heads, cross-exam and payments add and delete; authorities only adds.
7. Some views sit in the wrong group (Conflict Check reads only people and entities; Invoice Ledger is imported data; Transcripts is user-entered evidence; Info Required is a to-do list).
8. Related views are split: Witnesses from Cross-Exam Prep; Risk Matrix from Legality & SIU Risk; Cause of Action and Defence & Rebuttal from Authorities and Heads.
9. Label collisions: group "Matter" contains the view "Matter & Strategy"; ids differ from labels (`vdm_matrix_tab` is Defence & Rebuttal, `elements_tab` is Cause of Action); the hosted labels Agreements, Defence, Reconciliation, Existential risk and "Heads of Argument" (which opens authorities) differ from v5.
10. Misleading copy: Disbursements and Annotations say "saved in this browser" but rows are stored in `work.sqlite` on the server (`registers/defs.ts`).
11. Weak links from evidence to analysis: Risk Matrix, Info Required, People, Entities and Document Diff render no citation; the document page has no "cited in" backlinks; `CitationLink` is a plain navigation with no preview.
12. Mobile: below 40rem the 42-link nav becomes a static 14rem scroll box with no collapse; time, notes and deadlines can be added only inside their own views.
13. 42 is not the hosted count: production has 55 workspace routes (52 identified, 3 unknown) plus platform pages. See the coverage appendix. The two numbers are not equated.

## 2. Workflow audit: context-loss evidence

| Id | Finding (source observation) |
| --- | --- |
| E1 | One sidebar shows all 42 views in 7 groups, always expanded; no collapse, filter or recent views. |
| E2 | At 40rem and below the sidebar is a fixed 14rem scroll box above the content, with no menu toggle. |
| E4, E5 | A citation loads the full document page; it has no breadcrumb or return link and marks no navigation item current. |
| E7 | Filters are remembered per view; scroll position, selected row, open details and where a document visit started are not. Chronology rows have no anchor. |
| E8 | Seven files guard unsaved input with at least four implementations; the document note form has none. |
| E9 | Views write URL state three different ways (shallow replace, goto replace, goto push), so Back differs by view. |
| E3 | The navigation group and the URL category disagree (Prescription is under Litigation strategy but its URL is `/quantum/...`). |
| E11, E12 | Update state is spread over five places; any non-active version shows "CANDIDATE PREVIEW", even one that was active before; saved links carry the resultsVersion and go stale after activation. |
| E10 | No global search and no case or version switcher in the header. |
| E13, E14 | Timesheet Hours and Rate are `type=text`; the narrow-screen UI check tests only for sideways scrolling, not reachability or tap size. |

## 3. The two hypotheses in the audits, and what the prototype took

| | Audit hypothesis | Prototype arm |
| --- | --- | --- |
| A | Resource rail with an evidence drawer: eight groups, only the current one expanded, a filter, a header version strip, a citation drawer with `?doc=` | **Topic sidebar.** Takes the collapsed-except-current groups, the filter and the compact version and status strip. Does **not** take the `?doc=` drawer: the original opens the same way in both arms. |
| B | Task-led case desk: route-backed tabs, return stack, All tools catalog and Ctrl/Cmd+K palette, mobile bottom bar with quick entry | **Task-led desk.** Takes the task rows, the All tools catalogue, the bottom bar and quick capture, and adds a context rail. Does **not** take the Ctrl+K palette or the return stack. |

The omissions are deliberate: the original viewer, Back behaviour, drafts and focus handling are shared so that only navigation differs. See the response document.

## 4. Test tasks (workflow audit) and how this prototype supports them

| Task | Audit task | Prototype support |
| --- | --- | --- |
| T1 | Latest published or active state and whether an update is pending | Header version control, banner and Submissions & publication (simulated) |
| T2 | Cited page and return to the same query and row, at most 2 actions | Shared viewer; Escape, Back or the Back-to button return to the citation |
| T3 | Chronology entry, then the risk item and issue that cite it | Chronology issue tags and risk links lead to Matter & Strategy and the Risk Matrix row |
| T4 | Note, leave prompt, edit an annotation | In-memory drafts survive leaving; Notes page edit and delete (simulated roles) |
| T5 | Log time at 390x844 with a numeric keyboard, no sideways scroll | Time form with `inputmode=decimal`. No fee-earner or rate field (not needed for the study tasks) |
| T6 | Find Document Diff, export the court bundle index | Catalogue and filters; packet export with a stated scope |
| T7 | Upload or import status | Submissions & publication: submission, processing, publication, each with timestamps |
| T8 | Return after a detour and after an activation | Version selection keeps view, section, query, filters, scroll and drafts |

The audit's blind X/Y rubric is not applied to this prototype; see the response document.

## 5. The 42 views

Columns: current v5 group (registry), the component audit's primary task and edit model, and where the prototype puts the view. "Working" means the prototype shows real in-memory behaviour for it; every other view is a summary placeholder.

| # | v5 id | Label | v5 group | Audit: primary task | Edit model | Export | Cites | Component audit: task hubs / object workspaces | Prototype A topic | Prototype B task | Prototype |
| --: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `overview` | Overview | Matter | See the state of the case and the active results version | read-only (+rollback) | none | yes (notes by ref, narrative) | Case at a glance / Overview | Case | Desk | working |
| 2 | `matter` | Matter & Strategy | Matter | Read the matter summary and strategy narrative | read-only | none | yes (narrative) | Case at a glance / Issues | Case | Argue | working |
| 3 | `timeline` | Timeline | Matter | Understand the case in phases and over time | read-only | print | yes | Case at a glance / Overview | Case | Find | summary |
| 4 | `chronology` | Chronology | Matter | Browse every document in date order | read-only | CSV | yes | Documents & evidence / Documents | Case | Find | working |
| 5 | `quantum_tab` | Quantum & Interest | Matter | Know what is owed and how the balance grew | read-only | CSV (invoices.csv) | yes | Claim & recovery / Money | Money | Numbers | summary |
| 6 | `documents` | Documents | Evidence | Browse documents by bundle | read-only | none | yes | Documents & evidence / Documents | Documents & evidence | Find | working |
| 7 | `contracts_tab` | Contracts | Evidence | Review the contract documents that found the claim | read-only | CSV | yes | Documents & evidence / Documents | Documents & evidence | Find | summary |
| 8 | `filings_tab` | Filings & Affidavits | Evidence | Track pleadings and pair each filing with its replying affidavit | custom register (add/edit/delete) | CSV x2 | yes | Documents & evidence / Documents | Documents & evidence | Find | summary |
| 9 | `search` | Advanced Search | Evidence | Find documents by text, sender, date, amount, type | read-only | CSV | yes | Documents & evidence / Documents (search bar, global) | Documents & evidence | Find | working |
| 10 | `people` | People | Evidence | See who corresponded and how often | read-only | none | no | Parties / People | Parties & witnesses | Find | summary |
| 11 | `entity_ledger_tab` | Entities | Evidence | See organisations and their roles | read-only | none | no | Parties / People | Parties & witnesses | Find | summary |
| 12 | `hoa_diff_tab` | Document Diff | Evidence | Compare two documents line or word by line | tool (ephemeral) | none | no | Documents & evidence / Documents (action on a document) | Documents & evidence | Find | summary |
| 13 | `invoice_ledger_tab` | Invoice Ledger | Case management | Inspect every invoice | read-only | CSV (invoices.csv) | yes | Claim & recovery / Money | Money | Numbers | summary |
| 14 | `disbursements_tab` | Disbursements | Case management | Record case expenses | register (add/edit/delete, generic RegisterPage) | CSV | doc ref: no | My work / Work drawer | Money | Record | summary |
| 15 | `timesheet_tab` | Timesheet | Case management | Record time spent | register (add/edit/delete, generic RegisterPage) | CSV | no | My work / Work drawer (quick add) | Notes, time & registers | Record | working |
| 16 | `deadlines_tab` | Deadlines | Case management | Track dates with countdowns | register (add/edit/delete, generic RegisterPage) | ICS | no | My work / Work drawer | Court & procedure | Desk | working |
| 17 | `discovery_tab` | Discovery Schedule | Case management | Prepare the discovery schedule and bundle | custom state (select, co, mode) | HTML index, cover page, print | yes | Bundles & discovery / Court output | Court & procedure | Prepare | summary |
| 18 | `court_bundle_tab` | Court Bundle | Case management | Build and export court bundle indexes | custom state (header, custom bundles) | DOCX, print | narrative | Bundles & discovery / Court output | Court & procedure | Prepare | working |
| 19 | `caselines_tab` | CaseLines | Case management | Link documents to CaseLines and search the bundle | custom register (link/unlink) | none | no doc-page links | Bundles & discovery / Court output | Court & procedure | Prepare | summary |
| 20 | `contradictions_tab` | Contradiction Tracker | Analysis | Find inconsistencies across the evidence | read-only | CSV | yes | Assess the case / Issues | Issues & argument | Argue | summary |
| 21 | `risk_matrix_tab` | Risk Matrix | Analysis | Weigh issues by likelihood and impact | read-only | none | no | Assess the case / Issues | Issues & argument | Argue | working |
| 22 | `vdm_matrix_tab` | Defence & Rebuttal | Analysis | Anticipate defences and rebuttals | read-only | CSV | yes | Assess the case / Issues | Issues & argument | Argue | summary |
| 23 | `info_required_tab` | Info Required | Analysis | Track information still needed from the client | custom state (toggle done) | print | no | Assess the case / Work drawer / Issues | Issues & argument | Desk | summary |
| 24 | `witness_tab` | Witnesses | Analysis | See each witness and what they will say | read-only | none | yes (narrative) | Trial preparation / People | Parties & witnesses | Argue | summary |
| 25 | `conflict_tab` | Conflict Check | Analysis | Check a name against parties and correspondents | tool (ephemeral) | none | narrative only | Parties / People | Parties & witnesses | Find | summary |
| 26 | `enforcement_tab` | Enforcement Roadmap | Litigation strategy | Plan recovery after judgment step by step | custom state (status per step) | none | yes | Claim & recovery / Money | Issues & argument | Argue | summary |
| 27 | `legality_tab` | Legality & SIU Risk | Litigation strategy | Assess legality and SIU exposure | read-only | none | yes | Assess the case / Issues | Issues & argument | Argue | summary |
| 28 | `prescription_tab` | Prescription | Litigation strategy | See which invoices risk prescription | read-only | CSV | yes | Claim & recovery / Money | Issues & argument | Argue | summary |
| 29 | `interest_calc_tab` | Interest Recalculator | Litigation strategy | Recalculate interest for a capital sum | calculator (ephemeral) | none | narrative | Claim & recovery / Money | Money | Numbers | summary |
| 30 | `payments_tab` | Payments & Net Claim | Litigation strategy | Record payments received and see the net claim | custom register (add/delete, no edit) | CSV | yes | Claim & recovery / Money | Money | Numbers | summary |
| 31 | `elements_tab` | Cause of Action | Litigation strategy | Check each element of the cause of action against evidence | read-only | none | yes | Assess the case / Issues | Issues & argument | Argue | summary |
| 32 | `authorities_tab` | Authorities | Litigation strategy | Keep the case law and propositions | custom register (add only) | CSV | yes | Trial preparation / Issues | Issues & argument | Argue | summary |
| 33 | `heads_tab` | Heads of Argument | Litigation strategy | Draft heads of argument | custom register (add/delete, no edit) | export | yes | Trial preparation / Issues | Issues & argument | Argue | summary |
| 34 | `crossexam_tab` | Cross-Exam Prep | Litigation strategy | Prepare cross-examination topics per witness | custom register + seed overlay (add/delete) | none | yes | Trial preparation / People / Issues | Court & procedure | Prepare | summary |
| 35 | `settlement_tab` | Settlement / BATNA | Litigation strategy | Model settlement value against litigating (BATNA) | calculator (ephemeral) | none | narrative | Claim & recovery / Money | Money | Numbers | summary |
| 36 | `privilege_tab` | Privilege Log | Registers | Log documents withheld or redacted for privilege | register (add/edit/delete, generic RegisterPage) | CSV | yes (doc ref) | Bundles & discovery / Documents / Court output | Notes, time & registers | Record | summary |
| 37 | `popia_tab` | POPIA Register | Registers | Record personal-information processing | register (add/edit/delete, generic RegisterPage) | CSV | no | My work / Work drawer | Notes, time & registers | Record | summary |
| 38 | `annotations_tab` | Annotations | Registers | Keep private notes against documents | register (add/edit/delete, generic RegisterPage) | CSV | yes (doc ref) | My work / Document context panel | Notes, time & registers | Record | working |
| 39 | `transcriptions_tab` | Transcripts | Registers | Store hearing/recording transcripts | register (add/edit/delete, generic RegisterPage) | CSV | no | Documents & evidence / Documents | Documents & evidence | Find | summary |
| 40 | `rescan_tab` | Rescan & Update | System | Find new or changed originals in the case folder | system action | JSON index | no | System / System | System | System | summary |
| 41 | `backup_tab` | Backup / Restore | System | Back up or restore all user work | system action | backup file | no | System / System | System | System | summary |
| 42 | `manual` | Manual | System | Learn how the app works and see build data | read-only | print | no | System / System / Documents | System | System | summary |

Counts: current v5 groups Matter 5, Evidence 7, Case management 7, Analysis 6, Litigation strategy 10, Registers 4, System 3 (= 42). The prototype checks its ids, labels and v5 groups against `src/lib/components/view-registry.ts` at the base SHA by script.

## 6. Non-registry pages, and hosted and production capabilities

Kept apart from the 42. Sources: `docs/reference/route-map.md` (production audit of 8 October 2026), `docs/product-brief.md` (V2 client workflow) and the component audit section 4. The route map says plainly that its 55 workspace routes are not the 42 views: several routes map to one view (filings x3, manual x2, court bundle x2, quantum plus interest), three views have no route, and three production pages have unrecorded slugs. **The prototype does not equate 42 with 55 and verifies no endpoint.**

- Pages outside the 42 that exist in the app: the document page `/v/[vid]/doc/[ref]` (reached only through a citation), `/import`, `/import/[id]` and `/recovery` (operator flows), and redirects.
- Newer-export pages with no v5 view (CC-12): emails, email silences, anchors (slug not recorded), organogram, WhatsApp, imported transcripts, the filings split, per-invoice interest, build-report counts.
- Production-only pages now in hosted scope (GRS-66, 13 October): email draft, email templates, Outlook, KYC, billing, audit log, privilege suggestions (BA-07: never presented as findings), bundle-builder PDF assembly from uploads.
- Platform (V2: GRS-26, 28 to 32, 36): case list, team, client upload and intake, notifications, operator import, private preview, sign-off and publication, the hosted original-download API, firm-shared register persistence.

Where each lands in the prototype is in `coverage-appendix.md`.

## 7. Limits

- Task labels ("primary user task") are inferred from headings, controls and subtitles, not observed from users.
- The audits did not read view content, real case data, screenshots or locators, and did not run the app.
- Unaccepted demo UI on `origin/feat/demo-case-import` (e27c9b4) changes no registry entry, group or label.
- Follow-ups the audits raised: the Notes question (now settled, see the README), whether "saved in this browser" copy needs a decision record, and the home of the hosted destinations before navigation is frozen.
