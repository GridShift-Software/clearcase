# ClearCase client demo UI specification — 5 November 2026

| Design tokens | Prototype CSS / computed value | Existing `src/app.css` / demo decision |
|---|---|---|
| Brand | `--navy #162436`, hover `#0F1A28`; `--teal #14B8A2`, hover `#0FA08D` | Local navy `#245F91`, focus same blue; adopt prototype navy/teal. Prototype teal is provisional artwork-derived colour, not independently verified brand guidance. |
| Surfaces | Canvas `#F7F8FA`; white surface; subtle `#F1F3F5` | Local `#F4F7FB / #FFF / #EEF3F9`; adopt prototype. |
| Text / borders | Primary `#162436`, secondary `#52606D`, tertiary `#7B8794`; borders `#E4E7EB / #CBD2D9` | Local `#17212D / #536477 / #5F6E81`, borders `#DCE5EE / #C7D3DF`; adopt primary/secondary/borders; retain readable contrast for small tertiary text. |
| Status foreground / tint | Success `#047857 / #ECFDF5`; warning `#B45309 / #FFFBEB`; danger `#B91C1C / #FEF2F2`; info `#1D4ED8 / #EFF6FF` | Local `#157C58 / #E8F5EF`, `#B97710 / #FBF1E0`, `#B74040 / #F8EBEB`, `#3071A0 / #EAF4FB`; apply prototype pairs with text labels. |
| Selection / tints | Teal selection `#E8F8F6`; navy pill/viewer `#E8E9EB`; teal pill `#D0F1EC`, text `#0B7A6B` | Local selected nav `#EAF2FA`; adopt prototype selection. Full 80/60/40/20/10 tint ladders are in `measurements.json`. |
| Typography | Declared Montserrat + system fallback; body 14/21 px, 400; h1 22/33, 600; card h2 14/21, 600; KPI 28/30.8, 600; table 13/19.5; th 11/16.5, 500, uppercase | Local system body, Schibsted Grotesk brand, Instrument Serif case title; h1 22/29.7, KPI 22/28.6. Prototype actually rendered **Liberation Sans**, confirmed by Chromium font inspection; it contains no Montserrat font asset. Use declared scale; self-host Montserrat if supplied, otherwise explicitly accept system fallback and remeasure. |
| Geometry | Sidebar 240 px; topbar 56; main padding 24; grid gap 16; card padding 20; content max 1440 | Local nav 240, header 64, content max 1280, main desktop content 964 at this viewport. Adopt prototype desktop shell; mobile specification below. |
| Controls / tables | Buttons/inputs 36 px high, small buttons 30; button 13 px/600; pills 20 high, 11 px/500, radius 999; headers 40 high; compact rows CSS minimum 36, regular 44; horizontal cell padding 12 | Local controls minimum 34/28; preserve wrapping/content growth. Actual compact rows vary: chronology 36, Documents first row 40, Deadlines first row 59.5. |
| Radius / shadows | Cards/controls 6 px; modal/tray 8; card `0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06)`; modal `0 20px 60px rgba(0,0,0,.3)` | Local radius 8, cards 10, large 18; local layered blue shadows and gradient primary buttons. Adopt prototype flat navy buttons and light card shadow. |
| Focus | Prototype 2 px teal outline, 2 px offset; local 3 px blue, 2 px offset | Preserve visible keyboard focus; use a sufficiently dark outline on white and teal surfaces. Retain local focus handling and labelled scroll regions. |

