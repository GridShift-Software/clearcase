# GRS-89 navigation prototype

A throwaway UX prototype. It asks: **where should users find existing capabilities in a large legal case, while keeping evidence context and quick work on a phone (notes and time)?** It is not app code. It touches no route, store or auth of the app, and its case, people, documents and numbers are all invented.

- Page: `src/routes/prototype/navigation/prototype.html`. One self-contained file with inline CSS and JS, no assets and no network. It also works when opened directly or rendered in a sandboxed preview frame.
- Launcher: `src/routes/prototype/navigation/serve.mjs`. The folder has no `+` files, so SvelteKit, the build and the route scanners in `tests/e2e/classes` ignore it.

## Run and stop

```sh
bun run --bun prototype:navigation          # http://127.0.0.1:44189/prototype/navigation?variant=A
PORT=44190 bun run --bun prototype:navigation
bun src/routes/prototype/navigation/serve.mjs --stop   # same PORT; signals only the pid it recorded
```

The server listens on loopback only. It writes its pid to `.local/prototype-navigation-<port>.pid`, and `--stop` signals that pid only while it still runs this script. It sends a CSP that blocks every load, so the page cannot depend on the network. It reads the HTML on each request, so reload after an edit.

URL: `?variant=A|B&view=<id>`. The floating bar at the bottom, or ← and → (ignored while typing in a field), switches the variant. The URL keeps the variant and view, and Back and Forward move between views. All user work lives in memory, is shared by both variants, and is lost on reload.

## Hypotheses

1. **A, Topic sidebar.** People find a capability fastest when every resource is always visible, grouped by what it is about (Case, Documents & evidence, Parties & witnesses, Issues & argument, Money, Court & procedure, Notes, time & registers, System, and Hosted · planned). In-view section navigation ("On this page") keeps their place in long analysis. Quick work lives with its resource: the Timesheet, Annotations, or a note form inline under a section. On a phone the sidebar becomes a drawer behind **Menu**.
2. **B, Task-led case desk.** People find a capability fastest when the top level is the job they are doing (Desk, Find, Argue, Numbers, Prepare, Record, Admin). Each job shows its tools as a strip and its context tools in a rail beside the work: the evidence cited in the current issue, its notes, jump links and key figures. Quick capture of a note or time is one button away everywhere, as the **+ Capture** item in the phone's bottom task bar.

Shared by both, so only navigation differs: the synthetic data, the case header and counts, global search (`/` focuses it), the forms, the original viewer, tables and style tokens (from `src/app.css`). The viewer opens beside the work on a desktop, taking the place of A's page rail or B's context rail. On a phone it opens as a full-screen sheet. Close it with **Back to …**, ✕ or Escape, and focus returns to the citation you came from, which flashes.

## Tasks to try (synthetic data)

| Task | Where in A | Where in B |
| --- | --- | --- |
| Search all documents for "gearbox", open a hit at its cited page | header search | header search, then the Find task |
| Reach every tool from a catalogue | sidebar, **All tools** | **All tools** tab, or **More** on a phone |
| Read the chronology, filter by issue, open a source | Case › Chronology | Find › Chronology, or the Find rail's jump links |
| Go to one analysis section (Issue B) | Matter & Strategy, **On this page** | Argue, issue chips; the rail lists that issue's evidence |
| Open a citation beside the analysis and return to the same place | any citation | any citation, including the rail |
| Save a note | inline under a section, on a viewer page, or Annotations | **+ Capture** › Note, or on a viewer page |
| Log billable time and see it confirmed, then switch variant and find it | Timesheet | **+ Capture** › Time, or Record › Timesheet |
| Check upload processing status | header chip, or Hosted · planned › Intake | Admin › Intake, or the Desk rail |
| Export a packet | Court & procedure › Court Bundle | Prepare › Court Bundle |

Saving a note or a time entry shows a confirmation in the form and a toast. The header chips (`Today n h`, `n notes`) and both registers update in either variant.

## What works and what is a placeholder

Working, on in-memory synthetic data: Overview, Matter & Strategy (six sections, eight cited originals), Chronology (412 events), Documents (1,214 rows, 16 needing a manual read), Advanced Search, Timesheet, Annotations, Deadlines, Court Bundle (packet export only), the All tools catalogue, and Intake & processing status (a simulation).

The 33 other views are **summary placeholders**. Each shows what the view holds, a synthetic size, and its v5 group, A topic and B task, and can take a note. The five other hosted capabilities are marked **Planned hosted capability. It does not work in this prototype**: Email & Outlook, KYC, Billing, Audit log, and Bundle builder (uploads). Their scope notes come from `docs/reference/route-map.md`.

Packet export writes a CSV and a JSON manifest as in-browser downloads, both labelled PROTOTYPE. It does not assemble a PDF.

## Known limitations

