# GRS-89 navigation prototype

A throwaway UX prototype. It asks: **where should users find existing capabilities in a large legal case, while keeping evidence context and quick work on a phone (notes and time)?** It is not app code. It touches no route, store or auth of the app, and its case, people, documents and numbers are all invented. It is design research for a hosted, desktop-first product: not hosted implementation, not parity evidence, not client testing.

- Page: `src/routes/prototype/navigation/prototype.html`. One self-contained file with inline CSS and JS, no assets and no network.
- Launcher: `src/routes/prototype/navigation/serve.mjs`. The folder has no `+` files, so SvelteKit, the build and the route scanners in `tests/e2e/classes` ignore it.
- Research record, in this folder: [`source-audit-inventory.md`](source-audit-inventory.md) (what the two source audits found), [`r1-synthesis-and-response.md`](r1-synthesis-and-response.md) (round 1 methods, findings and this revision's response) and [`coverage-appendix.md`](coverage-appendix.md) (every destination, planned items and sources).

## Run and stop

```sh
bun run --bun prototype:navigation          # http://127.0.0.1:44189/prototype/navigation?variant=A
PORT=44190 bun run --bun prototype:navigation
bun src/routes/prototype/navigation/serve.mjs --stop   # same PORT; signals only the pid it recorded
```

The server listens on loopback only. It writes its pid to `.local/prototype-navigation-<port>.pid`, and `--stop` signals that pid only while it still runs this script. It sends a CSP that blocks every load, so the page cannot depend on the network. It reads the HTML on each request, so reload after an edit.

URL: `?variant=A|B&view=<id>&rv=<version>`, plus `sec` on Matter & Strategy and `q` on Advanced Search. The floating bar at the bottom left switches the variant (buttons, or Left and Right **only while a bar button has focus**) and holds a **simulated case role** control (see Notes). All user work lives in memory, is shared by both variants, and is lost on reload.

## Hypotheses

1. **A, Topic sidebar.** People find a capability fastest when every resource is listed, grouped by what it is about. Only the group you are in is open, a filter finds the rest, and "On this page" navigation keeps your place in long analysis. Quick work lives with its resource: the Timesheet, Notes, or a note form inline under a section. On a phone the sidebar is a modal drawer behind **Menu**, and the header keeps the Results version and the submission status.
2. **B, Task-led case desk.** People find a capability fastest when the top level is the job they are doing (Desk, Find, Argue, Numbers, Prepare, Record, System). Each job shows its tools as a wrapping strip (a disclosure on a phone) and its context in a rail beside the work (a disclosure at the top of the work on a phone). Quick capture of a note or time is one button away everywhere, as the **+ Capture** item in the phone's bottom task bar.

Shared by both, so that only navigation differs: the synthetic data, the case header and counts, global search (`/` focuses it), the forms and drafts, the original viewer, the overlay, Back and focus behaviour, publication-version selection, tables and style tokens (from `src/app.css`). The viewer opens beside the work on a desktop and as a full-screen sheet on a phone. These are deliberately identical so a preference for A or B cannot come from the viewer.

## Behaviour to try (synthetic data)

| Task | Where in A | Where in B |
| --- | --- | --- |
| Search all documents for "gearbox", open a hit at its cited page | header search | header search, or Find |
| Find any of the destinations | filter the sidebar; **All tools** | strip, **All tools**, or **More** on a phone |
| Chronology event to its issue and risk, and back | Case › Chronology, issue tag, then Risk link | Find › Chronology, same links |
| Go to one analysis section (Issue B) | Matter & Strategy, **On this page** | Argue, section chips; the rail lists that section's evidence |
| Open a citation, return to the same place | any citation; Escape, ✕ or browser Back | same, including rail citations |
| Start a note, leave, come back | inline form under a section | **+ Capture**; the header chip "unsaved draft" resumes it |
| Log billable time, then switch variant | Timesheet | **+ Capture** › Time, or Record › Timesheet |
| See submission status and publication | header chip, or Hosted · planned › Submissions | Desk › Submissions & publication |
| Switch to a newly published Results version keeping your place | version control in the header | same |
| Export a packet with a stated scope | Court & procedure › Court Bundle | Prepare › Court Bundle |

**Overlays.** Quick capture, More, A's drawer and the viewer open as sheets on a phone: one at a time, the page behind is inert, Tab stays inside, and Escape, the backdrop, ✕ or the browser Back button close them. On a desktop the viewer and the capture panel sit beside the work (not modal), and Back still closes the viewer first. Focus returns to the control that opened them.

**Drafts.** Text typed in a note, edit or time form is kept in memory when you navigate, close an overlay, press Escape, change the original's page or switch variant. A cue in the form says it is unsaved and offers Discard draft; a header chip lists drafts and resumes them. Reloading loses them. There is no backend persistence.

**Publication and submission.** Submissions & publication is a **planned hosted capability, simulated**. It separates what you sent (uploading, finalized, input revision), how far it has got (not started, with an operator, finished) and what is published (which Results version is active), each with a timestamp. Processing is manual, so **no percentage is shown anywhere**. A walled-off box lets you play the operator (start processing, publish Results v4); afterwards the header version control and a banner let you switch versions and keep your page, section, search, filters and drafts.

## Decision record: Notes (settled by the user, 15 October 2026)

These were open questions in the first brief. They are now decisions, and the prototype shows them. The parent records them in Linear.

- **One contextual Notes feature**, preserving all existing records, each note linked to the case, a document and page, or an analysis section.
- **Default visibility: users assigned to the case**, within the same case-permission boundary. The label is "Shared with assigned case users". Notes never cross cases.
- **Users** can edit and delete their own notes. **Case editors** can also manage other people's notes. **An audit history is retained.** **Case viewers** only read: they cannot create or change notes.
- **Exports:** shared case notes are **excluded from client packet exports by default**, included only when explicitly selected, and the selected scope is shown before download (Court Bundle).

Simulated here: the role control in the prototype bar (case viewer, assigned case user, case editor) stands in for case permissions, and the history is an in-memory list. **No authorization, audit trail, case isolation or storage is built or verified.** Mapping existing records (the document page's "My notes", keyed by ref and original fingerprint, and the `annotations_tab` register) into Notes is implementation work. The Annotations view keeps its v5 id and label so that the 42 stay intact.

## What works and what is a placeholder

Working, on in-memory synthetic data: Overview, Matter & Strategy (six sections, eight cited originals), Chronology (412 events, issue and risk links), Risk Matrix (three illustrative risks), Documents (1,214 rows, 16 needing a manual read), Advanced Search, Timesheet, Annotations (the Notes home), Deadlines, Court Bundle (packet export only), the All tools catalogue, and Submissions & publication (a simulation).

The 32 other v5 views are **summary placeholders**. They show what the view holds, a synthetic size, and its v5 group, A topic and B task, and can take a note.

**Planned capabilities (not in the 42; none works)**, each labelled Planned: case destinations Submissions & publication (simulated), Emails, Email silences, Anchors, Organogram, WhatsApp, Privilege suggestions, Email drafts/templates/Outlook, KYC, Billing, Audit log, Bundle builder (uploads); platform destinations Case list, Team, Notifications; and three **operator-only** surfaces (import and validate, private preview and correct, sign-off and publish), which appear **only** in the All tools catalogue, in a separate private block, and in neither variant's navigation. Their scope notes come from `docs/reference/route-map.md` and `docs/product-brief.md`; no endpoint is verified. See the coverage appendix.

Packet export writes a CSV (documents only) and a JSON manifest as in-browser downloads, both labelled PROTOTYPE. It does not assemble a PDF.

## Known limitations

- Navigation evidence only. It does not show how any specialty view should look, and the placeholders are not designs.
- The simulated original is generated text, not a page image. Pages of the 16 "manual read" documents show a no-text state.
- Ids, labels and v5 groups match `src/lib/components/view-registry.ts` at base `8693ed8`, checked by script. The topic and task placements are this prototype's proposal, not an agreed taxonomy.
- The 42 v5 views are the parity target. The planned items are not counted in the 42, and the 42 are not equated with the 55 production routes in the route map.
- The audits' blind X/Y labelling, `?doc=` drawer and Ctrl+K palette are not built; see the response document for why.
- Browser layouts only, desktop first, plus 390 px. A future native desktop app is out of scope.
- "Today" uses the browser's date, and deadline day counts follow it.
- Checked by one reviewer with a scripted browser (Chrome via T3 preview, 1280x800 and 390x844) and `selfCheck()` in the page. No tests, by design; no screen reader, contrast, zoom or real phone keyboard. Reviewer scores are opinion, not usability evidence.

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
| 21 | `risk_matrix_tab` | Risk Matrix | Analysis | Issues & argument | Argue | working |
| 22 | `vdm_matrix_tab` | Defence & Rebuttal | Analysis | Issues & argument | Argue | summary |
| 23 | `info_required_tab` | Info Required | Analysis | Issues & argument | Desk | summary |
| 24 | `witness_tab` | Witnesses | Analysis | Parties & witnesses | Argue | summary |
| 25 | `conflict_tab` | Conflict Check | Analysis | Parties & witnesses | Find | summary |
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
| 40 | `rescan_tab` | Rescan & Update | System | System | System | summary |
| 41 | `backup_tab` | Backup / Restore | System | System | System | summary |
| 42 | `manual` | Manual | System | System | System | summary |