Research basis: 28 October 2026, local `dev` HEAD **`1ed4b6342d22ceca64b4f98e6d7363117692144e`**; existing Bun 1.4.2 build `e2094669bdd34ff2`, stamped dirty, same revision. No product edits, build, commits, deployment or case-data writes performed.
Sources: `.local/partner-prototype-v0.1.html` (CSS, `NAV`, `RENDER`, viewer); current rendered local app; component sources below; `worktrees/sprint-hosted-demo-20261105/docs/sprint/{README,port-map}.md`; earlier `.orchestration/reports/recovery-20261028/astra-local-baseline.md` and its inventory/mapping CSVs. Skill used: `research` (primary-source method; no nested delegation).
Evidence: **E = `.local/astra/ui-spec/`**, **S = `.local/astra/ui-spec/screens/`**. Screenshot notation `name-{1440,390}.png` names two actual files, one at each width. Raw selector rectangles, computed styles and variables: `E/measurements.json`; added document/entity/layout/font/keyboard/PDF measurements: `E/details.json`; notes/register/builder counts: `E/final-probes.json`. Scripts and receipts are beside them; screenshots and raw rendered text are private/ignored.
Measurement convention: desktop **1440×1000**, mobile **390×844**, CSS pixels, default zoom; rectangles from `getBoundingClientRect`, styles from `getComputedStyle`, rounded to 0.1 px. Browser: specified Chromium 148 through `orch-bin/browser-lock`, repository Playwright. No hosted system was inspected.
Evidence status: doctor PASS and initial measurement receipt PASS at the stated HEAD. Detail and final-probe commands completed successfully, but both receipts **FAIL**ed because the checkout fingerprint changed during execution; HEAD and tracked diff remained unchanged on inspection, with untracked `worktrees/` present. These observations are research evidence, not a release-gate PASS. Loading, failure and unpublished states below are source-backed or proposed unless explicitly marked observed.
Shared state requirement: preserve shell and heading while loading; announce loading/status and errors, offer retry without clearing filters or unsaved input. Empty dataset, zero filter matches, unpublished results and unported view are distinct. `C/ResultsState.svelte` supplies pending/withdrawn/unavailable publication messages; local active results are **not proof of hosted publication**. Never populate an unavailable screen with prototype sample values.
Source shorthand: **C = `src/lib/components/`**, **V = `src/lib/views/`**, **R = `src/routes/v/[vid]/`**; route names below end in `+page.svelte` unless stated otherwise. Shared tokens above apply to every screen; exceptions appear in each section.
Common measured placeholder: prototype title at (264,80), 22/33 px; desktop card (264,154.5), **1152×324.5**, inner empty region **1110×282.5**, padding 48×24 inside a 20 px padded card. At 390 the card is **705.6×345.5**, empty region **663.6×303.5**, still at x264. This is overflow, not a mobile layout.
Mobile recommendation for all screens: retain local 16 px side padding and 358 px usable content; replace persistent sidebar with a labelled navigation toggle/drawer, wrap page actions, stack cards. Keep wide tables inside labelled keyboard-scrollable regions, or retain existing analysis row cards. A drawer is new work; local scrollable navigation is an acceptable fallback. Do not copy prototype overflow.

## 1. App shell

- **Layout:** prototype sidebar (0,0) 240×1000; topbar (240,0) 1200×56; main (240,56) 1200×944; content x264, width 1152. Nav rows 36 high, 13 px text, 3 px active teal edge; group labels 11 px. Search measures 180.2×36 despite a 560 px CSS maximum; freshness 292.9×18, with 8 px teal dot and 12 px text on transparent background; four-surface switch 411×36. At 390, sidebar remains 240, topbar/main expand to753.6, page width 994; search shrinks 74, freshness wraps to54 high.
- **Components/interactions:** restyle `C/ViewNav.svelte` and `R/+layout.svelte`; retain real links, `aria-current` and saved per-view filter queries. Prototype has 36 numbered nav entries including duplicates; local has 42 views. Group actual demo routes under the prototype headings and retain People/Entities/Witnesses/Quantum. Global search goes to `R/evidence/search`; Ctrl/Cmd+K focuses it, Enter searches. Remove the prototype surface selector from the client shell.
- **Data:** case display name; active route; published version label, publication timestamp, document count. Local currently shows case name, active/candidate banner and results-produced date, plus Cases/Import results links; no global search or published-version pill. **Case switcher:** use All cases → choose case, with current case identified. **Sign-out:** explicit account action; neither prototype nor this local app has it, so hosted implementation/verification remains required.
- **States:** common loading/error/publication contract; case list empty state with safe return route; unpublished pill must not be green or say Published. Keep version date and source-production date distinct; do not substitute local build time for publication time.
- **Keyboard/accessibility:** prototype Ctrl+K and Space activation of nav were observed working; skip link exists. Retain semantic anchors rather than prototype `div[role=button]`; label navigation toggle, return focus when it closes, expose selected case, keep sign-out reachable.
- **Gaps/decision:** **follow prototype** desktop shell/tokens; **keep local** route semantics; add client search/freshness/account controls. Defer duplicate destinations, operations surfaces and floating tray. Local mobile has no page overflow but its 196 px navigation panel pushes content to y426.5; drawer would reclaim that space.
- **Screens:** `S/proto-overview-{1440,390}.png`, `S/local-overview-{1440,390}.png`.