- Navigation evidence only. It does not show how any specialty view should look, and the placeholders are not designs.
- The simulated original is generated text, not a page image. Pages of the 16 "manual read" documents show a no-text state.
- Ids, labels and v5 groups match `src/lib/components/view-registry.ts` at base `8693ed8`, checked by script. The topic and task placements are this prototype's proposal, not an agreed taxonomy. The source and workflow audits (GRS-89 component and workflow audits) were not read; the parent session applies them.
- The capability set is the 42 v5 views plus six hosted capabilities. It does not attempt the 55 production routes (see the route map; those counts are not equated).
- It covers browser layouts only, desktop first, plus 390 px. A future native desktop app is out of scope.
- "Today" uses the browser's date, and deadline day counts follow it.
- Checked with self-checks and a scripted browser run (Chrome via T3 preview, 1280 and 390 px). There are no tests, by design, and no screen-reader pass.

## The 42 views

| # | v5 id | Label | v5 group | A topic | B task | Prototype |
| --: | --- | --- | --- | --- | --- | --- |
| 1 | `overview` | Overview | Matter | Case | Desk | working |
| 2 | `matter` | Matter & Strategy | Matter | Case | Argue | working |
| 3 | `timeline` | Timeline | Matter | Case | Find | summary |
| 4 | `chronology` | Chronology | Matter | Case | Find | working |
| 5 | `quantum_tab` | Quantum & Interest | Matter | Money | Numbers | summary |
| 6 | `documents` | Documents | Evidence | Documents & evidence | Find | working |
| 7 | `contracts_tab` | Contracts | Evidence | Documents & evidence | Find | summary |
| 8 | `filings_tab` | Filings & Affidavits | Evidence | Documents & evidence | Find | summary |
| 9 | `search` | Advanced Search | Evidence | Documents & evidence | Find | working |
| 10 | `people` | People | Evidence | Parties & witnesses | Find | summary |
| 11 | `entity_ledger_tab` | Entities | Evidence | Parties & witnesses | Find | summary |
| 12 | `hoa_diff_tab` | Document Diff | Evidence | Documents & evidence | Find | summary |
| 13 | `invoice_ledger_tab` | Invoice Ledger | Case management | Money | Numbers | summary |
| 14 | `disbursements_tab` | Disbursements | Case management | Money | Record | summary |
| 15 | `timesheet_tab` | Timesheet | Case management | Notes, time & registers | Record | working |
| 16 | `deadlines_tab` | Deadlines | Case management | Court & procedure | Desk | working |
| 17 | `discovery_tab` | Discovery Schedule | Case management | Court & procedure | Prepare | summary |
| 18 | `court_bundle_tab` | Court Bundle | Case management | Court & procedure | Prepare | working |
| 19 | `caselines_tab` | CaseLines | Case management | Court & procedure | Prepare | summary |
| 20 | `contradictions_tab` | Contradiction Tracker | Analysis | Issues & argument | Argue | summary |
| 21 | `risk_matrix_tab` | Risk Matrix | Analysis | Issues & argument | Argue | summary |
| 22 | `vdm_matrix_tab` | Defence & Rebuttal | Analysis | Issues & argument | Argue | summary |
| 23 | `info_required_tab` | Info Required | Analysis | Issues & argument | Desk | summary |
| 24 | `witness_tab` | Witnesses | Analysis | Parties & witnesses | Argue | summary |
| 25 | `conflict_tab` | Conflict Check | Analysis | Parties & witnesses | Admin | summary |
| 26 | `enforcement_tab` | Enforcement Roadmap | Litigation strategy | Issues & argument | Argue | summary |
| 27 | `legality_tab` | Legality & SIU Risk | Litigation strategy | Issues & argument | Argue | summary |
| 28 | `prescription_tab` | Prescription | Litigation strategy | Issues & argument | Argue | summary |
| 29 | `interest_calc_tab` | Interest Recalculator | Litigation strategy | Money | Numbers | summary |
| 30 | `payments_tab` | Payments & Net Claim | Litigation strategy | Money | Numbers | summary |
| 31 | `elements_tab` | Cause of Action | Litigation strategy | Issues & argument | Argue | summary |
| 32 | `authorities_tab` | Authorities | Litigation strategy | Issues & argument | Argue | summary |
| 33 | `heads_tab` | Heads of Argument | Litigation strategy | Issues & argument | Argue | summary |
| 34 | `crossexam_tab` | Cross-Exam Prep | Litigation strategy | Court & procedure | Prepare | summary |
| 35 | `settlement_tab` | Settlement / BATNA | Litigation strategy | Money | Numbers | summary |
| 36 | `privilege_tab` | Privilege Log | Registers | Notes, time & registers | Record | summary |
| 37 | `popia_tab` | POPIA Register | Registers | Notes, time & registers | Record | summary |
| 38 | `annotations_tab` | Annotations | Registers | Notes, time & registers | Record | working |
| 39 | `transcriptions_tab` | Transcripts | Registers | Documents & evidence | Find | summary |
| 40 | `rescan_tab` | Rescan & Update | System | System | Admin | summary |
| 41 | `backup_tab` | Backup / Restore | System | System | Admin | summary |
| 42 | `manual` | Manual | System | System | Admin | summary |

Planned hosted capabilities: `hosted_intake` (Admin, simulated), `hosted_email` (Record), `hosted_kyc` (Admin), `hosted_billing` (Record), `hosted_audit` (Admin), `hosted_bundles` (Prepare). In A all six sit in the sidebar group "Hosted · planned".