## 2. Overview

- **Layout/tokens:** prototype four 276×122.8 KPI cards,16 gap, starting y154.5; next row 762.7/373.3 wide; lower row 568/568. At390 it remains four 164.4×160.4 cards, then 465.1/224.5 columns, overflowing. Apply common 6 px cards,28 px KPI values,14 px headings. Local currently has 10 tiles in three 310.7 px columns, then one 358 px column on mobile.
- **Components/interactions:** `R/overview`, `C/OverviewSlots.svelte`, `V/registers/TileWidget.svelte`, `V/system/FreshnessWidget.svelte`, `C/Narrative.svelte` and `CitationLink.svelte`. Prototype tiles navigate; quick links and deadlines table have real local destinations. Make clickable tiles anchors with visible labels.
- **Data:** Documents indexed **1,689**, Amount due (source amount/as-at/ref), Invoices **307**, Contradiction flags **33 / 25 high**, Without extracted text **255**, Open deadlines **1**, Unbilled time, Freshness, Originals, My notes **2**. Also narrative, date span, bundle/type/text-status tallies and citations. Source-caption discrepancies must remain distinguishable from counted totals; two originals are missing.
- **States:** common loading/error/publication; missing narrative/quantum displays unavailable section text; zero notes/deadlines is a valid count. Do not render absent financial data as zero. Prototype has no asynchronous state examples.
- **Keyboard/accessibility:** heading hierarchy, labelled KPI links, readable count descriptions; avoid prototype onclick-only card divs and anchors without href. Announce refreshed counts without moving focus.
- **Gaps/decision:** **follow prototype** four primary tiles (documents, deadlines, source amount, bundles only if count is available), supporting cards and spacing; **keep local** provenance and truthful totals. **Defer** “What changed since you last opened”, reviewer claims and lawyer-pack action until backed by actual data/actions.
- **Screens:** `S/proto-overview-{1440,390}.png`, `S/local-overview-{1440,390}.png`.

## 3. Chronology with split-pane viewer

- **Layout/tokens:** prototype toolbar below 54.5 px heading; split at (264,202.5),1152×794: list 706.3, divider 8, viewer 437.8. CSS is `minmax(600px,1fr) 8px minmax(340px,38%)`, height `100vh - 206px`, minimum 520. At390: split 705.6×638 at y246.5, children 600+8+340 overflow; viewer begins x872. Use 36 px compact rows,40 px header and teal selected-row tint. Mobile recommendation: list then a full-width document view, with Back preserving filters/selection.
- **Components/interactions:** `R/chronology`, `C/DataGrid.svelte`, `TableScroll.svelte`, `DateValue.svelte`, document route and `OriginalOpen.svelte`. Local filters text/ref/filename, bundle, type, text status; sorts headers, exports filtered CSV and opens citation detail. Prototype row selection fills preview; implement that using actual document/original payloads. Divider is only visual in prototype: defer draggable resizing or implement keyboard resizing too.
- **Data:** **1,689** completed rendered rows; Date, Ref, Title / subject, Type, Bundle, Amount, Status, Original. Date basis appears only when supplied; this sample has no basis column. Subject can include sender/excerpt/also-in information. Local statuses include extracted/OCR/none/pending and original availability; retain these distinctions instead of prototype's generic “ok”.
- **States:** shared loading/error/publication; viewer needs no-selection, loading, missing-original and download-only states. Observed no-match filter gives 0 rows and a live count but no explanatory panel: add “No documents match” with Clear filters. Keep list usable if preview fails.
- **Keyboard/accessibility:** local Enter on Date sort changed `aria-sort` to descending; count is a polite live region. Add a keyboard-operable Preview control per row, retain document links, label iframe, and preserve selection when returning. Prototype row onclick alone is insufficient.
- **Gaps/decision:** **follow prototype** desktop split composition; **keep local** filters, sorting, citations, exports and real viewer. **Defer** Save view, Bundle from filter, date-range and annotation filters unless implemented; prototype controls are largely decorative/toast-only. Do not copy its fictitious pagination.
- **Screens:** `S/proto-chronology-{1440,390}.png`, `S/local-chronology-{1440,390}.png`, `S/local-chronology-empty-{1440,390}.png`.

## 4. Documents list

- **Layout/tokens:** prototype heading→38 px tabs→full-width card at y204.5,1152×1053; table headers 40 high, first data row 40. At390 card 705.6×1690.8 starts y224 and overflows. Use white card, subtle header,6 px radius; retain local responsive table containment and 358 px mobile content.
- **Components/interactions:** `R/evidence/documents`, `C/PageHeader.svelte`, `TableScroll.svelte`, `CitationLink.svelte`. Local bundle buttons select a subset, Filter in bundle narrows it, document links open details. Prototype's Documents/Rescan tabs are inert; rescan belongs to operator/local tooling.
- **Data:** rendered local columns Ref, Type, Date, Title, Amount, Status, Doc; first selected bundle contains 60 rows, across 5 bundle choices for 1,689 documents. Prototype columns instead are Ref, File, Format, How it opens, Pages, Size, Text, Open, Original. Show only metadata supplied by the real model; do not invent page counts or verified-link totals.
- **States:** common loading/error/publication; distinguish empty bundle from zero filter matches; retain failed-row disclosure (`C/DegradedRows.svelte`) and missing originals without losing the list.
- **Keyboard/accessibility:** bundle selectors expose pressed state; labels stay visible; document links have useful accessible names; scroll region takes focus only when overflowing. Label row actions with the document reference.
- **Gaps/decision:** **follow prototype** table styling; **keep local** fields, bundle filtering and route navigation for demo. Defer Verify links, rescan tab and format-specific preview promises; add direct Open/Download only when real original links are available.
- **Screens:** `S/proto-documents-{1440,390}.png`, `S/local-documents-{1440,390}.png`.

## 5. Document page and original PDF

- **Layout/tokens:** prototype has a modal, not a standalone detail page: desktop (170,70),1100×860,55 px header, body 784 px viewer +16 gap+300 px metadata. Paper 640×820 minimum, padding 48×56,12 px Times New Roman/1.7; metadata 12 px. At390 modal 366.6×725.8, header 130 high, viewer only 50.6 wide beside 300 px metadata: unusable. Local page is964 wide desktop/358 content mobile; retain stacked detail on mobile.
- **Components/interactions:** `R/doc/[ref]`, `C/OriginalOpen.svelte`, `DateValue.svelte`, `CitationLink.svelte`; local viewer under `src/lib/local-case/viewer/`. Citation→detail→Open launches the isolated PDF tab; Download is separate. One actual original's first PDF page rendered in this run; outer iframe 1440×964 below a36 px bar. No performance claim from this probe.
- **Data:** sampled detail shows Date, Filename (source), Type, Bundle, Amount, Size (source claim), Text status; Original includes media type, verified byte count/hash and availability. Conditional sender/recipient, attachment-parent links, extracted attachments, related documents and excerpt remain supported. My notes contains note body/date and anchoring status; do not present excerpt as full document text.
- **States:** actual PDF success observed; source defines missing-on-disk, originally missing, parent-contained, no original and download-only. Proposed preview loading/error must preserve Download and document metadata. Do not show a fake paper preview for unavailable originals; common publication guard applies to derived results.
- **Keyboard/accessibility:** keep labelled Open/Download and document fields with row headers. Prototype Escape closes modal, but opening did not move focus inside it; modal lacks focus containment/return. If modal is later adopted, supply accessible title, focus entry/trap/return and Escape. Label new-tab behaviour and embedded viewer.
- **Gaps/decision:** **keep local** standalone document and real PDF tab for the demo; **follow prototype** card/toolbar tokens. The desktop chronology pane satisfies the immediate preview need. **Defer** full modal, copy-citation action and claims that every Office/media format has a rendered preview.
- **Screens:** `S/proto-document-{1440,390}.png`, `S/local-document-{1440,390}.png`, `S/local-original-{1440,390}.png`.

## 6. Matter & Strategy

- **Layout/tokens:** prototype only the common measured placeholder at both widths. Local renders two 474 px narrative cards with 16 gap; mobile stacks 358 px cards. Keep that layout with prototype 20 px padding,6 px radius,14 px section headings and 14/21 body.
- **Components/interactions/data:** `R/analysis/matter`, `C/Narrative.svelte`, `PageHeader.svelte`; Storyline and Strategy Memorandum, **11** total subsection headings with narrative and source citations. Citation links lead to document detail; no editing controls.
- **States:** common loading/error/publication; source supplies “No matter narrative” and per-card “No items” states. Not-yet-ported goes to the separate placeholder, not empty narrative.
- **Keyboard/accessibility:** semantic section headings and real citation links; preserve readable paragraph width and logical reading order when stacked.
- **Gaps/decision:** **keep local** content and two-card structure; **follow prototype** shared tokens. Prototype supplies no substantive matter layout to copy.
- **Screens:** `S/proto-matter-{1440,390}.png`, `S/local-matter-{1440,390}.png`.

## 7. Contradiction Tracker

- **Layout/tokens:** prototype common placeholder. Local four 229 px KPI cards/16 gap at 1440; two 171 px columns at 390; full-width category tables become labelled row cards below 40rem. Adopt prototype KPI28 px, status pairs and 6 px cards without changing that responsive structure.
- **Components/interactions/data:** `R/analysis/contradictions_tab`, `C/CitationLink.svelte`, `TableScroll.svelte`; Export CSV. **33 flags,25 high**, four categories with 6/19/7/1 items;2 consistency checks. Columns: Check/Result; rate table Month/Bid rate/Old rate/New / standard/Spread/Sources; other categories Item/Detail/Sources. Preserve computed/imported provenance.
- **States:** common loading/error/publication; source distinguishes absent contradiction data from no categories; missing citation remains visibly unresolved. No fabricated zero flags during loading.
- **Keyboard/accessibility:** export is a button, sources are links; category headings and text severity labels accompany colour. Keep mobile `data-label` cells and semantic table headers.
- **Gaps/decision:** **keep local** grouping, severity and CSV; **follow prototype** tokens. Do not replace working analysis with its prototype placeholder.
- **Screens:** `S/proto-contradictions_tab-{1440,390}.png`, `S/local-contradictions_tab-{1440,390}.png`.

## 8. Risk Matrix

- **Layout/tokens:** prototype common placeholder; local full-width 964 px table,358 px mobile content with stacked labelled rows. Apply common subtle header,6 px surface and textual status badges.
- **Components/interactions/data:** `R/analysis/risk_matrix_tab`, `C/TableScroll.svelte`, `CitationLink.svelte`; **6 rows**, Issue/Likelihood/Impact/Mitigation. Category, Owner, Documents and numeric likelihood/impact scores are conditional on supplied data; absent in this sample's columns.
- **States:** common loading/error/publication; source empty state is “No risk matrix in this results version”; missing fields are not zero risk. Unported is separate.
- **Keyboard/accessibility:** row labels remain available on mobile; likelihood and impact are words, not colour alone; citations are keyboard reachable when present.
- **Gaps/decision:** **keep local** four-column matrix and responsive cards; **follow prototype** shared tokens. Defer an invented heatmap, scoring controls or owners not present in the data.
- **Screens:** `S/proto-risk_matrix_tab-{1440,390}.png`, `S/local-risk_matrix_tab-{1440,390}.png`.

## 9. Defence & Rebuttal

- **Layout/tokens:** prototype common placeholder; local 964 px table with multiline evidence; mobile 358 px labelled row cards. Use common white surface/subtle headers,13 px table text; preserve citation chips and wrapping.
- **Components/interactions/data:** `R/analysis/vdm_matrix_tab`, `C/Narrative.svelte`, `CitationLink.svelte`, `TableScroll.svelte`; **8 rows**. Rendered field labels are DCS point, DCS case, ESS supporting evidence, Documents, ESS rebuttal (field names only; no case assertions reproduced here).
- **States:** common loading/error/publication; source's absent-matrix state, missing cell values and unresolved citations remain distinct from an unported view.
- **Keyboard/accessibility:** citations remain anchors; column/row labels preserve opposing-position versus rebuttal meaning at 390; avoid truncating long arguments to inaccessible hover-only text.
- **Gaps/decision:** **keep local** evidence-linked matrix; **follow prototype** tokens; defer editing or additional argumentative content.
- **Screens:** `S/proto-vdm_matrix_tab-{1440,390}.png`, `S/local-vdm_matrix_tab-{1440,390}.png`.

## 10. People

- **Layout/tokens:** no People screen/navigation entry in prototype, so no screen-specific prototype rectangle exists; use measured shell/card/table tokens, not Organogram as a substitute. Local964 px table region,358 px mobile content, labelled horizontal scrolling as needed.
- **Components/interactions/data:** `R/evidence/people`, `C/TableScroll.svelte`; **42 rows**, Name/Email/Organisation/Sent/Received/Total. Role (inferred, unverified) appears only when supplied. Automated-address hints and the unverified-identity disclosure are part of the view; no person-profile interaction was shown.
- **States:** common loading/error/publication; source warns when the people dataset is absent; add explicit empty-dataset wording for an empty array instead of a blank table.
- **Keyboard/accessibility:** keep table headers and focusable overflow region; email addresses are readable text, not unverified identities or implied mail actions.
- **Gaps/decision:** **keep local** table and disclosure; **follow prototype** tokens; add a real nav entry. **Defer** organogram/profile cards and inferred relationships.
- **Screens:** `S/local-people-{1440,390}.png`; prototype shell reference `S/proto-overview-{1440,390}.png`.

## 11. Entities

- **Layout/tokens:** no corresponding prototype screen; shared measured shell/card/table tokens apply. Local964 px table region,358 px mobile content, long notes wrap; keep labelled table overflow.
- **Components/interactions/data:** `R/evidence/entity_ledger_tab`, `C/TableScroll.svelte`; **22 rows**, Entity/Role/Note, with imported/unverified disclosure. No entity-edit interaction in the local screen.
- **States:** common loading/error/publication; source warns for absent dataset; provide explicit zero-entities text for empty array. Never infer an entity relationship from missing data.
- **Keyboard/accessibility:** table headings, clear disclosure, wrap long names/notes; preserve keyboard access to any overflowing region.
- **Gaps/decision:** **keep local** ledger; **follow prototype** tokens; add navigation. **Defer** relationship graph or verification badges unsupported by source data.
- **Screens:** `S/local-entity_ledger_tab-{1440,390}.png`; prototype shell `S/proto-overview-{1440,390}.png`.

## 12. Witnesses

- **Layout/tokens:** no Witnesses prototype screen; apply common measured card/table tokens. Local full-width 964 px table;358 px mobile content uses analysis stacked rows. Keep narrative cells variable-height.
- **Components/interactions/data:** `R/analysis/witness_tab`, `C/TableScroll.svelte`, `Narrative.svelte`; **3 rows**, Witness/Role/Will say. Source content and citations are rendered as provided; no witness editing or contact action is shown.
- **States:** common loading/error/publication; use existing no-witnesses state for absent rows, preserving a separate unported placeholder.
- **Keyboard/accessibility:** preserve narrative link semantics and labelled mobile cells; do not imply imported anticipated testimony has been verified.
- **Gaps/decision:** **keep local** three-column view; **follow prototype** tokens; add navigation. Defer profile portraits, contact buttons and witness management.
- **Screens:** `S/local-witness_tab-{1440,390}.png`; prototype shell `S/proto-overview-{1440,390}.png`.

## 13. Timeline

- **Layout/tokens:** prototype common placeholder. Local vertical cards 964 px desktop/358 mobile: synopsis, year histogram, phase/event list, correspondents, evidence notes. Retain its 140 px histogram region and chronological narrative; restyle navy bars and 6 px cards.
- **Components/interactions/data:** `R/analysis/timeline`, `C/CitationLink.svelte`, `TableScroll.svelte`; Print / PDF, Full chronology and event citations. **81 events in 7 phases**, with Date/Kind/Ref/Title/Note; year counts and an8-row correspondents table (Name/Email/Organisation/Touchpoints).
- **States:** common loading/error/publication; preserve no-events/no-correspondents sections; source marks this as a working chronology. Do not fill missing phases with prototype text.
- **Keyboard/accessibility:** phase headings, event list/listitem semantics, descriptive citation links; retain textual counts alongside histogram bars and print-friendly reading order.
- **Gaps/decision:** **keep local** timeline and print behaviour; **follow prototype** tokens. Defer zoom/pan or interactive timeline controls not present locally.
- **Screens:** `S/proto-timeline-{1440,390}.png`, `S/local-timeline-{1440,390}.png`.

## 14. Litigation representative — Heads of Argument

- **Layout/tokens:** prototype common placeholder. Local header/actions→add-submission form→964 px table,358 px mobile content; controls wrap vertically. Use36 px controls,6 px radius and common table styling.
- **Components/interactions/data:** `R/litigation/heads_tab`, `C/TableScroll.svelte`, `CitationLink.svelte`, `V/litigation/EntryState.svelte` and `DeleteCell.svelte`; form Heading/Submission/Authority/Evidence ref(s), Add and Export; row columns #/Heading/Submission/Authority/Evidence/actions. Observed **0 submissions**, represented by one spanning empty-message row, not one record.
- **States:** common loading/error/publication; observed empty skeleton; source supports mutation error and deletion handling. Do not enable hosted writes until the corresponding user-work actions are connected; read-only rendering is sufficient for the core analysis demo.
- **Keyboard/accessibility:** explicit form labels, predictable tab sequence, keyboard-operable delete confirmation, evidence links and labelled scroll region.
- **Gaps/decision:** **keep local** structure/field contract; **follow prototype** tokens. Defer generated submissions and authoring promises if hosted actions are outside the port.
- **Screens:** `S/proto-heads_tab-{1440,390}.png`, `S/local-heads_tab-{1440,390}.png`.

## 15. Quantum representative — Quantum & Interest

- **Layout/tokens:** no Quantum prototype screen; use common shell/card/KPI tokens. Local964 px content with KPI cards and tables;358 px mobile content; invoice ledger has 460 px maximum scroll height. Keep money right-aligned with tabular numerals.
- **Components/interactions/data:** `R/quantum/quantum_tab`, `V/quantum/Kpi.svelte`, `C/TableScroll.svelte`, `CitationLink.svelte`; source PDF link and invoice CSV export. Running balance **55 rows**: As at/Ref/Amount due/Source; invoice ledger **307 rows**: Ref/Invoice/Date/Amount/Doc; headline amount, latest computation, invoice count, gross invoiced and charging/statements links.
- **States:** common loading/error/publication; absent quantum state and reconciliation warnings remain visible; missing amount is “—”, not zero. These are imported/source computations, not a newly calculated claim.
- **Keyboard/accessibility:** source links, labelled scroll regions, semantic numeric columns; retain warning text and source/as-at labels with any displayed total.
- **Gaps/decision:** **keep local** reconciliation and provenance; **follow prototype** tokens. Do not substitute the prototype Overview's illustrative monetary figure or introduce a new calculator.
- **Screens:** `S/local-quantum_tab-{1440,390}.png`; prototype shell `S/proto-overview-{1440,390}.png`.

## 16. Notes

- **Layout/tokens:** prototype Annotations navigation is the common placeholder; document-modal annotation panel is300×805 desktop/300×595.8 mobile, with 12 px labels. Local My notes is a document card: form 922×137.5 desktop,324×137.5 mobile. Use full-width textarea,14 px readable note body and common card tokens; proposed case Notes list uses 358 px mobile content.
- **Components/interactions/data:** document notes live in `R/doc/[ref]`; case summary lives in `R/overview`. Observed **2 saved notes on one document**, and a second document's empty note list. Fields are note body, created time, document reference and anchoring/integrity state. Separate `R/registers/annotations_tab` + `V/registers/RegisterPage.svelte` has Doc ref/Date/Note/actions and **1 existing row**; do not conflate that register with anchored document notes.
- **States:** observed populated/empty document notes; source keeps text on save error, locks editing while saving and reports refused saves; ambiguous, reattached and integrity-warning states exist. Provider documents can refuse notes without an imported anchor. Case-owned notes remain available when results are unpublished where hosted permissions allow; do not replace them with a results placeholder.
- **Keyboard/accessibility:** textarea label, save button and alert errors; announce Saving/Saved, keep focus and draft after failure; confirmations for destructive actions should restore focus. Prototype Save note only toasts and does not persist a note.
- **Gaps/decision:** **keep local** anchored notes semantics; **follow prototype** card styling. A unified case Notes page and page-note aggregation are new S11 work, not an existing reusable Notes component. **Defer** team-visibility claims absent a verified access model; if stretch work misses, show Coming soon for case Notes and expose only working document notes.
- **Screens:** `S/proto-annotations_tab-{1440,390}.png`, `S/local-notes-populated-{1440,390}.png`, `S/local-notes-390.png` (empty), `S/local-annotations_tab-{1440,390}.png`.

## 17. Deadlines

- **Layout/tokens:** prototype 762.7 px tracker +16 gap+373.3 px side column at 1440; form 383 high, calculator 400 high. At390 they remain 465.1/224.5, overflow, with calculator 435 high. Use common status pills and table typography; mobile stacks list then form, with full-width fields.
- **Components/interactions/data:** `R/registers/deadlines_tab`, `V/registers/RegisterPage.svelte`, `C/ConfirmDelete.svelte`; local Add/Edit/Delete and .ics export. Observed **1 deadline**; columns Date/Countdown/Title/Category/Note/actions; form Title/Date/Category/Note. Prototype additionally shows Owner/Ref/Done, reminder ladder, Outlook actions and calculator, which are not in this local register.
- **States:** common loading/error; no-deadlines text; overdue/today/future countdown, save/delete busy, preserved-input error and concurrent-change handling from RegisterPage. Deadlines are user work, so unpublished results must not silently remove them. Hosted availability is S11 stretch.
- **Keyboard/accessibility:** native labelled date/category inputs; countdown words accompany colour; saving/deleting statuses and alerts; confirmation buttons reachable without a pointer.
- **Gaps/decision:** **follow prototype** visual split only if it improves available space; **keep local** actual fields, CRUD and .ics. **Defer** court-day calculator, rule templates, owner assignment, reminders and Outlook sync; their prototype simulation is not accepted behaviour.
- **Screens:** `S/proto-deadlines_tab-{1440,390}.png`, `S/local-deadlines_tab-{1440,390}.png`.

## 18. Court Bundle

- **Layout/tokens:** prototype at y204.5:762.7 px sections +16 gap+373.3 px checks/output/versions column; section gap 12, white rows,6 px borders. At390 columns 465.1/224.5 begin y296 and overflow. Fixed tray 360×91 at right/bottom 24 covers content; defer tray. Local list and composer occupy 964 px desktop/358 px mobile content.
- **Components/interactions/data:** `R/bundles/court_bundle_tab`, `V/bundles/Builder.svelte`, `C/TableScroll.svelte`, `ConfirmDelete.svelte`. Observed **15 bundle-list rows**: No./Bundle/Items/Pages/Status/actions. Header editor: Court line, Division / presiding officer line, Introductory line, Case number, Plaintiff / claimant citation and label, Defendant / respondent citation and label. Composer: Add PDFs, description, source page ranges, page count/numbering, reorder/remove, bundle name, Create Bundle, index PDF/Word and save to list.
- **States:** observed empty composer with Create Bundle disabled; source supports missing source PDFs, progress, assembly/save errors and retry. Distinguish persisted item list from available assembled file. Earlier baseline reports saved PDF unavailable after reload; persistence was not retested here. Imported bundles need published results; custom user work needs its own availability treatment.
- **Keyboard/accessibility:** retain labelled file input, page-range fields, Move up/down controls (not drag-only), status announcements and delete confirmation. Keep table scroll regions reachable and output links labelled by format.
- **Gaps/decision:** **keep local** working builder/list and index exports; **follow prototype** cards. S12 is stretch: assembled PDF persistence is a demo readiness condition before claiming saved bundle reopening works. **Defer** tray, privilege override/audit promises, version comparison, sharing, server queue notifications and split-email output shown only as prototype toasts.
- **Screens:** `S/proto-court_bundle_tab-{1440,390}.png`, `S/local-court_bundle_tab-{1440,390}.png`, `S/local-court-builder-{1440,390}.png`.

## 19. Coming soon / not yet ported

- **Layout/tokens:** use the common measured prototype placeholder:1152×324.5 desktop card;705.6×345.5 overflowing at 390. Target mobile is358 px card with wrapped text; centred 48 px icon,15 px/600 heading,14 px body,36 px Back to Overview action,6 px radius and light shadow.
- **Components/interactions/data:** `C/UnavailableView.svelte` + `PageHeader.svelte`; prototype `notBuilt()` shows heading number, “Specified, not prototyped” and Back to Overview. Local generic route `R/[category]/[view]/+page.svelte` is the existing fallback. Show the view name, “Coming soon” and a return link; show **no results/counts/sample rows**.
- **States:** this is explicitly unported, never loading, empty case, access denied or unpublished. Use `C/ResultsState.svelte` for publication states instead. A failed working screen must offer retry rather than masquerading as Coming soon.
- **Keyboard/accessibility:** one main heading; focus heading after navigation; return link; informative icon hidden from assistive technology if redundant; current nav item remains identifiable and state is expressed in text.
- **Gaps/decision:** **follow prototype** card composition; **keep local** fallback mechanism. Replace developer-facing issue owner/blocker copy with client language. Use for genuinely unported prototype-only destinations, not for analysis views with working hosted ports.
- **Screens:** `S/proto-organogram_tab-{1440,390}.png`; other measured prototype placeholders are listed with their corresponding sections. No local unported route was fabricated for this research.

Cleanup: all research browsers closed; `PORT=41192 bun run --bun start --stop` stopped the app and originals server. Evidence retained under E; product tracked diff unchanged.
