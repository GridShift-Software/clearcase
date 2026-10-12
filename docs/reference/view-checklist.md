# v5 per-view behavior checklist

Reference: `ESS_DCS_Workspace.html` in `ESS_DCS_Lawyer_Pack_v5-002.zip` (main HTML sha256 `c0df43f7653c2feeea73f2634bfc14c379f5ccd07d15a5bb9bea29d4f8277e80`, built 2026-08-12 19:30). All 42 navigation entries come from the HTML's `NAV` literal, not from the stale manual.

How this was produced. The app code was read as text; nothing from the archive was executed to obtain this data. Three independent static reviews (one per view group) produced drafts with line references; the coordinator-run CLI (`python3 scripts/fixtures/inventory.py`) adds a reproducible static count per view: the live `RENDER.<id>` definition, handler sites (inline `on<event>=` attributes and `addEventListener` calls for user events in reachable code), download calls, `localStorage` keys and dataset reads. Representative screens were then captured offline (`unshare -rn`) to confirm selected behaviors; see [baseline.md](baseline.md). Line numbers refer to the main HTML. Case values are replaced by placeholders such as `<party>`, `<amount>`, `<case-abbrev>`, `<case-name>`, `<case-date>` and `<case narrative>`; the generator applies `scripts/fixtures/v5fixture/redact.py` to every free-text value, so every date except the build date, the fixed test clock and vetted synthetic example dates becomes `<case-date>`.

Terms. **Imported datasets** are produced by processing and embedded in the HTML: `DATA.<key>`, `META`, `window.__SCHED__`, `window.__CASELINES_IDX__`, plus code constants such as `NAV` and `STORE_KEYS`. **User-work stores** are browser `localStorage` keys written by people using the workspace (`ess_dcs_*`). `allRows()` returns `DATA.chronology` plus the user-work store `ess_dcs_rescan_v1`, so any view that calls it reads both. **Actions** and **form fields** follow the counting rule below; **handler sites** is the CLI's static count, which also counts sites in shared helpers (pagers, the freshness stamp) and is not expected to equal the action count; **nav sites** counts `data-tab` attributes, which the shell's global listeners route to another view.

## Counting rule

An **action** is one user-operable control, or one family of identical controls generated per row, whose own activation (click, key, change, input, drop or link follow) runs app code, navigates or opens a file. Each listed control is one action: controls with different labels or handlers are never merged (Prev and Next are two actions; five sortable headers are five). A **form field** is an `input`, `select` or `textarea` with no handler of its own whose value is only read by another action's handler (for example the inputs read by an Add button); fields are listed under **Form fields**, never counted as actions. One field bullet may name a group of inputs filled together. Display-only elements (KPI tiles, tables, tooltips, counters) are neither. The shared shell's controls are counted once, in the shell section, not in each view.

Every **Actions (N)** heading equals its bullet list, and so does every **Form fields (N)** heading; the summary table and the totals repeat those numbers. `python3 scripts/fixtures/count_actions.py` recounts the bullets of this file, checks every declared count and total, compares the handler and nav columns with `docs/reference/v5-summary.json`, and exits 1 on any difference.

## Summary

| # | View (id) | Group | Owner | Imported datasets | User-work stores | Actions | Fields | Handler sites | Nav sites | Exports |
| --: | --- | --- | --- | --- | --- | --: | --: | --: | --: | --- |
| 1 | Overview (`overview`) | Matter | CC-03 | chronology, contradictions, matter, quantum, META.builtAt, META.dateSpan, META.docCount, META.emails, META.people, META.textNone | deadlines_v1, rescan_v1, timesheet_v1 | 8 | 0 | 0 | 3 | none |
| 2 | Matter & Strategy (`matter`) | Matter | CC-05 | matter | none | 0 | 0 | 0 | 0 | none |
| 3 | Timeline (`timeline`) | Matter | CC-05 | people, quantum, timeline, META.bundles, META.dateSpan, META.docCount, META.textNone | none | 5 | 0 | 2 | 1 | HTML print |
| 4 | Chronology (`chronology`) | Matter | CC-03 | chronology | rescan_v1 | 13 | 0 | 6 | 0 | CSV |
| 5 | Quantum & Interest (`quantum_tab`) | Matter | CC-06 | quantum | none | 5 | 0 | 2 | 1 | CSV |
| 6 | Documents (`documents`) | Evidence | CC-04 | chronology, META.bundles, META.docCount | caselines_docs_v1, rescan_v1 | 8 | 0 | 6 | 0 | none |
| 7 | Contracts (`contracts_tab`) | Evidence | CC-04 | contracts | none | 2 | 0 | 1 | 0 | CSV |
| 8 | Filings & Affidavits (`filings_tab`) | Evidence | CC-04 | chronology, filings | filings_v1, rescan_v1 | 6 | 1 | 4 | 0 | CSV, CSV |
| 9 | Advanced Search (`search`) | Evidence | CC-04 | chronology | rescan_v1 | 6 | 9 | 6 | 0 | CSV |
| 10 | People (`people`) | Evidence | CC-04 | people | none | 0 | 0 | 0 | 0 | none |
| 11 | Entities (`entity_ledger_tab`) | Evidence | CC-04 | entities | none | 0 | 0 | 0 | 0 | none |
| 12 | Document Diff (`hoa_diff_tab`) | Evidence | CC-04 | chronology | rescan_v1 | 1 | 3 | 2 | 0 | none |
| 13 | Invoice Ledger (`invoice_ledger_tab`) | Case management | CC-06 | quantum | none | 2 | 0 | 1 | 0 | CSV |
| 14 | Disbursements (`disbursements_tab`) | Case management | CC-07 | META.builtAt, META.docCount | disbursements_v1, rescan_v1 | 3 | 4 | 4 | 0 | CSV |
| 15 | Timesheet (`timesheet_tab`) | Case management | CC-07 | META.builtAt, META.docCount | rescan_v1, timesheet_v1 | 3 | 6 | 4 | 0 | CSV |
| 16 | Deadlines (`deadlines_tab`) | Case management | CC-07 | META.builtAt, META.docCount | deadlines_v1, rescan_v1 | 3 | 4 | 4 | 0 | ICS |
| 17 | Discovery Schedule (`discovery_tab`) | Case management | CC-09 | window.__SCHED__ | schedule_co_v1, schedule_mode_v1, schedule_sel_v1 | 23 | 0 | 10 | 0 | HTML, HTML print, HTML, HTML print |
| 18 | Court Bundle (`court_bundle_tab`) | Case management | CC-09 | bundles | bundle_header_v2, custom_bundles_v1 | 55 | 1 | 40 | 0 | DOCX, DOCX, DOCX, PDF, PDF, HTML print, PDF print, CSV (dead code) |
| 19 | CaseLines (`caselines_tab`) | Case management | CC-09 | chronology, window.__CASELINES_IDX__ | caselines_docs_v1, rescan_v1 | 16 | 0 | 11 | 0 | none |
| 20 | Contradiction Tracker (`contradictions_tab`) | Analysis | CC-05 | contradictions, META.docCount | none | 2 | 0 | 1 | 0 | CSV |
| 21 | Risk Matrix (`risk_matrix_tab`) | Analysis | CC-05 | riskMatrix | none | 0 | 0 | 0 | 0 | none |
| 22 | Defence & Rebuttal (`vdm_matrix_tab`) | Analysis | CC-05 | defenceMatrix | none | 2 | 0 | 1 | 0 | CSV |
| 23 | Info Required (`info_required_tab`) | Analysis | CC-05 | infoRequired | info_done_v1 | 1 | 0 | 1 | 0 | none |
| 24 | Witnesses (`witness_tab`) | Analysis | CC-05 | witnesses | none | 0 | 0 | 0 | 0 | none |
| 25 | Conflict Check (`conflict_tab`) | Analysis | CC-08 | entities, people | none | 2 | 1 | 2 | 0 | none |
| 26 | Enforcement Roadmap (`enforcement_tab`) | Litigation strategy | CC-08 | lit | enf_status_v1 | 1 | 0 | 1 | 0 | none |
| 27 | Legality & SIU Risk (`legality_tab`) | Litigation strategy | CC-08 | lit | none | 1 | 0 | 0 | 0 | none |
| 28 | Prescription (`prescription_tab`) | Litigation strategy | CC-06 | lit | none | 6 | 0 | 5 | 0 | CSV |
| 29 | Interest Recalculator (`interest_calc_tab`) | Litigation strategy | CC-06 | lit | none | 1 | 5 | 2 | 0 | none |
| 30 | Payments & Net Claim (`payments_tab`) | Litigation strategy | CC-06 | lit | payments_v1 | 4 | 1 | 3 | 0 | CSV |
| 31 | Cause of Action (`elements_tab`) | Litigation strategy | CC-08 | lit | none | 1 | 0 | 0 | 1 | none |
| 32 | Authorities (`authorities_tab`) | Litigation strategy | CC-08 | lit | authorities_v1 | 2 | 1 | 2 | 0 | CSV |
| 33 | Heads of Argument (`heads_tab`) | Litigation strategy | CC-08 | none | heads_v1 | 4 | 1 | 3 | 0 | TXT |
| 34 | Cross-Exam Prep (`crossexam_tab`) | Litigation strategy | CC-08 | lit | crossexam_v1 | 3 | 1 | 3 | 0 | none |
| 35 | Settlement / BATNA (`settlement_tab`) | Litigation strategy | CC-06 | lit | none | 1 | 5 | 1 | 0 | none |
| 36 | Privilege Log (`privilege_tab`) | Registers | CC-07 | META.builtAt, META.docCount | privilege_v1, rescan_v1 | 3 | 4 | 4 | 0 | CSV |
| 37 | POPIA Register (`popia_tab`) | Registers | CC-07 | META.builtAt, META.docCount | popia_v1, rescan_v1 | 3 | 4 | 4 | 0 | CSV |
| 38 | Annotations (`annotations_tab`) | Registers | CC-07 | META.builtAt, META.docCount | annotations_v1, rescan_v1 | 3 | 3 | 4 | 0 | CSV |
| 39 | Transcripts (`transcriptions_tab`) | Registers | CC-07 | META.builtAt, META.docCount | rescan_v1, transcripts_v1 | 3 | 4 | 4 | 0 | CSV |
| 40 | Rescan & Update (`rescan_tab`) | System | CC-10 | chronology, META.builtAt, META.docCount | rescan_v1 | 5 | 0 | 4 | 0 | JSON |
| 41 | Backup / Restore (`backup_tab`) | System | CC-10 | META.builtAt, META.docCount | annotations_v1, authorities_v1, bundle_extents_v1, bundle_header_v1, bundle_overrides_v1, courtbundle_v1, crossexam_v1, custom_bundles_v1, deadlines_v1, disbursements_v1, enf_status_v1, filings_v1, heads_v1, info_done_v1, payments_v1, popia_v1, privilege_v1, rescan_v1, timesheet_v1, transcripts_v1 | 2 | 0 | 2 | 0 | JSON |
| 42 | Manual (`manual`) | System | CC-10 | buildReport, linkSample, quantum, META.docCount, META.emails, META.people, META.textNone, META.textPending | none | 4 | 0 | 2 | 1 | none |

Totals: 213 actions and 58 form fields across the 42 views (8 more actions in the shared shell); 152 static handler sites and 7 navigation sites (`data-tab` attributes routed by the shell). `discovery_tab` is defined twice (lines 658, 3220); the later module definition is live. Store names in the table omit the `ess_dcs_` prefix.

### Reconciliation of action counts

Three counts were published for round 1 (head `c54a10e`): this checklist declared 252, the lane 7 verifier's independent recount found 213, and the independent view oracle (`spikes/view-oracle/oracle-42.json`, local) found 243. The rule above gives **213**, equal to the verifier's recount in every view.

- **Round 1, 252.** It counted form fields as actions in 9 views (search 9, timesheet 6, disbursements, deadlines, privilege, transcripts and POPIA 4 each, annotations 3, court bundle 1: 39 in all) and not in 9 others, where the section's declared count was smaller than its bullet list (271 bullets against 252 declared). Under the rule every bullet is either an action or a field: 213 + 58 = 271 bullets.
- **Oracle, 243.** The oracle lists one entry per capability: it counts form fields (F), groups families of controls into one entry (G), adds display-only items (D) and counts the shell's global search inside two views (S). Per-view differences, which sum to 30:

| View | Round 1 | Lane 7 | Oracle | Adopted | Oracle minus adopted |
| --- | --: | --: | --: | --: | --- |
| `overview` | 8 | 8 | 4 | 8 | -4: G: the six quick-link buttons as one; S: +1 |
| `timeline` | 5 | 5 | 6 | 5 | +1: D: +1 (hover tooltips) |
| `chronology` | 13 | 13 | 8 | 13 | -5: G: five sort headers as one, Prev/Next as one |
| `documents` | 8 | 8 | 6 | 8 | -2: G: three bundle buttons as one, Prev/Next as one; D: +1 (type badges) |
| `filings_tab` | 6 | 6 | 7 | 6 | +1: F: +1 (register form) |
| `search` | 15 | 6 | 13 | 6 | +7: F: +7 (nine fields in seven entries); G: Prev/Next as one; S: +1 |
| `hoa_diff_tab` | 1 | 1 | 4 | 1 | +3: F: +3 (three selects) |
| `invoice_ledger_tab` | 2 | 2 | 4 | 2 | +2: D: +2 (KPI, table) |
| `disbursements_tab` | 7 | 3 | 5 | 3 | +2: F: +1 (form as one entry); D: +1 (table) |
| `timesheet_tab` | 9 | 3 | 5 | 3 | +2: D: +2 (derived column, table) |
| `deadlines_tab` | 7 | 3 | 9 | 3 | +6: F: +4; D: +2 (countdown sort, table) |
| `discovery_tab` | 23 | 23 | 24 | 23 | +1: D: +1 (selection counter) |
| `court_bundle_tab` | 56 | 55 | 46 | 55 | -9: G: -9 (paired links, three tabs, from/to, up/down, built-output links); omits 'Open the builder' (view tab) and 'All bundles' (builder): -2; F: +1 (header fields); D: +1 (KPI cards) |
| `caselines_tab` | 16 | 16 | 15 | 16 | -1: G: search box (Enter) and Search button as one |
| `conflict_tab` | 2 | 2 | 3 | 2 | +1: F: +1 (text input) |
| `prescription_tab` | 6 | 6 | 5 | 6 | -1: G: Prev/Next as one |
| `interest_calc_tab` | 1 | 1 | 6 | 1 | +5: F: +5 |
| `authorities_tab` | 2 | 2 | 5 | 2 | +3: F: +3 |
| `heads_tab` | 4 | 4 | 8 | 4 | +4: F: +4 |
| `crossexam_tab` | 3 | 3 | 7 | 3 | +4: F: +4 |
| `settlement_tab` | 1 | 1 | 6 | 1 | +5: F: +5 |
| `privilege_tab` | 7 | 3 | 4 | 3 | +1: F: +1 (form as one entry) |
| `popia_tab` | 7 | 3 | 4 | 3 | +1: F: +1 (form as one entry) |
| `annotations_tab` | 6 | 3 | 4 | 3 | +1: F: +1 (form as one entry) |
| `transcriptions_tab` | 7 | 3 | 4 | 3 | +1: F: +1 (form as one entry) |
| `backup_tab` | 2 | 2 | 3 | 2 | +1: D: +1 (store table) |
| **Total** | 252 | 213 | 243 | 213 | +30 |

The rule is adopted because it can be checked against the code: every action has its own handler site, link or `data-tab` attribute, while a field only feeds an action. It needs no judgment about which controls form a family, and it leaves out display-only items, so two reviewers reach the same number. The oracle's grouping suits a capability inventory; the field and display lists here keep everything it counts.

### User-work stores and backup coverage

`STORE_KEYS` (the Backup / Restore set) lists 20 keys. Live keys missing from it: `ess_dcs_bundle_header_v2`, `ess_dcs_caselines_docs_v1`, `ess_dcs_schedule_co_v1`, `ess_dcs_schedule_mode_v1`, `ess_dcs_schedule_sel_v1`. Listed but never read or written elsewhere: `ess_dcs_bundle_extents_v1`, `ess_dcs_bundle_header_v1`, `ess_dcs_bundle_overrides_v1`, `ess_dcs_courtbundle_v1`. (The CLI's simple count flags keys that occur only once in the code; the review confirms all four legacy keys are unused.)

| Store | Access by view | In backup |
| --- | --- | --- |
| `ess_dcs_annotations_v1` | annotations_tab, backup_tab | yes |
| `ess_dcs_authorities_v1` | authorities_tab, backup_tab | yes |
| `ess_dcs_bundle_extents_v1` | backup_tab | yes |
| `ess_dcs_bundle_header_v1` | backup_tab | yes |
| `ess_dcs_bundle_header_v2` | court_bundle_tab | **no** |
| `ess_dcs_bundle_overrides_v1` | backup_tab | yes |
| `ess_dcs_caselines_docs_v1` | documents, caselines_tab | **no** |
| `ess_dcs_courtbundle_v1` | backup_tab | yes |
| `ess_dcs_crossexam_v1` | crossexam_tab, backup_tab | yes |
| `ess_dcs_custom_bundles_v1` | court_bundle_tab, backup_tab | yes |
| `ess_dcs_deadlines_v1` | overview, deadlines_tab, backup_tab | yes |
| `ess_dcs_disbursements_v1` | disbursements_tab, backup_tab | yes |
| `ess_dcs_enf_status_v1` | enforcement_tab, backup_tab | yes |
| `ess_dcs_filings_v1` | filings_tab, backup_tab | yes |
| `ess_dcs_heads_v1` | heads_tab, backup_tab | yes |
| `ess_dcs_info_done_v1` | info_required_tab, backup_tab | yes |
| `ess_dcs_payments_v1` | payments_tab, backup_tab | yes |
| `ess_dcs_popia_v1` | popia_tab, backup_tab | yes |
| `ess_dcs_privilege_v1` | privilege_tab, backup_tab | yes |
| `ess_dcs_rescan_v1` | overview, chronology, documents, filings_tab, search, hoa_diff_tab, disbursements_tab, timesheet_tab, deadlines_tab, caselines_tab, privilege_tab, popia_tab, annotations_tab, transcriptions_tab, rescan_tab, backup_tab | yes |
| `ess_dcs_schedule_co_v1` | discovery_tab | **no** |
| `ess_dcs_schedule_mode_v1` | discovery_tab | **no** |
| `ess_dcs_schedule_sel_v1` | discovery_tab | **no** |
| `ess_dcs_timesheet_v1` | overview, timesheet_tab, backup_tab | yes |
| `ess_dcs_transcripts_v1` | transcriptions_tab, backup_tab | yes |

## Shared shell (navigation, routing, viewer)

- **Code:** HTML shell 142-173; helpers 179-312; boot 3086 (buildNav();go('overview')). Discovery (3185-) and CaseLines (3523-) modules are appended after boot and only reassign RENDER.discovery_tab / RENDER.caselines_tab; they do not touch the shell.
- **Imported datasets:** code constant NAV (272-280): 7 sections, 42 [tab,label,icon] entries; code constant IC (239-267) icon paths; META.builtAt, META.docCount (freshnessStamp 286-287); localStorage ess_dcs_rescan_v1 via rescanRows() (count only, 286); <title> and brand text are hard-coded case abbreviations (6, 146): '<case-abbrev> — Counsel's Workspace'
- **User-work stores:**
  - `ess_dcs_rescan_v1` (read): array of chronology-shaped rows (n,ref,date,filename,subject,sender,to,cc,excerpt,doc_type,bundle,amount,also_in[],text_status,url('../'-prefixed),refs[],_new:true) written by rescan_tab (2809-2814). freshnessStamp reads length at page load (288) and is re-rendered after ledgerAdd (612) and addDeadline (651); allRows() concatenates it after DATA.chronology on every call (236)
- **State:** CURRENT (291) = current tab id, default 'overview'; written by go() but never read elsewhere (grep shows no reader); No URL hash / history API usage anywhere (grep: no location.hash, hashchange, history.*). Reload always returns to Overview; browser Back does not move between tabs.; Per-view module state objects (CH, DOC, SEARCH) are top-level consts: survive tab navigation, lost on reload; window.__st={} (312) declared, never used; window.__ledger registry (591) for ledger tabs; body.style.overflow toggled to 'hidden' while the viewer modal is open (203/204)
- **Actions (8):**
  - link (role=button, tabindex=0) "Sidebar nav item (42 entries from NAV)" → go(tab): sets CURRENT, toggles .active on matching .nav a, sets #crumb to NAV label (or raw tab id if not in NAV), scrolls #main and window to top, calls `RENDER[tab](#main)` or renderMissing (title 'Not found', 'Unknown tab.'). Any element with data-tab anywhere in the page is routed the same way (e.g. in-view buttons/links). (`body click listener 297 -> go(tab) 292; keydown Enter/Space 298`)
  - input type=search #globalSearch "Search documents, emails, refs…" → On Enter only: SEARCH.q = input value, go('search'). Other SEARCH filters (bundle/type/sender/dates/amounts/status) are NOT reset. No search-as-you-type. (`keydown listener 299`)
  - link a.doc (anywhere) "open / document link" → If no modifier key and left button: name = last URL path segment, decodeURIComponent'd; ext = '.'+last dot-segment lowercased; if ext in IFRAME_EXT {.pdf,.jpg,.jpeg,.png,.gif,.svg,.webp,.html,.htm,.txt,.md,.json,.csv} -> preventDefault and openViewer(url,ext,name); otherwise falls through to native target=_blank (new tab/download, e.g. .eml/.msg/.docx/.xlsx). (`document click interceptor 205-209`)
  - link "Open in new tab (viewer)" → Opens the same relative URL in a new tab (target=_blank rel=noopener). (`#docNewTab href set in openViewer 199`)
  - link "Download (viewer)" → href=url, download attribute = file name. (`#docDownload 199`)
  - button "Close ✕ (viewer)" → Hide modal, iframe src='about:blank', restore body overflow. (`closeViewer 204`)
  - key "Escape" → Closes the viewer if it is visible (display==='flex'). No other global shortcuts exist. (`document keydown 210`)
  - link "Skip to content" → In-page anchor to <main id=main>. (`href '#main' (143)`)
- **Exports:** none
- **Derived values and rules:**
  - freshnessStamp (286-287): 'Built on '+esc(META.builtAt)+' · '+(META.docCount + rescanRows().length)+' documents indexed' + (rescan count ? ' · +'+n+' via rescan' : ''). Number NOT locale-formatted here.
  - crumb = NAV label for tab (293-294), else raw tab id
  - paginate(arr,page,size) (305-306): pages=max(1,ceil(total/size)); page clamped to [1,pages]; slice=(page-1)*size..+size; from = total?(page-1)*size+1:0; to=min(page*size,total)
  - pagerBar (307-309): Prev disabled if page<=1, Next disabled if page>=pages; text 'Page p / pages' and 'Showing from–to of '+total.toLocaleString() (locale-dependent grouping)
  - fmtR (182-183): parse number (strip chars other than digits . -); non-finite -> ''; sign prefix '-' then 'R ' + integer part grouped by spaces every 3 digits + '.' + 2 decimals (toFixed(2)); zero renders 'R 0.00'; negative renders '-R 1 234.00'
  - money (185): null/'' -> ''; else parseFloat after stripping non [0-9.-] chars; finite -> fmtR else ''
  - daysUntil (186): null if falsy; Math.round((new Date(d+'T00:00:00') - todayLocalMidnight)/86400000). Clock- and local-timezone-dependent.
  - toCSV (192): null->''; quote a cell iff it matches /[",\n]/; double internal quotes; cells joined ',', rows joined '\r\n'; no BOM; no trailing newline
  - dl (190-191): Blob(content,{type}) -> object URL -> temporary <a download> click -> revoke
  - cleanName (439): strip leading '(digits) ' prefix and trailing .pdf/.eml/.msg (case-insensitive)
  - statusBadge (214-215): extracted->'extracted' green, ocr->'ocr' blue, none->'scan · none' red, pending->'pending' amber, else raw or '—'
  - bundleBadge (211-213): Original navy, Supplementary info, Correspondence muted, Pleadings warn; any other bundle (e.g. Additional) muted with raw name
  - refCode (193): Original OD, Supplementary SD, Correspondence EM, Pleadings PN, anything else XX; '-'+seq (no padding). Used only by rescan; Additional rows in data carry VDM-/AD- refs from the build.
- **Originals:** docLink(u,label) (194): '<a class="doc" href=esc(u) target=_blank rel=noopener>label ↗</a>'; empty url -> plain escaped label; openViewer (197-203): sets title, new-tab href, download href+name; IFRAME_EXT -> iframe#docFrame.src=url; else iframe hidden and fallback panel (.msg/.eml message) shown; iframe#docFrame (166) has NO sandbox attribute; loads relative './' case-file URLs (pdf/svg/html/htm/txt/json/csv/images) same-origin; All embedded URLs start with './' (1689/1689); rescan rows use '../'
- **Example candidates:**
  - freshnessStamp with empty rescan store = 'Built on <META.builtAt> · 1689 documents indexed'; with N rescan rows appends ' · +N via rescan' and the count becomes 1689+N
  - go('unknown_id') renders 'Not found' page with 'Unknown tab.' and crumb shows the raw id
  - Clicking a docLink whose URL ends .pdf opens the modal; one ending .eml or .msg does not intercept (new tab); ctrl/meta/shift/alt-click never intercepts
  - fmtR(1234567.5) = 'R 1 234 567.50'; fmtR(-5) = '-R 5.00'; money('') = ''; money('abc') = ''
  - toCSV([['a','b,c','d"e']]) = 'a,"b,c","d""e"'
  - Entering text in global search then Enter navigates to Advanced Search with that text in the Text field and results shown (if no stale filters)
- **Source defects:**
  - `S-_shell-1` (high) Document viewer iframe is not sandboxed; html/htm/svg case files run script with the app origin (access to all localStorage user work). Evidence: 166: <iframe id="docFrame" src="about:blank" title="Document preview"> ; 196 IFRAME_EXT includes '.html','.htm','.svg'
  - `S-_shell-2` (medium) Global search keeps stale Advanced Search filters (bundle/type/sender/dates/amounts/status) so a global query can silently return filtered or zero results. Evidence: 299: SEARCH.q=e.target.value;go('search') — other SEARCH fields untouched; 492 re-runs with them
  - `S-_shell-3` (low) No URL routing: reload/back/deep-link always land on Overview; CURRENT is written but unused. Evidence: 291-296, 3086 go('overview')
  - `S-_shell-4` (low) Modal has no focus trap / focus return and no backdrop-click close; only Escape and Close button. Evidence: 158-173, 203-204, 210
  - `S-_shell-5` (low) fmtR guard clause is dead code (n===0&&(n==='') can never be true for a number). Evidence: 182: if(!isFinite(n)\|\|n===0&&(n==='' ))return '';
  - `S-_shell-6` (medium) toCSV does not quote cells containing a bare CR and does not neutralise spreadsheet-formula prefixes (= + - @), so user-entered ledger text can become a formula when opened in a spreadsheet (CSV injection). Evidence: 192: /[",\n]/.test(c)
  - `S-_shell-7` (low) Fallback panel for .msg/.eml is unreachable from docLink clicks, because the interceptor only calls openViewer for IFRAME_EXT; non-preview types go straight to a new tab. Evidence: 209: if(IFRAME_EXT.has(ext)){e.preventDefault();openViewer(...)}
  - `S-_shell-8` (low) Extension detection ignores '#'/'?' suffixes: a URL like file.pdf#page=3 yields ext '.pdf#page=3' and bypasses the viewer. Evidence: 207-208: name=url.split('/').pop(); ext='.'+name.split('.').pop().toLowerCase()
- **Notes:** Single-page app: every view re-renders #main via innerHTML on each go(). Print stylesheet (139) hides sidebar/topbar and .pagehead buttons. Mobile (<900px) hides the sidebar entirely (121), so on narrow screens nav is only reachable via in-view data-tab links. Inline onclick handlers reference globals (CH, DOC, SEARCH, drawChron, etc.). Saves go through save() which alert()s 'Storage failed: …' on quota errors (189); load() returns the default on missing key or JSON parse error (188).

## Overview (`overview`)

Group Matter. Owner CC-03. Live renderer line 316. Static: 0 handler sites, 3 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 316-345 (single definition)
- **Imported datasets:** DATA.quantum.headline_due, .headline_ref, .headline_date, .invoiceCount (317-324); DATA.contradictions.total, DATA.contradictions.highCount (327, guarded by DATA.contradictions existence); DATA.matter.storyline[0].t (337); META.docCount (322), META.textNone (328), META.dateSpan[0..1], META.emails, META.people (342), META.builtAt (via freshnessStamp); rescanRows().length (322); allRows() called at 317 but the result is unused
- **User-work stores:**
  - `ess_dcs_deadlines_v1` (read): [{title,date,cat,note}]. Read on render (318) to count open deadlines; no seed (default [])
  - `ess_dcs_timesheet_v1` (read): [{date,fee_earner,activity,hours,rate,billed}]. Read on render (319) to sum unbilled hours; no seed
  - `ess_dcs_rescan_v1` (read): rescan rows. Count added to documents indexed (322) and freshness stamp
- **State:** No module state; recomputed on every navigation to the tab.
- **Actions (8):**
  - link data-tab "Rescan & Update" → go('rescan_tab') (`data-tab router 297`)
  - link data-tab "Open Matter & Strategy →" → go('matter') (`data-tab router 297`)
  - button data-tab "Chronology" → go('chronology') (`297`)
  - button data-tab "Quantum" → go('quantum_tab') (`297`)
  - button data-tab "Documents" → go('documents') (`297`)
  - button data-tab "People" → go('people') (`297`)
  - button data-tab "Search" → go('search') (`297`)
  - button data-tab "Court bundle" → go('court_bundle_tab') (`297`)
- **Exports:** none
- **Derived values and rules:**
  - Page title 'Overview', subtitle hard-coded full case title '<case-title>' (330) — not from DATA
  - KPI 'Documents indexed' = (META.docCount + rescanRows().length).toLocaleString(), sub 'across 4 bundles' hard-coded (322)
  - KPI 'Amount due (to date)' = money(DATA.quantum.headline_due); sub = headline_ref+' · as at '+headline_date (323)
  - KPI 'Invoices' = DATA.quantum.invoiceCount.toLocaleString(); sub '<party>-series in the ledger' (324)
  - KPI 'Open deadlines' = count of deadlines where daysUntil(date)!=null && >=0 (today counts as open; past excluded) — clock-dependent (318, 325)
  - KPI 'Unbilled time' = sum(parseFloat(hours)\|\|0) over timesheet rows where !t.billed, formatted toFixed(1)+' h' (319, 326). Because Billed? is a select storing 'no'/'yes', only rows with billed '' (left at placeholder) count — see defects.
  - KPI 'Contradiction flags' = DATA.contradictions.total (else 0); sub = highCount+' high-severity' (327)
  - KPI 'Scanned (need OCR)' = META.textNone; sub 'flagged text_status: none' (328)
  - 7 KPI tiles, each grid-column span 4 of 12 (332)
  - Freshness card repeats freshnessStamp()+'.' (334)
  - 'The matter, in one paragraph' = DATA.matter.storyline[0].t (337)
  - Quick-links footer: 'Date span: <META.dateSpan[0]> → <META.dateSpan[1]> · META.emails emails · META.people correspondents' (342)
- **Originals:** None (no document links on this view).
- **Example candidates:**
  - Empty localStorage: Open deadlines = 0, Unbilled time = '0.0 h', Documents indexed = 1689 (locale-formatted, e.g. '1,689' in en-US)
  - Deadlines store with dates yesterday/today/tomorrow (relative to a fixed clock) -> Open deadlines = 2
  - Timesheet rows {hours:'2.5',billed:''} and {hours:'1',billed:'no'} and {hours:'4',billed:'yes'} -> Unbilled time '2.5 h' (legacy behavior) whereas intended semantics would give '3.5 h'
  - Contradiction flags KPI = 33 with sub '25 high-severity' (from DATA.contradictions.total/highCount)
  - Scanned KPI shows META.textNone = 237 although 255 chronology rows have text_status 'none'
- **Source defects:**
  - `S-overview-1` (high) Unbilled-time KPI treats the string 'no' as billed: !t.billed is false for 'no', so rows explicitly marked 'no' are excluded and only blank rows count. Evidence: 319: ts.filter(t=>!t.billed) ; 620: {k:'billed',label:'Billed?',type:'select',opts:['no','yes']}
  - `S-overview-2` (low) Scanned KPI uses META.textNone (237) which disagrees with the derived count of text_status 'none' rows (255). Evidence: 328: ['Scanned (need OCR)',META.textNone,...]
  - `S-overview-3` (low) Hard-coded 'across 4 bundles' while META.bundles has 5 (incl. Additional with 127 docs). Evidence: 322
  - `S-overview-4` (low) Case title hard-coded in renderer, not data-driven. Evidence: 330: pageHead('Overview','<case-title>')
  - `S-overview-5` (low) Local const named dl shadows the global dl() download helper inside the function; allRows() result unused. Evidence: 317-318: const rows=allRows();... const dl=load('ess_dcs_deadlines_v1',[])
- **Notes:** Overview is the boot view (3086). The KPI values are inserted without esc (332, k[1]); they are numbers/money strings so this is safe with current data.

## Matter & Strategy (`matter`)

Group Matter. Owner CC-05. Live renderer line 348. Static: 0 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 348-356 (single definition)
- **Imported datasets:** DATA.matter.title (349); DATA.matter.storyline[].h/.t (351) — 6 items; DATA.matter.strategy[].h/.t (353) — 5 items
- **User-work stores:** none
- **State:** None.
- **Actions (0):**
- **Exports:** none
- **Derived values and rules:**
  - Title 'Matter & Strategy', subtitle esc(DATA.matter.title). Two-column layout: card 'Storyline' (h4 heading + paragraph per item, data order) and card 'Strategy Memorandum' (same).
- **Originals:** None.
- **Example candidates:**
  - Renders exactly storyline.length h4/p pairs under Storyline (6) and strategy.length under Strategy Memorandum (5), in array order
- **Notes:** Read-only narrative. DATA.matter.short and .forum exist but are not read here.

## Timeline (`timeline`)

Group Matter. Owner CC-05. Live renderer line 359. Static: 2 handler sites, 1 navigation sites, 0 download calls, 0 download anchors, 1 print calls.

- **Code:** 359-403 (single definition)
- **Imported datasets:** DATA.timeline.yearCounts (374-378), DATA.timeline.phases[] as [label,title,note] (380), DATA.timeline.events[].date/.kind/.ref/.url/.title/.note (384-386); DATA.quantum.headline_due/.headline_date/.headline_ref/.headline_url/.invoiceCount/.amountDueSeries (360, 371-372, 392); DATA.people.slice(0,8) .name/.email/.org/.total (397); META.docCount, META.bundles.Original/.Supplementary/.Correspondence, META.dateSpan, META.textNone (361-367, 400)
- **User-work stores:** none
- **State:** None.
- **Actions (5):**
  - button "Print / PDF" → Browser print dialog; print CSS (139) hides sidebar/topbar/pagehead buttons and link arrows. (`window.print() 362`)
  - button "Full chronology" → Navigate to Chronology (CH state unchanged). (`go('chronology') 362`)
  - link a.doc "source (headline amount due)" → Open the headline computation original in the viewer (pdf) or new tab. (`docLink(Q.headline_url,'source') 372 + interceptor 205`)
  - link a.doc "event title link" → Open the event's original. (`docLink(e.url, esc(cleanName(e.title))) 386`)
  - link data-tab "Open the Quantum & Interest tab →" → go('quantum_tab') (`297`)
- **Exports:**
  - HTML print `browser-determined (print to PDF)`: n/a (`window.print() 362`)
- **Derived values and rules:**
  - Page title 'Chronology & Timeline' (not 'Timeline' as in NAV; crumb shows NAV label 'Timeline'); subtitle '<case-abbrev> — a phased write-up of the matter, built from all '+META.docCount.toLocaleString()+' indexed documents' (361)
  - Synopsis paragraph interpolates META.docCount, META.bundles.Original/Supplementary/Correspondence, hard-coded 'Pleadings 1', META.dateSpan; second paragraph is a hard-coded case narrative in code (369)
  - Amount-due callout: money(Q.headline_due), headline_date, headline_ref, Q.invoiceCount (371-372)
  - Documents by year bar chart: maxY = Math.max(...values); per key y in Object.keys(yearCounts) order (numeric-like keys -> ascending), bar height px = Math.round(v/maxY*100); label y.slice(2) (2-digit year) and count v; title tooltip 'y: v' (374-378)
  - Phases: lo = parseInt(label.slice(0,4)), hi = parseInt(label.slice(-4)) (label is 'YYYY' or 'YYYY–YYYY'); events listed under a phase iff lo <= parseInt(event.date.slice(0,4)) <= hi (inclusive), in data order; an event could appear in multiple phases if ranges overlap (they do not in v5: 7 phases, 81 events, 0 unplaced) (380-384)
  - Phase with no events shows hard-coded filler sentence about routine invoicing (387)
  - Event row: date · kind badge · ref (mono) · docLink(url, cleanName(title)) · optional note (385-386)
  - Quantum trajectory card: hard-coded explanatory text + quantumChart(Q.amountDueSeries) (392); see quantum_tab for chart formula
  - Principal correspondents: first 8 of DATA.people in data order (data is sorted by total desc), columns Name, Email, Organisation (org\|\|'—'), Touchpoints (total) (395-397); intro text names the claimant's attorneys hard-coded (<firm>)
  - Evidence notes: META.textNone interpolated; hard-coded '258 MB' and 'PN-0001' text (400)
- **Originals:** DATA.timeline.events[].url via docLink (386); DATA.quantum.headline_url via docLink 'source' (372)
- **Example candidates:**
  - Events per phase in phase order = [6,12,10,45,1,5,2] (sum 81)
  - Year chart has 16 bars, keys ascending; the tallest bar is exactly 100px
  - Principal correspondents table has exactly 8 rows equal to DATA.people[0..7]
- **Source defects:**
  - `S-timeline-1` (low) Event link label is double-escaped: esc(cleanName(title)) is passed to docLink which escapes again, so titles with & < > " ' render as literal '&amp;' etc. Evidence: 386: docLink(e.url,esc(cleanName(e.title)))
  - `S-timeline-2` (low) Substantial case narrative, counts ('Pleadings 1', '258 MB', 'PN-0001') and firm name are hard-coded in the renderer rather than DATA. Evidence: 366-369, 395, 400
  - `S-timeline-3` (low) yearCounts bar heights use Math.max(...values); an empty yearCounts gives maxY=-Infinity (no bars, no crash) but any zero-only map divides by 0 -> NaN heights. Evidence: 374-376
  - `S-timeline-4` (low) Title mismatch: NAV label 'Timeline' vs page heading 'Chronology & Timeline'. Evidence: 273 vs 361
- **Notes:** DATA.timeline.typeByYear exists but is unused. Phase label separator is not parsed; only first/last 4 characters are used.

## Chronology (`chronology`)

Group Matter. Owner CC-03. Live renderer line 407. Static: 6 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 406-444 (state CH 406, render 407-418, chronFiltered 419-426, drawChron 427-437, sortChron 438, cleanName 439, exportChron 440-442, selEl 443-444); single definition
- **Imported datasets:** allRows() = DATA.chronology concat ess_dcs_rescan_v1 rows (419, 408, 409); Row fields read: date, ref, subject, filename, sender, excerpt, also_in[], doc_type, bundle, amount, text_status, url; export also reads to; Type options = [...new Set(allRows().map(r=>r.doc_type))].sort() (408) — includes rescan types
- **User-work stores:**
  - `ess_dcs_rescan_v1` (read): rescan rows. Merged via allRows() on each render/draw/export
- **State:** CH = {page:1, size:60, sort:'date', dir:1, f:{q:'', bundle:'', type:'', status:''}} (406). Module-level: survives navigation, lost on reload. Set externally by quantum_tab link (CH.f.type='charging calculation', 564).
- **Actions (13):**
  - button "Export CSV" → Download all filtered+sorted rows (not just current page) as CSV. (`exportChron 440`)
  - input text #chq "Filter text / ref / filename" → CH.f.q=value; CH.page=1; drawChron() on every keystroke (only the table is redrawn, input keeps focus). (`inline oninput 412`)
  - select #chb "All bundles / Original / Supplementary / Correspondence / Pleadings" → CH.f.bundle=value; page=1; redraw. No 'Additional' option. (`inline onchange 413`)
  - select #cht "All types / <sorted doc_type values>" → CH.f.type=value; page=1; redraw. (`inline onchange 414`)
  - select #chs "Any text status / extracted / ocr / none / pending" → CH.f.status=value; page=1; redraw. (`inline onchange 415`)
  - th-click "Date" → Same key toggles dir (1 <-> -1); new key sets sort and dir=1. Page is NOT reset. (`sortChron('date') 438`)
  - th-click "Ref" → as above (`sortChron('ref')`)
  - th-click "Type" → as above (`sortChron('doc_type')`)
  - th-click "Bundle" → as above (`sortChron('bundle')`)
  - th-click "Amount" → as above, numeric (`sortChron('amount')`)
  - button "Prev" → Previous page (disabled on page 1). (`CH.page--;drawChron() 436`)
  - button "Next" → Next page (disabled on last page). (`CH.page++;drawChron() 436`)
  - link a.doc "open" → Open original in viewer/new tab. (`docLink(r.url,'open') 435`)
- **Exports:**
  - CSV `ess_dcs_chronology.csv`: ref,date,filename,subject,sender,to,doc_type,bundle,amount,also_in,text_status,url (header row = these keys). Array values joined with '; '. Raw values (amount unformatted). Rows = chronFiltered() in current sort order, all pages. (`exportChron 440-442 (MIME text/csv)`)
- **Derived values and rules:**
  - Header subtitle: allRows().length.toLocaleString()+' items · sorted by date' (409) — static text regardless of actual sort, unaffected by filters
  - Filter predicates (419-423), ANDed: bundle exact equality; doc_type exact equality; text_status exact equality; q: case-insensitive substring of (filename+' '+ref+' '+(subject\|\|'')+' '+(sender\|\|'')+' '+(excerpt\|\|'')).toLowerCase() — 'to', 'cc', date and amount are NOT searched; whitespace not trimmed
  - Sort (424-425): vx = x[CH.sort]\|\|''; for 'amount' vx=parseFloat(vx)\|\|0; comparator (vx<vy?-1:vx>vy?1:0)*dir — plain JS string comparison (code-unit order, not localeCompare) for date/ref/doc_type/bundle; stable (ES2019 Array.sort). Default date ascending, so the 273 undated rows ('' sorts first) occupy the first pages.
  - Page size 60 (406); page clamped by paginate (427)
  - Row (430-435): Date (date\|\|'—'), Ref, Title/subject = subject\|\|cleanName(filename) + optional sender line + optional excerpt.slice(0,140)+'…' (ellipsis always appended) + optional 'also in: a, b'; Type badge; Bundle badge; Amount money(amount) right-aligned; Status badge; Doc 'open' link
  - Sort indicator ' ▲' when dir>0, ' ▼' when dir<0 on the active sortable column (428); Title/subject, Status, Doc columns are not sortable
- **Originals:** DATA.chronology[].url (and rescan row url) via docLink 'open' (435)
- **Example candidates:**
  - No filters: 1689 rows, 29 pages of 60 (last page 9 rows); page 1 rows all have empty date
  - bundle=Original -> 605 rows; bundle=Original + type=invoice -> 142; bundle=Supplementary + type=invoice -> 165; bundle=Correspondence + type=email -> 469
  - status=none -> 255 rows; status=ocr -> 0 rows; status=pending -> 6 rows
  - Clicking Date header twice -> descending date; page 1 then starts with the latest dated row and undated rows go last
  - Sort by Amount ascending treats empty amount as 0
  - Export CSV with bundle=Pleadings yields header + 1 row with 12 columns
- **Source defects:**
  - `S-chronology-1` (medium) Rows in the Additional bundle (127, VDM-/AD- refs) cannot be selected by the bundle filter (no option). Evidence: 413: selEl('chb',['','Original','Supplementary','Correspondence','Pleadings'],...)
  - `S-chronology-2` (low) Filter haystack concatenates r.filename and r.ref without null guards, so a row missing filename would contain the text 'undefined' and match queries like 'undef'. All current rows have filename, so latent only. Evidence: 423: (r.filename+' '+r.ref+' '+...)
  - `S-chronology-3` (low) Excerpt preview always appends '…' even when the excerpt is shorter than 140 chars. Evidence: 432: esc(r.excerpt.slice(0,140))+'…'
  - `S-chronology-4` (low) Subtitle says 'sorted by date' regardless of the selected sort; sorting does not reset the page. Evidence: 409, 438
  - `S-chronology-5` (low) 'ocr' status option never matches v5 data (no row has text_status 'ocr'). Evidence: 415
  - `S-chronology-6` (low) Ref sort is a plain string comparison, so refs with different digit widths (e.g. rescan refs without padding) sort lexically. Evidence: 424-425; refCode 193 unpadded
- **Notes:** selEl (443-444) builds <select class=in style=max-width:190px> with placeholder label for '' option; selected option = o===val. The types list is rebuilt from allRows() on every render. CH survives navigation, so returning to the tab restores filters/sort/page (inputs are re-rendered with CH values).

## Quantum & Interest (`quantum_tab`)

Group Matter. Owner CC-06. Live renderer line 540. Static: 2 handler sites, 1 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 540-566 (render), docLinkText 567, quantumChart 568-573, exportInvoices 574-575; single definition
- **Imported datasets:** DATA.quantum.headline_due, .headline_ref, .headline_date, .headline_url, .invoiceCount, .grossInvoiced (544-547); DATA.quantum.amountDueSeries[].date/.ref/.amount/.url (551-553) — 55 items, ascending by date; DATA.quantum.invoiceLedger[].ref/.no/.date/.amount/.url (555-558) — 307 items; DATA.quantum.chargingCount (561), DATA.quantum.statementSeries.length (562), DATA.quantum.interestSeries.length (563)
- **User-work stores:** none
- **State:** Writes chronology state CH.f.type via the 'View charging calculations' link (564).
- **Actions (5):**
  - link (plain <a>, not a.doc) "Open source PDF (Latest computation KPI)" → Opens headline_url in a new tab; bypasses the in-page viewer because it lacks class 'doc'. '—' if no url. (`docLinkText(q.headline_url,...) 545/567`)
  - link a.doc "open (Amount Due series row)" → Open the computation original. (`docLink 553`)
  - button "Export CSV (invoice ledger card)" → Download invoice ledger CSV. (`exportInvoices 574`)
  - link a.doc "open (invoice row)" → Open the invoice original. (`docLink 558`)
  - link data-tab + onclick "View charging calculations →" → Navigates to Chronology pre-filtered by type 'charging calculation'; other CH filters, sort and page are kept as they were. (`inline onclick CH.f.type='charging calculation' then router 297 go('chronology')`)
- **Exports:**
  - CSV `ess_dcs_invoices.csv`: ref,no,date,amount,bundle,text_status,url (raw values, all 307 ledger rows in data order) (`exportInvoices 574-575`)
- **Derived values and rules:**
  - Title 'Quantum & Interest', subtitle 'What <party> owes, and the interest running on it' (hard-coded, 542)
  - 4 KPIs (span 3): Amount due = money(headline_due) sub headline_ref+' · as at '+headline_date; Latest computation = link; Invoices in ledger = invoiceCount.toLocaleString(); Gross invoiced (unreconciled) = money(grossInvoiced) (544-548)
  - quantumChart(series) (568-573): empty -> ''; vals=parseFloat(amount)\|\|0; max=Math.max(...vals); W=760,H=160,pad=8,n=len; bar width bw=max(2,(W-2*pad)/n-2); x=pad+i*((W-2*pad)/n); bh = max? (v/max)*(H-2*pad) : 0; y=H-pad-bh; all toFixed(1); each rect has <title> 'date: money(amount)'; caption 'firstDate → lastDate · peak money(max)'
  - Series table = amountDueSeries reversed (latest first given ascending data), columns As at, Ref, Amount due (money), Source link (552-553)
  - Invoice ledger card: 'Invoice ledger (307)', scrollable max-height 460px, columns Ref, Invoice (no), Date (date\|\|'—'), Amount (money), Doc (555-558)
  - Charging & statements card: chargingCount, statementSeries.length, interestSeries.length as KPI tiles (561-563)
- **Originals:** DATA.quantum.headline_url (plain link, new tab); amountDueSeries[].url and invoiceLedger[].url via docLink
- **Example candidates:**
  - Amount-due table has 55 rows with the first row being the latest date (series is ascending in data)
  - Chart caption peak equals money(max amount in series); the bar for the max value has height 144 (H-2*pad)
  - Charging calcs tile = 128, Statements = 182, Interest computations = 110
  - Clicking 'View charging calculations' with fresh CH yields Chronology with 128 rows (type 'charging calculation')
  - Export CSV -> header + 307 rows
- **Source defects:**
  - `S-quantum_tab-1` (low) Headline source link uses docLinkText without class 'doc', so it bypasses the viewer unlike every other document link (inconsistent behavior). Evidence: 567: '<a href="'+esc(u)+'" target="_blank" rel="noopener">'
  - `S-quantum_tab-2` (low) Charging-calculation shortcut sets only CH.f.type, leaving any previous text/bundle/status filters, so the target list can be unexpectedly filtered. Evidence: 564: onclick="CH.f.type='charging calculation'"
  - `S-quantum_tab-3` (low) quantumChart assumes non-negative amounts; a negative max yields negative heights, and the bar width formula can overlap bars when n is large (min width 2). Evidence: 568-570
- **Notes:** grossInvoiced (string) equals the sum of invoiceLedger amounts in v5 data, and invoiceCount equals invoiceLedger.length (307).

## Documents (`documents`)

Group Evidence. Owner CC-04. Live renderer line 449. Static: 6 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 448-470 (state DOC 448, render 449-458, drawDocs 459-470); single definition. NOTE: a different, closure-scoped drawDocs exists inside the CaseLines IIFE (3623) and does not override this global one.
- **Imported datasets:** META.bundles.{Original,Supplementary,Correspondence,Pleadings} for button counts (450, 454); META.docCount for subtitle (451); allRows() (DATA.chronology + rescan) filtered by bundle (459); fields ref, doc_type, date, subject, filename, excerpt, amount, text_status, url
- **User-work stores:**
  - `ess_dcs_rescan_v1` (read): rescan rows. Merged via allRows() in drawDocs
- **State:** DOC = {bundle:'Original', page:1, size:60, q:''} (448); module-level, survives navigation, lost on reload. DOC.q is not cleared when switching bundle.
- **Actions (8):**
  - button "Original (count)" → DOC.bundle='Original'; DOC.page=1; full re-render of view. (`inline onclick 454`)
  - button "Supplementary (count)" → same, Supplementary (`454`)
  - button "Correspondence (count)" → same, Correspondence (`454`)
  - button "Pleadings (count)" → same, Pleadings (`454`)
  - input text "Filter in bundle" → DOC.q=value; DOC.page=1; drawDocs() per keystroke. (`inline oninput 455`)
  - button "Prev" → previous page (`DOC.page--;drawDocs() 469`)
  - button "Next" → next page (`DOC.page++;drawDocs() 469`)
  - link a.doc "open" → Open original (`docLink 468`)
- **Exports:** none
- **Derived values and rules:**
  - Subtitle: META.docCount.toLocaleString()+' documents · by bundle then type' (451) — excludes rescan rows
  - Active bundle button styled primary, others secondary; label 'Name (META.bundles[name]\|\|0)' (454) — counts from META, exclude rescan rows
  - Filter: rows with bundle===DOC.bundle, then if q: case-insensitive substring of (filename+' '+ref+' '+(subject\|\|'')+' '+(excerpt\|\|'')) — sender NOT included (unlike chronology) (459-460)
  - Type summary badges: per doc_type in the filtered set, 'type: count', types sorted by default string sort (461-463)
  - Sort: (doc_type+date).localeCompare(other.doc_type+other.date) ascending (464) — concatenated key, locale-aware; undated rows sort first within their type
  - Page size 60 (448)
  - Columns: Ref, Type, Date (date\|\|'—'), Title (subject\|\|cleanName(filename)), Amount (money, right), Status badge, Doc link (466-468); no header sorting (no onclick on th although CSS shows pointer cursor)
- **Originals:** row.url via docLink 'open' (468)
- **Example candidates:**
  - Default (Original, no filter): 605 rows, 11 pages; type badges SLA 9, charging calculation 127, email 25, interest computation 2, invoice 142, invoice breakdown 47, other 95, proof of delivery 28, report 6, schedule 23, statement 101
  - Pleadings bundle: 1 row, 1 page
  - Typing a filter resets to page 1 and the type badges reflect only matching rows
- **Source defects:**
  - `S-documents-1` (medium) Additional bundle (127 docs) has no button, so those documents are unreachable from the Documents view; the subtitle total (1689) includes them. Evidence: 453: [['Original',...],['Supplementary',...],['Correspondence',...],['Pleadings',...]]
  - `S-documents-2` (low) Button counts come from META.bundles while the table uses allRows() (includes rescan rows), so counts disagree after a rescan. Evidence: 454 vs 459
  - `S-documents-3` (low) Sort key concatenates doc_type and date without a separator, so type names that are prefixes of other type names (e.g. 'invoice' vs 'invoice breakdown') interleave by date-vs-letter comparison. Evidence: 464: (x.doc_type+x.date).localeCompare(y.doc_type+y.date)
- **Notes:** Bundle switch calls RENDER.documents(document.getElementById('main')) directly (no go()), so crumb/active nav unchanged.

## Contracts (`contracts_tab`)

Group Evidence. Owner CC-04. Live renderer line 2588. Static: 1 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 2588-2604
- **Imported datasets:** DATA.contracts.count (2593); DATA.contracts.groups[] (4 groups) .key, .items[] (22 items) (2596-2601); DATA.contracts.groups[].items[].ref, .date, .title, .note, .text_status, .url (2584-2587); items[].doc_type, .party, .role exist in data but are not rendered (party/role always empty)
- **User-work stores:** none
- **State:** none; pure render from DATA
- **Actions (2):**
  - button "Export CSV" → downloads all contract items from all groups (`exportContracts 2605`)
  - link "open ↗ (per row)" → opens items[].url in the in-page viewer (or new tab for non-viewer extensions) (`docLink 2587 + delegated viewer 205`)
- **Exports:**
  - CSV `ess_dcs_contracts.csv`: group,ref,date,title,note,text_status,url (`exportContracts 2605-2607 (raw title, not cleanName)`)
- **Derived values and rules:**
  - KPI 'Contract documents' = DATA.contracts.count; sub 'across N relationships' N = groups.length (2593)
  - One card per group in DATA order, header '<key> (items.length)' (2597)
  - Row columns: Ref (mono), Date (date\|\|'—'), Contract = cleanName(title) + note line if note, Signed chip, Text = statusBadge(text_status), Doc = docLink(url,'open') (2584-2587)
  - Signed chip rule (2586): if /unsigned/i.test(note) -> 'unsigned' (warn); else if /sign\|final\|execut/i.test(title+note) (concatenated without separator) -> 'signed' (ok); else '—' (muted). In the v5 data this yields 6 signed, 1 unsigned, 15 '—'.
  - No sorting; group and item order = DATA order. No clock dependence.
- **Originals:** items[].url via docLink (direct embedded url, not allRows lookup)
- **Example candidates:**
  - Synthetic item {note:'unsigned draft', title:'X'} -> chip 'unsigned'; {note:'', title:'Final agreement'} -> 'signed'; {note:'', title:'Schedule'} -> '—'; {note:'', title:'Unsigned copy'} -> 'signed' (source quirk, see defects)
  - Export of 2 groups with 1 item each -> header row 'group,ref,date,title,note,text_status,url' + 2 rows, CRLF separated
- **Source defects:**
  - `S-contracts_tab-1` (medium) Signed heuristic misclassifies: 'unsigned' is only tested in note; a title containing 'unsigned', 'assignment', 'designated' or 'signature' matches /sign/ and shows 'signed' Evidence: 2586 /unsigned/i.test(x.note)?...:(/sign\|final\|execut/i.test((x.title+x.note))?chip('signed'...
  - `S-contracts_tab-2` (medium) Case narrative hard-coded in the renderer: two KPI cards and a closing paragraph describe parties and agreements (<case narrative>); the closing paragraph also states a hard-coded document total that disagrees with META.docCount (1,689) Evidence: 2594, 2595, 2602
- **Notes:** Page subtitle (2590) also hard-codes the <claimant> name and the contract categories. Text column only shows status; there is no excerpt.

## Filings & Affidavits (`filings_tab`)

Group Evidence. Owner CC-04. Live renderer line 2610. Static: 4 handler sites, 0 navigation sites, 3 download calls, 1 download anchors, 0 print calls.

- **Code:** 2610-2638
- **Imported datasets:** DATA.filings.groups[] (4) .key, .note, .items[] (13) (2615-2623); DATA.filings.groups[].items[].ref, .date, .title, .note, .doc_type, .text_status, .url (2619-2621); DATA.filings.registerSeed[] (3) .filing, .fdate, .fparty, .response, .rdate, .ref, .status (2639, seed only); allRows() (includes rescan store) via byrefRow for register ref links (2642, 2647); DATA.filings.count exists but is not rendered
- **User-work stores:**
  - `ess_dcs_filings_v1` (read+write): [{filing,fdate,fparty,response,rdate,ref,status}]. filingStore (2639): load(key,null); if null, copies DATA.filings.registerSeed.slice() (shallow) into the store and saves immediately — first render therefore writes user storage. Afterwards the seed is never consulted again; an empty array [] (all rows deleted) is NOT reseeded. addFiling appends {...,status:''} (2648-2650); delFiling splices by array index (2652). Order = insertion order.
- **State:** none in memory; register re-read from localStorage on every draw
- **Actions (6):**
  - button "Export CSV (page header)" → downloads DATA.filings group items (`exportFilings 2653`)
  - link "open ↗ (filing rows)" → opens items[].url in viewer (`docLink 2621`)
  - button "Add" → if Filing is empty: no-op. Else appends row with status '', saves, clears the 6 inputs, redraws register (`addFiling 2648`)
  - button "Delete (per register row)" → removes row at index i without confirmation, saves, redraws (`delFiling(i) 2652`)
  - button "Export register CSV" → downloads the stored register (`exportRegister 2656`)
  - link "register Ref" → if ref resolves in allRows(): link labelled with the ref to that row's url; else plain escaped text (`byrefRow 2647 + docLink 2644`)
- **Form fields (1):**
  - input "Filing / Date(date) / Party filing / Responding-replying affidavit / Response date(date) / Ref" → ids fl_filing, fl_fdate, fl_fparty, fl_response, fl_rdate, fl_ref (2628-2633) (`none (read by addFiling)`)
- **Exports:**
  - CSV `ess_dcs_filings.csv`: group,ref,date,title,note,doc_type,text_status,url (`exportFilings 2653-2655`)
  - CSV `ess_dcs_filing_register.csv`: filing,fdate,fparty,response,rdate,ref,status (`exportRegister 2656-2657 (values from filingStore(), so this also seeds storage if empty)`)
- **Derived values and rules:**
  - Group card header '<key> (items.length)'; optional note line if g.note (2616-2617)
  - Filing row: Ref, Date\|\|'—', cleanName(title)+note, typeBadge(doc_type), statusBadge(text_status), docLink(url,'open') (2619-2621)
  - Register row (2642-2645): Filing (bold), Filed fdate\|\|'—', By fparty\|\|'', response\|\|'—', rdate\|\|'—', Ref (linked if resolvable), Status chip only if status non-empty, Delete
  - Empty register -> 'No filings logged yet.' (2641)
- **Originals:** items[].url via docLink; register ref -> allRows().find(r.ref===ref).url (2647); unresolved refs remain plain text (all 3 seed refs resolve in v5 data)
- **Example candidates:**
  - Fresh storage (key absent): opening the tab writes ess_dcs_filings_v1 = copy of registerSeed (3 rows) and shows 3 register rows
  - Storage holds [] -> register shows empty state and seed is not restored
  - Add with Filing='' -> no change; Add with Filing='Notice', Ref='<unknown ref>' -> new last row, Ref shown as plain text, Status cell empty
  - Export register with rows [{filing:'A',fdate:'2001-02-03',fparty:'',response:'',rdate:'',ref:'',status:''}] -> 'filing,fdate,fparty,response,rdate,ref,status\r\nA,2001-02-03,,,,,'
- **Source defects:**
  - `S-filings_tab-1` (medium) Seed-copy store: registerSeed is copied into user storage on first read, so a later results version's seed is never shown to existing users Evidence: 2639 if(s===null){s=DATA.filings.registerSeed.slice();save('ess_dcs_filings_v1',s);}
  - `S-filings_tab-2` (low) Index-based delete without confirmation Evidence: 2645 onclick="delFiling('+i+')"; 2652 s.splice(i,1)
  - `S-filings_tab-3` (medium) Orientation paragraph hard-coded in the renderer (<case narrative>), including a bundle ref, a file size and a case date Evidence: 2614
  - `S-filings_tab-4` (low) User rows can never set Status (always ''), only seed rows carry status Evidence: 2649 status:''
- **Notes:** Register intro text names the storage key literally (2626).

## Advanced Search (`search`)

Group Evidence. Owner CC-04. Live renderer line 474. Static: 6 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 473-522 (state SEARCH 473, render 474-493, collectSearch 494-495, val 496, searchFiltered 497-507, runSearch 508, drawSearch 509-514, exportSearch 515-516, actionItems 517-522); single definition. NAV label 'Advanced Search'.
- **Imported datasets:** allRows() (DATA.chronology + rescan): fields bundle, doc_type, text_status, sender, to, cc, date, amount, filename, ref, subject, excerpt, url; Type options from [...new Set(allRows().map(r=>r.doc_type))].sort() (475)
- **User-work stores:**
  - `ess_dcs_rescan_v1` (read): rescan rows. Merged via allRows()
- **State:** SEARCH = {q:'', bundle:'', type:'', sender:'', from:'', to:'', amin:'', amax:'', status:'', page:1, size:50} (473); module-level, survives navigation, lost on reload; SEARCH.q is also set by the global search box (299); Form inputs are pre-filled from SEARCH on render; on render, results auto-run only if SEARCH.q \|\| SEARCH.bundle is truthy (492); Unused variable _sdeb (508)
- **Actions (6):**
  - button "Search" → collectSearch(); page=1; drawSearch(). Filters are applied only on click (no oninput/Enter handler on the form fields). (`runSearch 508`)
  - button "Export CSV" → Export all rows matching the LAST COLLECTED SEARCH state (does not re-read the form). (`exportSearch 515`)
  - button "Extract action items" → Replaces the results area with an action-item table built from the last collected SEARCH state (does not re-read the form). (`actionItems 517`)
  - button "Prev" → previous page (`SEARCH.page--;drawSearch() 513`)
  - button "Next" → next page (`SEARCH.page++;drawSearch() 513`)
  - link a.doc "open" → Open original (`docLink 512`)
- **Form fields (9):**
  - input text #sq "Text" → Free-text criterion (applied on Search click). (`read by collectSearch`)
  - select #sb "Bundle (All / 4 bundles)" → Bundle equality; no Additional option. (`collectSearch`)
  - select #st "Type (All / doc types)" → doc_type equality. (`collectSearch`)
  - input text #ss "Sender contains" → Substring over sender+to+cc. (`collectSearch`)
  - input date #sf "From date" → date >= from (string compare). (`collectSearch`)
  - input date #sto "To date" → date <= to (string compare). (`collectSearch`)
  - input text #samin "Amount min" → parseFloat(amount) >= parseFloat(min). (`collectSearch`)
  - input text #samax "Amount max" → parseFloat(amount) <= parseFloat(max). (`collectSearch`)
  - select #sst "Text status (Any / extracted / ocr / none / pending)" → text_status equality. (`collectSearch`)
- **Exports:**
  - CSV `ess_dcs_search.csv`: ref,date,filename,subject,sender,doc_type,bundle,amount,text_status,url (raw values; arrays not joined — none in these columns) (`exportSearch 515-516 (text/csv); rows = searchFiltered() in allRows() order (no sort)`)
- **Derived values and rules:**
  - Predicates (497-507), ANDed, applied in this order: bundle ===; doc_type ===; text_status ===; sender: ((sender\|\|'')+(to\|\|'')+(cc\|\|'')).toLowerCase().includes(sender.toLowerCase()) — concatenated without separators; from: r.date && r.date>=from (undated rows excluded); to: r.date && r.date<=to; amin: parseFloat(r.amount)>=parseFloat(amin) (rows with empty amount excluded; non-numeric amin -> NaN -> no rows); amax analogous; q: case-insensitive substring of (filename+' '+ref+' '+(subject\|\|'')+' '+(sender\|\|'')+' '+(to\|\|'')+' '+(excerpt\|\|'')) — cc not included in q
  - Results are in allRows() order (DATA.chronology embedded order, which is NOT date-sorted, then rescan rows); no sorting UI
  - Page size 50 (473); header line 'Showing from–to of total.toLocaleString() results' (510) plus the pager
  - Result columns: Date, Ref, Title/subject (subject\|\|cleanName(filename) + excerpt.slice(0,120)+'…'), Type, Bundle, Amount (money), Doc (510-512)
  - Action items (517-522): for each filtered row, text = (subject\|\|'')+'. '+(excerpt\|\|''); extractActionItems (229-230) applies /[^.!?\n]*\b(please\|kindly\|must\|shall\|require[sd]?\|request(?:ed\|ing)?\|by\s+\d\|before\s+\d\|urgent\|action\|deadline\|due\s+\|submit\|provide\|await\|revert)\b[^.!?\n]*[.!?]?/gi; each match trimmed, kept if length>8, max 20 per row. Card title 'Action items (N)' with N = total items; table shows the first 300 (Date, Ref, Extracted action); empty -> 'No action-item phrases found in the current result set.'
- **Originals:** row.url via docLink 'open' (512)
- **Example candidates:**
  - Search with only Bundle=Correspondence -> 475 results (10 pages of 50)
  - Type=invoice -> 307 results
  - Amount min=0 (any numeric) excludes all 916 rows with empty amount -> at most 773 results
  - From date set -> undated rows (273) never appear
  - Sender contains <text> matches across the sender/to boundary because fields are concatenated without a separator
  - extractActionItems('Please submit the form by 3 Feb. Thanks.') -> ['Please submit the form by 3 Feb.'] ('Thanks.' does not match)
- **Source defects:**
  - `S-search-1` (low) Export CSV and Extract action items use the last-submitted SEARCH state, not the current form values; editing a field and exporting without pressing Search exports the old result set. Evidence: 515: const a=searchFiltered(); 517 likewise; only runSearch calls collectSearch (508)
  - `S-search-2` (medium) Global search sets only SEARCH.q and leaves previous filters in place; also auto-run on render happens only when q or bundle is set, so other remembered filters show no results until Search is clicked. Evidence: 299; 492: if(SEARCH.q\|\|SEARCH.bundle)runSearch()
  - `S-search-3` (low) Sender filter concatenates sender, to and cc with no separator, allowing false matches across field boundaries. Evidence: 501: ((r.sender\|\|'')+(r.to\|\|'')+(r.cc\|\|''))
  - `S-search-4` (medium) No Additional bundle option; 'ocr' status option never matches. Evidence: 479, 487
  - `S-search-5` (low) Amount bounds are not validated: a non-numeric bound yields NaN comparisons and an empty result without a message. Evidence: 504-505
  - `S-search-6` (low) Excerpt preview always appends '…'. Evidence: 512
- **Notes:** Page subtitle claims 'search over every field', but only the fields listed in derived are searched (cc only through Sender, date/amount only through range filters). Selects are rendered with an empty onchange (no live filtering).

## People (`people`)

Group Evidence. Owner CC-04. Live renderer line 526. Static: 0 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 526-531 (single definition)
- **Imported datasets:** DATA.people[].name/.email/.org/.sent/.received/.total (527-529); DATA.people[].role exists but is unused
- **User-work stores:** none
- **State:** None.
- **Actions (0):**
- **Exports:** none
- **Derived values and rules:**
  - Subtitle: DATA.people.length+' correspondents & signatories from email headers' (527)
  - Table in data order (data is pre-sorted by total desc); columns Name, Email (mono), Organisation (org\|\|'—'), Sent, Received, Total (numbers unescaped, right-aligned) (528-529); no sorting, filtering or links
- **Originals:** None.
- **Example candidates:**
  - Renders 42 rows; header '42 correspondents & signatories from email headers'
- **Notes:** Th elements carry the sortable CSS cursor but have no handlers.

## Entities (`entity_ledger_tab`)

Group Evidence. Owner CC-04. Live renderer line 533. Static: 0 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 533-538 (single definition)
- **Imported datasets:** DATA.entities[].name/.role/.note (534-536)
- **User-work stores:** none
- **State:** None.
- **Actions (0):**
- **Exports:** none
- **Derived values and rules:**
  - Title 'Entities' (NAV label 'Entities'), subtitle DATA.entities.length+' companies & bodies in the matter'; table Entity (bold), Role, Note, in data order (534-536)
- **Originals:** None.
- **Example candidates:**
  - Renders 22 rows in data order
- **Notes:** Despite the id 'entity_ledger_tab' this is read-only; there is no user ledger store.

## Document Diff (`hoa_diff_tab`)

Group Evidence. Owner CC-04. Live renderer line 2759. Static: 2 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2759-2770
- **Imported datasets:** allRows() (DATA.chronology + rescan store ess_dcs_rescan_v1) .ref, .filename, .excerpt (2760, 2771-2774)
- **User-work stores:**
  - `ess_dcs_rescan_v1` (read): rescan rows (see Rescan view). read indirectly through allRows(); rescan rows have excerpt '' so they never appear in the pick lists, but runDiff's map includes them
- **State:** none; selections live only in the DOM
- **Actions (1):**
  - button "Compare" → renders diff into #diffOut (`runDiff 2771`)
- **Form fields (3):**
  - select "Document A" → id diffA; options '— pick —' + candidates (`none (read by runDiff)`)
  - select "Document B" → id diffB (`none (read by runDiff)`)
  - select "Mode words\|lines (default words)" → id diffmode (`none (selEl with onchange '')`)
- **Exports:** none
- **Derived values and rules:**
  - Candidates (2760): allRows().filter(r=>r.excerpt).slice(0,1200) in allRows order; option value=ref, label=ref+' · '+cleanName(filename). v5 has 1,434 rows with non-empty excerpt, so the last 234 are unselectable.
  - Compared text = r.excerpt only (≤500 chars in v5, single line), not full document text (2768, 2773)
  - runDiff (2771-2774): map ref->row over allRows (last wins); if A or B not found -> 'Pick two documents.'; mode 'lines' -> diffLines(a.excerpt\|\|'',b.excerpt\|\|'') else diffWords
  - diffWords (218): tokens = split(/(\s+)/) (whitespace kept as tokens), join ''. diffLines (219): split(/\n/), each output token followed by '\n'
  - lcsDiff (220-228): standard LCS DP; walk: equal -> plain; else if dp[i+1][j] >= dp[i][j+1] emit deletion (A token, class diffdel) first, else insertion (B token, class diffadd); then trailing deletions then trailing insertions. All tokens HTML-escaped.
  - Output header '<A.ref> vs <B.ref>' and 'cleanName(A.filename) ↔ cleanName(B.filename)'; body white-space:pre-wrap. Same document may be chosen for A and B (all tokens equal).
- **Originals:** none (no links to the compared documents)
- **Example candidates:**
  - words mode: A='the cat sat', B='the dog sat' -> tokens A [the,' ',cat,' ',sat], B [the,' ',dog,' ',sat] -> 'the <del>cat</del><add>dog</add> sat'
  - lines mode: A='x\ny', B='x\nz' -> 'x\n<del>y</del>\n<add>z</add>\n'
  - Only A picked -> 'Pick two documents.'
- **Source defects:**
  - `S-hoa_diff_tab-1` (medium) Pick list truncated to the first 1,200 excerpt-bearing rows; 234 v5 documents cannot be compared Evidence: 2760 allRows().filter(r=>r.excerpt).slice(0,1200)
  - `S-hoa_diff_tab-2` (medium) Diff covers only the ≤500-char excerpt; v5 excerpts are single-line so 'lines' mode degenerates to whole-excerpt replace Evidence: 2768 note; 2773 a.excerpt
  - `S-hoa_diff_tab-3` (low) Two separate 1,200-option selects (no search) — usability Evidence: 2764-2765
- **Notes:** Nav id is hoa_diff_tab but the page is a generic two-document excerpt diff (title 'Document / Version Diff', 2761).

## Invoice Ledger (`invoice_ledger_tab`)

Group Case management. Owner CC-06. Live renderer line 576. Static: 1 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 576-584 (single definition); shares exportInvoices 574-575
- **Imported datasets:** DATA.quantum.invoiceLedger[].ref/.no/.date/.bundle/.amount/.text_status/.url (577-582)
- **User-work stores:** none
- **State:** None.
- **Actions (2):**
  - button "Export CSV" → Same export as quantum_tab (ess_dcs_invoices.csv). (`exportInvoices 574`)
  - link a.doc "open" → Open invoice original. (`docLink 582`)
- **Exports:**
  - CSV `ess_dcs_invoices.csv`: ref,no,date,amount,bundle,text_status,url (`exportInvoices 574`)
- **Derived values and rules:**
  - Title 'Open Invoice Ledger' (NAV label 'Invoice Ledger'); subtitle L.length+' <party>-series invoices' (577)
  - KPI 'Gross invoiced (sum, unreconciled)' = money(sum over ledger of parseFloat(amount)\|\|0) computed client-side (579-580); sub text 'Authoritative claim = running Amount Due on the Quantum tab'
  - Table in data order, no sorting/filter/pagination (307 rows): Ref, Invoice no, Date (date\|\|'—'), Bundle badge, Amount (money), Status badge, Doc (581-582)
- **Originals:** invoiceLedger[].url via docLink
- **Example candidates:**
  - KPI equals money(DATA.quantum.grossInvoiced) for v5 data (sum matches)
  - Table shows 307 rows: 142 Original-bundle and 165 Supplementary-bundle
- **Source defects:**
  - `S-invoice_ledger_tab-1` (low) Title says 'Open Invoice Ledger' but there is no open/paid status; all ledger invoices are listed regardless of payment. Evidence: 577
- **Notes:** One ledger row has an empty amount and one an empty date (schema nonEmpty 306/307).

## Disbursements (`disbursements_tab`)

Group Case management. Owner CC-07. Live renderer line 617. Static: 4 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 617-618 via ledgerTab(cfg) 588-600 (generic: drawLedger 601-608, statusOrBundle 609, ledgerAdd 610-612, ledgerDel 613, ledgerCSV 614-615); single definition
- **Imported datasets:** cfg only (no DATA). window.__ledger[cfg.key]=cfg registry (591).
- **User-work stores:**
  - `ess_dcs_disbursements_v1` (read+write): [{date,desc,payee,amount}] — all values strings as typed. Read on render/draw (589, 601); appended on Add (611); spliced by array index on Delete (613). No seed (cfg.seed undefined -> []). Rows keyed only by position.
- **State:** Form inputs ids in_ess_dcs_disbursements_v1_<k>; not persisted until Add.
- **Actions (3):**
  - button "Add" → Collect all field values; if every field is empty do nothing (silent); else push, save, clear inputs, redraw, refresh stamp. (`ledgerAdd 610`)
  - button "Delete (per row)" → Remove row at index i (no confirmation), save, redraw. (`ledgerDel(key,i) 613`)
  - button "Export CSV" → Download store as CSV. (`ledgerCSV 614`)
- **Form fields (4):**
  - input date "Date" → field date (`read by ledgerAdd`)
  - input text "Description" → field desc (`ledgerAdd`)
  - input text "Payee" → field payee (`ledgerAdd`)
  - input text "Amount (R)" → field amount (no numeric validation) (`ledgerAdd`)
- **Exports:**
  - CSV `ess_dcs_disbursements_v1.csv`: date,desc,payee,amount (field keys, raw stored strings) (`ledgerCSV 614-615`)
- **Derived values and rules:**
  - Table columns = field labels Date, Description, Payee, Amount (R) (num, right); Amount cell = money(amount) (605); other cells esc(v\|\|''); rows in insertion order; empty -> 'No disbursements recorded.' (604). Title 'Disbursements', sub 'Disbursement ledger (saved in this browser)'. No totals row.
- **Originals:** None.
- **Example candidates:**
  - Add {date:<date>,desc:'x',payee:'y',amount:'1500'} -> table shows 'R 1 500.00'; CSV row '<date>,x,y,1500'
  - Add with all fields empty -> no row added
  - Amount 'abc' -> cell blank (money returns '')
- **Source defects:**
  - `S-disbursements_tab-1` (low) No validation (amount may be non-numeric, partial rows accepted if any one field set); Delete has no confirmation; rows keyed by array index. Evidence: 611, 613
  - `S-disbursements_tab-2` (medium) CSV export has no formula-injection protection for free-text fields. Evidence: 614-615 via toCSV 192
- **Notes:** Shared generic ledger semantics apply to timesheet, privilege, popia, annotations and transcripts tabs. ledgerAdd refreshes the freshness stamp although the stamp does not depend on this store.

## Timesheet (`timesheet_tab`)

Group Case management. Owner CC-07. Live renderer line 619. Static: 4 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 619-621 via ledgerTab 588-615; single definition
- **Imported datasets:** cfg only.
- **User-work stores:**
  - `ess_dcs_timesheet_v1` (read+write): [{date,fee_earner,activity,hours,rate,billed}] — billed is '' \| 'no' \| 'yes'. Same generic ledger read/append/splice-by-index; no seed. Also read by overview (319) for unbilled hours.
- **State:** Form inputs in_ess_dcs_timesheet_v1_<k>; Billed? select defaults to '' (placeholder 'Billed?').
- **Actions (3):**
  - button "Add" → as generic ledger (`ledgerAdd 610`)
  - button "Delete (per row)" → as generic ledger (`ledgerDel 613`)
  - button "Export CSV" → download (`ledgerCSV 614`)
- **Form fields (6):**
  - input date "Date" → date (`ledgerAdd`)
  - input text "Fee earner" → fee_earner (`ledgerAdd`)
  - input text "Activity" → activity (`ledgerAdd`)
  - input text "Hours" → hours (no validation) (`ledgerAdd`)
  - input text "Rate/h (R)" → rate (no validation) (`ledgerAdd`)
  - select "Billed? (placeholder / no / yes)" → billed (`ledgerAdd`)
- **Exports:**
  - CSV `ess_dcs_timesheet_v1.csv`: date,fee_earner,activity,hours,rate,billed (derived Value column NOT exported) (`ledgerCSV 614`)
- **Derived values and rules:**
  - Derived column 'Value' (num) = money((parseFloat(hours)\|\|0)*(parseFloat(rate)\|\|0)) (621) — shows 'R 0.00' when either is missing/non-numeric
  - Hours and Rate columns are right-aligned but shown raw (not money-formatted)
  - No totals in this view; overview sums unbilled hours (see overview defect)
  - Title 'Timesheet', sub 'Time-recording ledger with CSV export', empty 'No time recorded.'
- **Originals:** None.
- **Example candidates:**
  - hours '2.5', rate '1200' -> Value 'R 3 000.00'
  - hours '' rate '1000' -> Value 'R 0.00'
  - CSV header 'date,fee_earner,activity,hours,rate,billed'
- **Source defects:**
  - `S-timesheet_tab-1` (high) Billed? select values 'no'/'yes' are strings; overview treats 'no' as billed (truthy). Evidence: 620 opts:['no','yes']; 319 !t.billed
  - `S-timesheet_tab-2` (low) Derived Value is not included in the CSV export. Evidence: 614: head=cfg.fields.map(f=>f.k)
- **Notes:** Generic ledger semantics as described under disbursements_tab.

## Deadlines (`deadlines_tab`)

Group Case management. Owner CC-07. Live renderer line 632. Static: 4 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 632-655 (render 632-642, drawDeadlines 643-648, addDeadline 649-651, delDeadline 652, exportICS 653-655); single definition
- **Imported datasets:** None from DATA/META.
- **User-work stores:**
  - `ess_dcs_deadlines_v1` (read+write): [{title,date(YYYY-MM-DD),cat,note}]. Read on render/draw (633, 643); appended on Add (650); spliced by index on Delete (652); no seed. Also read by overview (318). Included in STORE_KEYS backup (2829).
- **State:** Form inputs dl_title, dl_date, dl_cat (select, no empty option -> defaults to 'Filing'), dl_note. After Add, title/date/note are cleared but category keeps its last value.
- **Actions (3):**
  - button "Add" → If title or date empty, silently return; else push {title,date,cat,note}, save, clear title/date/note, redraw, refresh stamp. (`addDeadline 649`)
  - button "Delete (per row)" → Splices index i of the UNSORTED stored array (no confirmation) — see defect. (`delDeadline(i) 652`)
  - button "Export .ics" → Download iCalendar file of all stored deadlines with a date. (`exportICS 653`)
- **Form fields (4):**
  - input text "Title" → title (required) (`addDeadline`)
  - input date "Date" → date (required) (`addDeadline`)
  - select "Category (Filing / Hearing / Discovery / Payment / Other)" → cat (`addDeadline`)
  - input text "Note" → note (`addDeadline`)
- **Exports:**
  - ICS `ess_dcs_deadlines.ics`: BEGIN:VCALENDAR / VERSION:2.0 / PRODID:-//<case-abbrev>//Workspace//EN; per stored deadline with a date (stored order, not sorted): BEGIN:VEVENT, UID:essdcs-<storeIndex>@workspace, DTSTART:<YYYYMMDD>T090000 (floating local time, no TZID), SUMMARY:<title or 'Deadline' with , and ; replaced by space>, DESCRIPTION:<cat+' '+note with , and ; replaced by space>, END:VEVENT; END:VCALENDAR. CRLF line endings, no trailing CRLF after END:VCALENDAR, no DTSTAMP/DTEND, no line folding. (`exportICS 653-655 (MIME text/calendar)`)
- **Derived values and rules:**
  - Table sorted by (date\|\|'').localeCompare ascending (643); undated rows (only possible via backup import) first
  - Countdown chip (646): du=daysUntil(date); null -> '—' muted; du<0 -> '<-du>d ago' muted; du===0 -> 'today' danger; 1<=du<=7 -> 'in <du>d' warning; du>7 -> 'in <du>d' success. Clock- and timezone-dependent (new Date()).
  - Category chip = cat\|\|'Other' (info style); note shown escaped in .ex cell
  - fmtICSDate (187): remove '-' from YYYY-MM-DD and append 'T090000'
  - Overview 'Open deadlines' = count with du>=0
- **Originals:** None.
- **Example candidates:**
  - With clock fixed at D: deadline at D -> 'today' (danger); D+7 -> 'in 7d' (warning); D+8 -> 'in 8d' (success); D-3 -> '3d ago' (muted)
  - Add with empty title -> nothing saved
  - Store [{title:'B',date:'2026-12-03'},{title:'A',date:'2026-11-01'}]: table shows A then B; clicking Delete on the first displayed row (A) removes B in legacy code
  - Export with one deadline {title:'File, plea',date:'2026-11-01',cat:'Filing',note:''} produces SUMMARY:File plea, DTSTART:20261101T090000, UID:essdcs-0@workspace, DESCRIPTION:'Filing ' (trailing space)
- **Source defects:**
  - `S-deadlines_tab-1` (high) Delete removes the wrong deadline whenever stored order differs from date order: the table index i comes from a sorted copy, but delDeadline splices the unsorted store. Evidence: 643: load(...).slice().sort(...); 647: onclick="delDeadline('+i+')"; 652: s.splice(i,1)
  - `S-deadlines_tab-2` (medium) ICS output is not RFC 5545 compliant: no DTSTAMP (required), commas/semicolons replaced instead of escaped, newlines/backslashes not escaped, no 75-octet folding, floating 09:00 time, UID derived from array index (changes after deletes, so calendar re-imports duplicate or mismatch events). Evidence: 653-655: 'UID:essdcs-'+i+'@workspace' ... .replace(/[,;]/g,' ')
  - `S-deadlines_tab-3` (low) Category select keeps its last value after Add; there is no edit function; Delete has no confirmation. Evidence: 639, 651, 652
  - `S-deadlines_tab-4` (low) Countdown uses local-time midnight; around DST or for users in other timezones day counts can differ from the court calendar date. Evidence: 186
- **Notes:** addDeadline refreshes the stamp though it does not depend on deadlines. Countdown is computed at render time only (no timer refresh).

## Discovery Schedule (`discovery_tab`)

Group Case management. Owner CC-09. Live renderer line 3220 (also defined at 658, overridden). Static: 10 handler sites, 0 navigation sites, 4 download calls, 1 download anchors, 1 print calls.

- **Code:** 3220-3256 inside the IIFE module 3185-3506 (LIVE: assigned later at script run, overrides). Dead earlier definition 658-670.
- **Imported datasets:** window.__SCHED__.discovery[] {no:int, date:str, co:str, desc:str, nfiles:int, files[] {fn, url, co, x?}} (233 items, 621 files); window.__SCHED__.supplementary[] same shape (234 items, 480 files); code constant CAP 3194-3204 {court, div, cnum, plaintiff, plaintiffCite (multi-line), plaintiffRole, defendant, defendantCite (multi-line), defendantRole} - hard-coded case caption; code constants in meta() 3207-3210: deed titles ("<case-name>" / "<case-name>"), sched ('FIRST SCHEDULE' / 'FIRST SCHEDULE A'), range ('Items <first> – <last>', never rendered), file ('Discovery Affidavit - First Schedule (cover)' / 'Supplementary Discovery Affidavit - First Schedule A (cover)'); DATA/META not read by the live module
- **User-work stores:**
  - `ess_dcs_schedule_co_v1` (read+write): object {<file url (./-relative, as in __SCHED__ files[].url)>: 'C'\|'O'}. read by fileCo (3214) for every chip and selected-file row; default when absent = files[].co from data, else 'C'. Written by setCo (per-file C/O button, 3342) and markSel (all selected urls, 3345). Keyed by original URL across both schedules. NOT in STORE_KEYS (not backed up).
  - `ess_dcs_schedule_sel_v1` (read+write): array of file url strings (Set serialised). read by selSet (3215) on every draw/toggle; written by toggleFile 3335, toggleItem 3339, Clear 3323, Empty bundle 3413, Remove 3414. One selection shared by both schedules, keyed by URL. NOT in STORE_KEYS.
  - `ess_dcs_schedule_mode_v1` (read+write): string 'discovery'\|'supplementary'. read once at module init into ST.mode (3190, default 'discovery'); written on mode switch (3320). NOT in STORE_KEYS.
- **State:** ST (3190) = {mode: load(MODE_KEY,'discovery'), view:'schedule', q:'', onlyMissing:false}; module-level, survives navigation (returning to the tab re-shows the last view, including the bundle view), lost on reload except mode; Mode switch resets ST.q='' and ST.onlyMissing=false (3320); DS_filter_debounce (3359) undeclared implicit global timer id; #ds-print-area div appended to <body> once at module init (3503-3505); body class 'ds-printing' toggled during print (3496-3497) with @media print CSS 3129-3133 hiding every other body child; No blob URLs in this view except via dl(); popups via window.open for cover page
- **Actions (23):**
  - button "Discovery Affidavit — First Schedule (<first>–<last>)" → ST.mode='discovery', save mode key, clear q and onlyMissing, re-render (`wire click data-act=mode 3320`)
  - button "Supplementary — First Schedule A (<first>–<last>)" → ST.mode='supplementary', same as above (`wire click data-act=mode 3320`)
  - input "Filter item, description or file…" → ST.q=value; after 140 ms debounce redraw list + row highlight (`DS.filter 3361`)
  - checkbox "Only unmatched (<n>)" → show only items with nfiles===0 and non-blank desc (`DS.onlyMissing 3362`)
  - button "Mark Copy" → set C for every selected url in CO map; alert if selection empty (`markSel('C') 3343`)
  - button "Mark Original" → set O for every selected url (`markSel('O') 3343`)
  - button "Clear" → empty selection store, redraw, update count (`wire act=clear 3323`)
  - button "Build court bundle ▸" → ST.view='bundle'; render drawBundle (`wire act=bundle 3324`)
  - button "Open / print cover page" → window.open blank, write coverDoc, print after 350 ms; popup blocked -> download HTML instead (`coverPage(true) 3483`)
  - button "Download cover page (uncertified)" → dl(meta.file+'.html', coverDoc, text/html) (`coverPage(false) 3490`)
  - checkbox "item row checkbox (select all files in item)" → add/remove all the item's file urls to selection; only rendered when the item has files; checked when every file selected (`toggleItem 3336`)
  - checkbox "file chip checkbox" → add/remove one url; row highlight + count update (`toggleFile 3335`)
  - button "C (per file)" → store C for that url, redraw (`setCo(url,'C') 3342`)
  - button "O (per file)" → store O for that url, redraw (`setCo(url,'O') 3342`)
  - link "Open (per file)" → same-window anchor (no target); .pdf -> in-app modal viewer; other extensions would navigate the app tab away (all 1,101 v5 schedule files are .pdf) (`global a.doc handler 205`)
  - link "Download (per file)" → browser download of original (`<a download> 3299`)
  - button "◂ Back to schedule (bundle view)" → ST.view='schedule', re-render (`onclick 3392/3410`)
  - button "Print / Save as PDF (index)" → fill #ds-print-area with caption + index table, window.print via printArea (`printBundle 3439`)
  - button "Download index (HTML)" → dl(bundleFile()+'.html', bundleHTML(files)) (`onclick 3412`)
  - button "Empty bundle" → clear whole selection (both schedules), redraw bundle view; no confirm (`onclick 3413`)
  - link "Open (bundle row)" → in-app viewer for pdf (`global a.doc handler`)
  - link "Download (bundle row)" → download original (`<a download> 3404`)
  - link "Remove (bundle row)" → remove that url from selection, redraw (`data-rm onclick 3414`)
- **Exports:**
  - HTML `Discovery Affidavit - First Schedule (cover).html \| Supplementary Discovery Affidavit - First Schedule A (cover).html`: coverDoc 3456-3482: caption (court, division, right-aligned case number line, 'In the matter between:', plaintiff citation + role, 'and', defendant citation + role, deed title underlined), h3 schedule name, table No./Document/Date/C/O over ALL items of the current schedule (i.no+'.', i.desc, i.date, i.co from data), footer legend 'C = Copy · O = Original · C&O = Copy and Original.', two signature lines 'Certified a true copy' and 'COMMISSIONER OF OATHS' (`coverPage(false) 3490, or coverPage(true) when popup blocked 3488`)
  - HTML print `n/a (popup window title = meta.file)`: same coverDoc written into window.open('') then print() after 350 ms (`coverPage(true) 3486-3487`)
  - HTML `<case-short-title> - Court Bundle Index.html (bundleFile() 3416 is a hard-coded constant)`: bundleHTML 3427-3437: h2 '<plaintiff> v <defendant>', caption '<court> <division> · <case-number line>' + 'COURT BUNDLE — INDEX OF DOCUMENTS (<n> documents)', table #/Item/Description/Date/Document/C/O with a section row per schedule (schedLabel) when schedule changes; # is running 1..n over selected files; C/O = user override or data co or 'C' (`Download index (HTML) 3412`)
  - HTML print `n/a (window.print of current page)`: same caption + table as bundleHTML injected into #ds-print-area; body.ds-printing hides all other body children in print media (`printBundle 3439-3446 -> printArea 3495-3500`)
- **Derived values and rules:**
  - Header counts (3223-3224): missing = items with nfiles===0 && desc.trim() non-empty; nfiles total = sum of item.nfiles; info bar '<deed> · <sched> · <items.length> items · <nfiles> files linked'
  - rowsFor 3258-3269: start from current-mode items; if onlyMissing keep nfiles===0 && desc.trim(); q = ST.q.trim().toLowerCase(); match if String(no).includes(q) OR desc.toLowerCase().includes(q) OR date.toLowerCase().includes(q) OR any files[].fn.toLowerCase().includes(q). Case-insensitive substring; item no matched as plain substring (q '1' matches 1,10,21...)
  - Item row: checkbox only if files exist; row class 'sel' when any file selected; item checkbox checked when all files selected; items with no files but non-blank desc show 'No separate document on file — see coverage note'; files with x show a dashed 'xref' chip with '↪ <x>'
  - Selected count = size of selection set (both schedules)
  - selectedFiles 3366-3375: iterate discovery then supplementary items, emit {schedule,no,desc,date,fn,url,co:fileCo(f)} for each file whose url is selected; sort by schedule (discovery 0, supplementary 1), then numeric item no, then fn.localeCompare. A url present in two items is emitted twice.
  - Bundle view row C/O cell coloured success for 'O', info otherwise
  - Cover page uses item-level i.co from data, NOT the per-file C/O overrides the user sets
  - toggleItem parses item id 'mode-no' by dropping the first '-' segment and finds the item in the CURRENT mode
- **Originals:** __SCHED__.{discovery,supplementary}[].files[].url (all './'-relative, percent-encoded paths; 1,101 occurrences all .pdf) used as href for Open (a.doc -> modal iframe) and Download (<a download>); No '#page=' fragments, no file inputs, no folder handles in this view
- **Example candidates:**
  - Filter: with q='<digit>' an item is kept iff String(no) contains that digit or desc/date/any fn contains it (case-insensitive)
  - Only unmatched: count shown equals number of items in the mode with nfiles===0 and non-blank desc
  - Selecting two files in different schedules then opening the bundle view lists discovery rows first, then supplementary, each block sorted by item number then file name; # column runs 1..n
  - fileCo: with no stored override and a data co of '', the chip shows 'C' active
  - Mark Original with an empty selection shows the alert 'Select one or more documents first (tick the file checkboxes).' and stores nothing
  - Switching mode persists ess_dcs_schedule_mode_v1 and clears the filter text and Only-unmatched flag
  - Cover download filename equals meta.file + '.html' for the active schedule
- **Source defects:**
  - `S-discovery_tab-1` (high) Event listeners accumulate on #main: wire(el) adds a click and a change listener to the persistent #main element on every render (each visit, each mode switch, each Back from the bundle view). Listeners are never removed, so one click runs N handlers: N alerts for Mark with no selection, N popup/print windows for cover-open, N downloads for cover-dl, and each mode click doubles the listener count (each handler re-renders and wires again). Statically inferred. Evidence: 3253 'wire(el);' inside RENDER.discovery_tab; 3317 'root.addEventListener('click', ...)'; 3320 'RENDER.discovery_tab(root)'; 3392/3410 back -> 'RENDER.discovery_tab(el)'; go() at 296 always passes the same #main element
  - `S-discovery_tab-2` (medium) Certified cover page ignores the user's Copy/Original marks; it prints the data-level item co, while the court bundle index prints per-file overrides. Two outputs can disagree. Evidence: 3452 'A(i.co\|\|'')' in coverRowsHTML vs 3370 'co:fileCo(f)'
  - `S-discovery_tab-3` (medium) Case caption, deed titles, schedule ranges and output filenames are hard-coded in code, not data. Evidence: 3194-3204 CAP; 3207-3210 meta(); 3229-3230 mode labels '(<first>–<last>)'; 3416 bundleFile()
  - `S-discovery_tab-4` (low) CAP strings and meta.file are inserted into generated HTML without escaping (only desc/date/fn are escaped). Safe for current constants but brittle. Evidence: 3434-3435 '<h2>'+CAP.plaintiff+' v '+CAP.defendant; 3458 '<title>'+md.file+'</title>'; 3469-3474
  - `S-discovery_tab-5` (low) ST.view persists across navigation: leaving from the bundle view and returning via nav shows the bundle view, not the schedule. Evidence: 3190 module-level ST; 3221 'if(ST.view==='bundle'){ return drawBundle(el); }'
  - `S-discovery_tab-6` (low) Implicit global DS_filter_debounce (undeclared assignment); works only in sloppy mode. Evidence: 3359 'DS_filter_debounce=null;'
  - `S-discovery_tab-7` (low) Open links have no target; a non-iframe extension would replace the whole app page (state lost). Not triggered by v5 data (all .pdf). Evidence: 3298 '<a class="doc" href="${A(f.url)}">Open</a>'; handler 209 only intercepts IFRAME_EXT
  - `S-discovery_tab-8` (low) Selection shared across both schedules and keyed by URL; 'Empty bundle' clears both without confirmation; a URL in two items is selected/deselected in both and appears twice in the bundle. Evidence: 3215-3216, 3339, 3370, 3413
  - `S-discovery_tab-9` (low) meta().range is defined but never used (labels hard-code ranges separately). Evidence: 3207/3209 'range:' vs 3229-3230
- **Notes:** Despite the name 'Build court bundle', this view does NOT assemble PDFs and does NOT use PDFK; it only produces an HTML index (print/download). The PDFK engine (691-1832) is used only by court_bundle_tab's builder (PDFK.openFile 2141, PDFK.assemble 2324, PDFK.indexOnly 2340). The dead renderer at 658 hard-codes 4 bundles and omits the Additional bundle. Wiring uses event delegation on #main via data-act / data-url / data-item-cb attributes; bundle-view buttons use direct onclick with data-b / data-rm. Requires window.open (popups) and window.print/afterprint.

## Court Bundle (`court_bundle_tab`)

Group Case management. Owner CC-09. Live renderer line 1942. Static: 40 handler sites, 0 navigation sites, 0 download calls, 2 download anchors, 0 print calls.

- **Code:** 1942-1947 (single definition). Module code 1837-2580 (constants, list/bundle/build views, builder, DOCX/ZIP writer). Uses PDFK engine 691-1832.
- **Imported datasets:** DATA.bundles.list[] {no, name, title, note, rows, pages, indexPages, filePages, file, indexFile} (14 bundles; nItems/nDocs/nMissing/nNeedsExtent/nReview/slug/bundlePages/planFile/items present in data but NOT read); DATA.bundles.list[].rows[] {n, key, desc, date, blank, missing (absent in v5 data), review (absent in v5 data), pages, from, to, sliceUrl, caselines{stamps, from}, parts[] {url, name, from, to, rel}} (655 rows, 1,292 parts; rows[].co present but not read here); DATA.bundles.headerDefaults {court, judge, intro, claimant, claimantRole, defendant, defendantRole, caseNo}; DATA.bundles.caselinesSrc (CBCLSRC 1853, 'verify page' links); DATA.bundles.source / DATA.bundles.indexSource (list-view footnote 1986, defaults hard-coded file names); DATA.bundles.catalogue -> CBCAT (1851) and DATA.bundles.folder -> CBFOLDER (1852): assigned but never used; code constants: CBK 1847-1849 {hdr:'ess_dcs_bundle_header_v2', ext:'ess_dcs_bundle_extents_v1', custom:'ess_dcs_custom_bundles_v1', ovr:'ess_dcs_bundle_overrides_v1', legacy:'ess_dcs_courtbundle_v1'} (only hdr and custom referenced); CBPH 1856-1858 placeholders {court:'[COURT / FORUM]', judge:'[DIVISION / PRESIDING OFFICER]', intro:'In the matter between:', claimant:'[PLAINTIFF NAME]', claimantRole:'PLAINTIFF', defendant:'[DEFENDANT NAME]', defendantRole:'DEFENDANT', caseNo:'[CASE NUMBER]'}; CBHF 1862-1869 eight header fields [key,label,placeholder,'ml'?] in order court, judge, intro, caseNo, claimant(ml), claimantRole, defendant(ml), defendantRole (placeholders include case-specific examples: <court>, <division>, <case-number>); CBIXCSS 2109-2118; CBRPR 2411; Hard-coded UI text: KPI 'Extracts' value 9 (1962); KPI subtitle 'as per <bundle-source-doc>' (1959); narrative paragraph quoting specific page numbers of the CaseLines file (1983)
- **User-work stores:**
  - `ess_dcs_bundle_header_v2` (read+write): object {court, judge, intro, caseNo, claimant, claimantRole, defendant, defendantRole} (strings; claimant/defendant may contain newlines). read by cbHdrRaw 1872 as overlay on DATA.bundles.headerDefaults (Object.assign). Save header 1875 writes all 8 input values; Restore matter defaults 1876 writes {} (defaults reappear); Clear all 1877 writes all 8 = '' (placeholders used). NOT in STORE_KEYS (STORE_KEYS lists the unused ess_dcs_bundle_header_v1).
  - `ess_dcs_custom_bundles_v1` (read+write): array [{no:'C<i>', name, pages (body pages), indexPages, filePages, note, rows:[{n, key:'', desc, pages, from, to, parts:[{rel:<file name>, url:'', name:<file name>, from, to}]}]}]. read by cbCustom 1896 and merged after shipped bundles in cbBundles; appended by cbBldSave 2365-2376 (no = smallest 'C'+i not used by custom or shipped bundles); filtered out by cbDeleteBundle 2381 (confirm). Keyed by no. In STORE_KEYS.
- **State:** CB (1854) = {view:'list'\|'bundle'\|'build', cur:null\|bundle no string, tab:'index'\|'items'\|'view', pick:'' (unused), embed:false}; module-level, survives navigation, lost on reload. cbGo(view,no,tab) sets view/cur, sets tab and resets embed=false when tab changes, re-renders #main and scrolls to top; CBBLOB (1855) = {bundle no: object URL} for bundles built and saved this session; cbFileUrl prefers it over b.file; lost on reload (saved custom bundles then have no file); CBBLD (2124) = {files:[{id:'f<seq>', name, size, doc:PDFK.Doc, pages}], rows:[{desc, segs:[{fileId\|null, name, rel?, from, to}]}], name:'', no:'' (unused), busy:false, msg:'', out:null\|{url (blob), pages, indexPages, bodyPages, file:<slug>.pdf, plan, title}, seq:1}; module-level, survives navigation, lost on reload; parsed PDFs held in memory; File input #cbbfile (multiple, accept application/pdf,.pdf) bound in cbBldBind 2127 (value reset after each pick); File.arrayBuffer() via PDFK.openFile 1803; Blob URLs: CBBLD.out.url (createObjectURL 2327; revoked on the next Create Bundle 2326); index-only PDF URL revoked after 4 s (2343); DOCX URL revoked after 2 s (2567); Popup windows: cbPrintBundle 2069, cbIndexPrint 2104, cbBldPrint 2360; iframes for embedded bundle (2064) and built bundle preview (2292)
- **Actions (55):**
  - button "All indexes (Word)" → one DOCX with the index of every bundle (shipped + custom), page break between bundles (`cbIndexAllDocx 2572`)
  - button "Build a bundle" → open builder view (`cbGo('build') 1957`)
  - button "Save header" → save all 8 field values to header key, re-render (`cbHdrSave 1875`)
  - button "Restore matter defaults" → save {} (data defaults show), re-render; no confirm (`cbHdrReset 1876`)
  - button "Clear all (use placeholders)" → save all fields '', placeholders used; no confirm (`cbHdrClear 1877`)
  - button "Open (bundle row)" → bundle view, Index tab (`cbGo('bundle',no,'index') 1974`)
  - link "Bundle PDF (bundle row, when file)" → open assembled PDF (b.file or session blob) (`<a target=_blank> 1975`)
  - button "Create (bundle row, when no file)" → open builder (not pre-filled) (`cbGo('build') 1976`)
  - link "Index PDF (bundle row, when indexFile)" → open shipped index PDF (`<a target=_blank> 1977`)
  - button "Word (bundle row)" → DOCX index for that bundle (`cbIndexDocx 2570`)
  - button "Delete (custom bundle rows only)" → confirm, remove from custom store, drop session blob, list view (`cbDeleteBundle 2380`)
  - button "All bundles (bundle view)" → back to list (`cbGo('list') 1996`)
  - link "Open bundle PDF (bundle view header)" → open PDF (`<a target=_blank> 1997`)
  - link "Download bundle" → download PDF (`<a download> 1998`)
  - button "Index (tab)" → index preview tab (`cbGo('bundle',no,'index') 2000`)
  - button "Items & page numbers (tab)" → items table tab (`cbGo('bundle',no,'items') 2001`)
  - button "View bundle (tab)" → viewer tab (`cbGo('bundle',no,'view') 2002`)
  - button "Download Word (.docx) (index tab)" → DOCX index (`cbIndexDocx 2077`)
  - button "Print index" → popup with index HTML (CBIXCSS, body margin 28mm 24mm), print after 350 ms; alert if popup blocked (`cbIndexPrint 2102`)
  - link "Index PDF (index tab)" → open shipped index PDF (`<a target=_blank> 2079`)
  - link "Full bundle (index tab)" → open bundle PDF (`<a target=_blank> 2080`)
  - button "Edit header details" → list view where the header card lives (`cbGo('list') 2081`)
  - link "source part link (items tab)" → open source file (url + '#page=<from>' when from>1); from>1 links bypass modal (fragment breaks ext test) and open in new tab (`docLink 2026`)
  - link "verify page <n> (items tab, rows with caselines)" → open DATA.bundles.caselinesSrc + '#page=' + caselines.from (`<a target=_blank> 2029`)
  - link "Open item" → open extract (sliceUrl) or bundle at physical page, or first part (`cbItemUrl 1924 -> <a target=_blank> 2033`)
  - link "Save extract (rows with sliceUrl)" → download the extract PDF (`<a download> 2034`)
  - link "in the bundle at page <NNN> (rows with sliceUrl)" → open bundle at cbPhys(from) (`<a target=_blank> 2035`)
  - button "Open the builder (view tab, no file)" → builder (`cbGo('build') 2051`)
  - link "Open in a new tab (view tab)" → open PDF (`<a target=_blank> 2053`)
  - link "Download PDF (view tab)" → download PDF (`<a download> 2054`)
  - button "Print (view tab)" → window.open(PDF), print() after 1500 ms; alert if blocked (`cbPrintBundle 2068`)
  - button "Index (Word) (view tab)" → DOCX index (`cbIndexDocx 2056`)
  - button "Load bundle in the app" → embed iframe src=<file>#page=1, height 78vh (`inline CB.embed=true; cbGo(...) 2061`)
  - button "All bundles (builder)" → list view (builder state kept) (`cbGo('list') 2219`)
  - file-input "Add PDFs…" → parse each .pdf with PDFK; skip duplicates (same name+size); attach to waiting segments by lower-cased file name; add a new row if not attached; alert for non-PDF-only selection or unreadable/encrypted files (`cbBldAdd 2132 via cbBldBind 2127`)
  - select "Start from a defined bundle…" → replace builder rows with the bundle's rows (segments from parts, fileId null until a same-named PDF is added); set name; clear out; no confirm (`cbBldFrom 2190`)
  - button "Clear (builder)" → confirm, discard files, rows, out (name kept) (`cbBldClear 2165`)
  - input "Description for the index (per item)" → set row desc (no re-render) (`cbBldSetDesc 2170 (onchange)`)
  - select "segment source file" → point segment at file; reset range to 1..pages (`cbBldSegFile 2183`)
  - input "segment from page" → parseInt; <1 or NaN -> 1; clamp to file pages (99999 if no file); raise to if to<from (`cbBldSetSeg(i,j,'from') 2171`)
  - input "segment to page" → same clamping; if to<from then to=from (`cbBldSetSeg(i,j,'to') 2171`)
  - button "✕ remove range" → remove segment; remove row if no segments left (`cbBldSegDel 2179`)
  - button "+ another range" → append segment using FIRST added file, full range (no-op if no files) (`cbBldSegAdd 2181`)
  - button "↑" → swap with previous row (`cbBldRowMove(i,-1) 2167`)
  - button "↓" → swap with next row (`cbBldRowMove(i,1) 2167`)
  - button "✕ delete item" → remove row; no confirm (`cbBldRowDel 2169`)
  - button "+ Add an item" → new row with empty desc and first file full range; alert if no files (`cbBldNewRow 2186`)
  - input "Bundle name" → CBBLD.name = value (`cbBldBind oninput 2129`)
  - button "Create Bundle" → assemble PDF via PDFK.assemble; confirm when items lack files (they are skipped); disabled while busy or 0 pages (`cbBldRun 2309`)
  - button "Index only (PDF)" → download index PDF whose links point (GoToR) at '<slug>.pdf' (`cbBldIndexOnly 2337`)
  - button "Index (Word) (builder)" → DOCX index; hyperlinks only if the current plan matches the last built output (`cbBldIndexDocx 2346`)
  - link "Download PDF (built)" → download built bundle (`<a download=<slug>.pdf> 2286`)
  - link "Open in a new tab (built)" → open blob (`<a target=_blank> 2287`)
  - button "Print (built)" → window.open(blob), print after 1200 ms (`cbBldPrint 2358`)
  - button "Save to the bundle list" → persist definition as custom bundle C<i>; register blob for this session; open its index tab (`cbBldSave 2365`)
- **Form fields (1):**
  - input/textarea "8 index header fields (Court line, Division/presiding officer line, Introductory line, Case number, Plaintiff citation (multi-line), Plaintiff label, Defendant citation (multi-line), Defendant label)" → edited values only persist on Save header; textarea rows = max(3, lines+1) (`read by cbHdrSave via val('cbh_<key>')`)
- **Exports:**
  - DOCX `Index_<cbSlug(no+'_'+name)>.docx`: single-bundle index (header block, INDEX, title, 3-column table n./description/page range, hyperlinks) (`cbIndexDocx 2570 (list row Word, index tab, view tab)`)
  - DOCX `<case-abbrev>_Court_Bundle_Indexes.docx (hard-coded at 2573)`: every bundle's index in one document, each after the first starting with a page break (`cbIndexAllDocx 2572`)
  - DOCX `Index_<cbSlug(title)>.docx`: builder index; links into '<slug>.pdf#page=<from+indexPages>' only when CBBLD.out matches (same title and same row count) (`cbBldIndexDocx 2346`)
  - PDF `<cbSlug(title)>.pdf`: index pages (unnumbered) + selected page ranges, every body page stamped with continuous number from 1; index rows link to body pages (`cbBldRun 2309 then Download PDF link 2286`)
  - PDF `Index_<cbSlug(title)>.pdf`: index pages only; row links are GoToR to '<slug>.pdf' at page index (front pages + from - 1) (`cbBldIndexOnly 2337`)
  - HTML print `n/a (window title 'Index — <bundle title>')`: cbIndexHtml in popup with CBIXCSS (`cbIndexPrint 2102`)
  - PDF print `n/a`: opens the shipped/built PDF in a popup and calls print() (`cbPrintBundle 2068, cbBldPrint 2358`)
  - CSV (dead code) `Index_<cbSlug(no+'_'+name)>.csv`: header item,ref,description,pages,page_nos,sources; sources = parts 'name from-to' joined ' \| ' (`exportBundle 2575 - never called anywhere`)
- **Derived values and rules:**
  - cbBundles 1897-1907: shipped = DATA.bundles.list mapped {no,name,title\|\|'('+no+') '+name,note\|\|'',rows copy,pages\|\|0,indexPages\|\|0,filePages\|\|0,file\|\|'',indexFile\|\|'',shipped:true}; then custom store entries {title:'('+no+') '+name, note default 'Bundle created in this app.', file:'', indexFile:'', shipped:false, def}
  - List header: '<n> bundles · <sum rows.length> index items · <sum pages> paginated pages...'; KPIs Bundles, Index items, Pages, Extracts (hard-coded 9)
  - cbTot 1931-1933: items=rows.length; pages=b.pages\|\|0; missing=rows where !blank && (missing \|\| !pages); blank=count blank. Status badge '<missing> to review' (warn) else 'complete'; custom bundles also get a 'custom' badge. v5 rows carry no 'missing'/'review' fields (per schema), so missing reduces to 0-page non-blank rows and the 'extent auto-detected — verify' badge never shows (uncertain only insofar as schema sampling is complete)
  - cbHdr 1873-1874: for each CBHF key value = (raw[key]\|\|'').trim() \|\| CBPH[key]; _blank = keys whose raw value is blank after trim; raw = headerDefaults overlaid with stored v2 object
  - cbPad 1909: String(n\|\|0) left-padded with '0' to length 3 (longer numbers unchanged)
  - cbRange 1910-1911: '' if !r \|\| !r.pages \|\| !r.from; from===to ? pad(from) : pad(from)+' – '+pad(to) (en dash). PDF index (normSpec 1655) instead uses pad3(from)+' - '+pad3(to) (hyphen) when to>from, pad3(from) otherwise, '' when from or to falsy
  - cbDesc 1912-1917: d = desc.trim() \|\| '[DESCRIPTION TO BE COMPLETED]'; dt = date.trim(); append ' – '+dt unless d with all whitespace removed and upper-cased ends with dt normalised the same way; result upper-cased
  - cbPhys(b,n) 1922 = (n\|\|1) + (b.indexPages\|\|0) - physical PDF page of stamped page n
  - cbItemUrl 1924-1930 priority: r.sliceUrl; else if bundle file and r.from: file+'#page='+cbPhys; else parts[0].url + ('#page='+parts[0].from if from>1); else ''
  - cbDocHref 2448-2460 (DOCX links): b.file && r.from -> b.file+'#page='+cbPhys; else sliceUrl; else parts[0].url(+#page); never a blob URL (b.file only, not CBBLOB); leading './' removed
  - cbBldPlan 2200-2214: running p=1; per row, per segment with a file: a=max(1,min(from,pages)), z=max(a,min(to,pages)), n+=z-a+1; segments without file contribute 0; row.from = n? p : 0, row.to = n? p+n-1 : 0; p+=n; total pages = p-1. Matches the assembler's stamping
  - cbBldTitle 2305: (CBBLD.name \|\| input value \|\| 'NEW BUNDLE').trim().toUpperCase(), written back to CBBLD.name
  - cbBldSpec 2297-2304: header from cbHdr (placeholders included), title, rows {n:k+1, desc:cbDesc({desc}), from, to, pages} for ALL plan rows (rows without file get blank page numbers but still a number)
  - cbSlug 2569: replace runs of non [A-Za-z0-9] with '_', trim leading/trailing '_', cut to 60 chars
  - PDFK.assemble 1500-1606: new object graph; index pages first (drawIndex), then for each source range copy pages a..z (a=max(1,from), z=min(pages,to)); per page: prune /Resources to names used by the content (RES_KEYS XObject, Font, ExtGState, ColorSpace, Pattern, Shading, Properties), drop Parent/Annots/B/StructParents/Tabs before deep copy, materialise inherited MediaBox/CropBox/Rotate, wrap content as [q] + original + [Q + stamp], add Helvetica-Bold WinAnsi font as /ZaPgNo; body numbering n starts at opts.start (1) and increments per copied page; index row links = /Link annots with GoTo to kids[indexPages + from - 1], XYZ 0 841.89. Returns {blob, pages: total, indexPages, bodyPages, map}
  - stampOps 1608-1618: font size 11, pad 18, tw = Helvetica-Bold width; rotation 0: matrix [1 0 0 1 x0+w/2-tw/2, y0+14] (bottom centre); 90: [0 1 -1 0 x0+18, y0+h/2-tw/2]; 180: [-1 0 0 -1 x0+w/2+tw/2, y1-18]; 270: [0 -1 1 0 x1-18, y0+h/2+tw/2]; draws the number twice: invisible white (3 Tr) then black. Number text = plain integer, not zero-padded. Uses MediaBox (default A4 595.28x841.89), ignores CropBox
  - drawIndex 1663-1762: A4 595.28x841.89, margins L62 R62 T58 B52, column widths 9%/71%/20% of content width, font Helvetica-Bold 8.5 pt, line height 11.1; first page head: court lines (10pt centred, wrapped), judge, 'CASE NUMBER: <caseNo>' right-aligned 9pt, intro, claimant lines with role right-aligned on first line, 'and', defendant likewise, 'INDEX', title; continuation pages 'INDEX: <title> (continued)'; row height = max wrapped lines * 11.1 + 7; new page when y - rh < 52; page-number cell blue when row has pageNos and from; all text passed through ascii() which maps smart quotes/dashes/ellipsis/nbsp and DROPS every other non-ASCII character
  - indexOnly 1810-1826: index pages only; GoToR to remote file at page index (frontPages ?? index page count) + from - 1
  - PDF writer Out.blob 1305-1323: header %PDF-1.7, one classic xref table, trailer /Size /Root; Copier deep-copies referenced objects once per source doc
  - PDF reader: classic xref and xref streams, object streams, hybrid; falls back to brute-force object scan; '/Encrypt' in trailer -> throws 'ENCRYPTED' (builder shows a password-protected alert); unsupported filters (e.g. DCT on content streams is not decoded; only Flate/AHx/A85) throw from decode, which contentBytes swallows (then nothing is pruned)
  - cbZip 2388-2409: stored entries (method 0), version 20, flags 0, DOS time/date 0, CRC-32 poly 0xEDB88320 (cbCrc32 2387), local headers + central directory + EOCD; entry order [Content_Types].xml, _rels/.rels, docProps/core.xml, docProps/app.xml, word/_rels/document.xml.rels, word/document.xml, word/styles.xml; Blob type docx MIME
  - DOCX layout cbDocx/cbBundleXml: A4 11906x16838 twips, margins top 1134 right 1440 bottom 709 left 1440; all text Verdana bold; default style Times New Roman 10pt, lang en-ZA; court/judge centred (multi-line split per line), 'CASE NUMBER: <caseNo>' right-aligned when caseNo non-empty (always, because of placeholder fallback), blank paragraphs, intro, party paragraphs with right tab at 9360 carrying the role on the first line, 'and', 'INDEX' and title centred; table grid columns 846/6237/1933 twips, row height 403, cells: 'n.' centred, cbDesc justified (hyperlink, black), cbRange centred (hyperlink, blue 0D3399 underlined); hyperlink relationships rIdH<k> TargetMode External; core.xml title 'Index — <title>' (one bundle) or 'Court bundle indexes', creator/lastModifiedBy '<case-short-title> Counsel Workspace'; app.xml Application 'Microsoft Office Word'
  - cbBldSave numbering: i from 1 upward until 'C'+i is unused by custom and shipped bundles
- **Originals:** DATA.bundles.list[].file (assembled bundle PDF, './'-relative) opened in new tab, downloaded, embedded in iframe with '#page=1', and linked at '#page=<from+indexPages>'; DATA.bundles.list[].indexFile (index PDF) in new tab; rows[].sliceUrl (cut extract PDF) open/download; rows[].parts[].url with '#page=<from>' when from>1 (docLink); DATA.bundles.caselinesSrc + '#page=<caselines.from>'; Session blob URLs for builder output (CBBLOB / CBBLD.out.url); File input of user-selected PDFs (read into memory with File.arrayBuffer; nothing uploaded); no showDirectoryPicker here; DOCX hyperlinks: relative path with './' stripped (Word resolves against the docx's own folder)
- **Example candidates:**
  - cbPad(7)='007', cbPad(1234)='1234'
  - cbRange({pages:3,from:5,to:7})='005 – 007'; cbRange({pages:1,from:12,to:12})='012'; cbRange({pages:0,from:5,to:5})=''
  - cbDesc({desc:'Letter of demand', date:'3 February 2001'})='LETTER OF DEMAND – 3 FEBRUARY 2001'; cbDesc({desc:'Letter 3 February 2001', date:'3 February 2001'})='LETTER 3 FEBRUARY 2001' (no duplicate); cbDesc({desc:''})='[DESCRIPTION TO BE COMPLETED]' (synthetic values)
  - cbPhys({indexPages:2},1)=3; cbItemUrl with no sliceUrl, file 'x.pdf', indexPages 2, from 10 -> 'x.pdf#page=12'
  - cbBldPlan with rows [A: file 10 pages, range 3-5], [B: file 4 pages, range 1-99], [C: no file] -> A from 1 to 3, B from 4 to 7 (to clamped to 4 pages), C pages 0 from 0, total 7
  - cbBldSetSeg: value 'abc' -> 1; value beyond file page count -> page count; setting from above to raises to
  - cbSlug('Expert Reports (Vol. 2)')='Expert_Reports_Vol_2'
  - cbHdr with headerDefaults {court:'X'} and stored {court:''} -> court placeholder '[COURT / FORUM]' and _blank includes 'court'
  - cbBldSave with custom C1 existing and no shipped C* -> new no 'C2'
  - cbCrc32 of the ASCII bytes '123456789' = 0xCBF43926 (standard CRC-32 check value)
  - Assembled PDF: page count = index pages + sum of range lengths; first body page carries stamp '1'
- **Source defects:**
  - `S-court_bundle_tab-1` (medium) Form XObject detection never fires: Subtype is a PName object without toString, so String(PName) is '[object Object]', never 'Form'. Resource-less Form XObjects therefore are not scanned for borrowed names, and resources they use (fonts/images) can be pruned from the copied page -> missing glyphs/images in assembled bundles. Statically inferred. Evidence: 1434 'if (String(doc.get(v.d.get('Subtype')) \|\| '') !== 'Form') continue;' and 1470 same test; PName defined 695 with no toString
  - `S-court_bundle_tab-2` (medium) Re-running Create Bundle revokes the previous output blob URL even after it was saved to the list; the saved custom bundle's session PDF link then breaks. Evidence: 2326 'URL.revokeObjectURL(CBBLD.out.url)'; 2377 'CBBLOB[no]=CBBLD.out.url'
  - `S-court_bundle_tab-3` (low) Saved custom bundles store parts with url '' ; after reload cbItemUrl/docLink build '#page=N' hrefs for parts whose from>1 (link to the app itself). Evidence: 2375 'url:''' ; 1928 'r.parts[0].url+(r.parts[0].from>1?'#page='+...)'; 2026
  - `S-court_bundle_tab-4` (medium) Header store key moved to _v2 but STORE_KEYS still lists _v1, so the index header is not backed up or restored. Evidence: 1847 'hdr:'ess_dcs_bundle_header_v2'' vs 2829 ''ess_dcs_bundle_header_v1''
  - `S-court_bundle_tab-5` (low) Async builder work re-renders the court bundle builder into #main when it finishes, even if the user navigated to another tab meanwhile (nav highlight and CURRENT then disagree). Evidence: 2154 'cbGo('build')' at end of cbBldAdd; 2335 at end of cbBldRun; cbGo 1939 renders unconditionally
  - `S-court_bundle_tab-6` (low) PDF index silently drops non-ASCII characters (accented names etc.); HTML and DOCX indexes keep them, so outputs differ. Evidence: 1379 '.replace(/[^\x20-\x7e]/g, ...)'
  - `S-court_bundle_tab-7` (low) Page-range separator differs: HTML/DOCX use en dash ' – ', PDF index uses ' - '. Evidence: 1911 vs 1655
  - `S-court_bundle_tab-8` (low) Page-number stamp positioned from MediaBox only; pages with a smaller CropBox may have the number cropped out of view. Evidence: 1560 'src.doc.get(mediaOf(p))'; stampOps 1608
  - `S-court_bundle_tab-9` (low) Source-part links with '#page=' bypass the in-app viewer (ext test sees '.pdf#page=n') and open in a new tab, while from=1 parts open in the modal: inconsistent behaviour. Evidence: 2026 docLink(p.url+(p.from>1?'#page='+p.from:'')...); 208 ext computation
  - `S-court_bundle_tab-10` (low) Dead code and dead constants: exportBundle (CSV) never called; CBCAT, CBFOLDER, CB.pick, CBBLD.no, CBK.ext/ovr/legacy unused. Evidence: 2575; 1851-1852; 1854; 2124; 1847-1849
  - `S-court_bundle_tab-11` (low) Hard-coded case content: Extracts KPI value 9, KPI/footnote source document names, narrative with specific CaseLines page numbers, CBHF example values (<court>, <division>, <case-number>), DOCX creator and all-indexes filename containing the case abbreviation. Evidence: 1959-1962, 1983, 1986, 1862-1866, 2550, 2573
  - `S-court_bundle_tab-12` (low) Save to the bundle list can be pressed repeatedly, creating duplicate custom bundles (C1, C2...) for the same output. Evidence: 2365-2378 (CBBLD.out not cleared)
  - `S-court_bundle_tab-13` (low) Header 'Restore matter defaults' and 'Clear all' overwrite without confirmation. Evidence: 1876-1877
  - `S-court_bundle_tab-14` (low) Debug hook: if a global PDFKDBG exists, assemble logs per page to console.error. Evidence: 1539-1540
  - `S-court_bundle_tab-15` (low) After Create Bundle, a page range is edited without creating again and Index (Word) is pressed: each row still links into the bundle PDF at the pages it had when created, so after a range shrinks the rows link to the wrong pages. Evidence: 2352 (compares only the title and the item count)
- **Notes:** 14 shipped bundles come from DATA.bundles.list (not hard-coded); custom bundles are appended. The PDFK engine is used ONLY by this view's builder (PDFK.openFile 2141, assemble 2324, indexOnly 2340). Fully offline: DecompressionStream for Flate, File.arrayBuffer, Blob/object URLs; no network. Browser APIs required: DecompressionStream, TextEncoder, Blob, URL.createObjectURL, window.open/print (popups), iframe PDF rendering. The header card lives only on the list view; the index tab links back to it. A reimplementer must reproduce: three index renderings (HTML preview/print, DOCX, PDF) from the same header + rows, cbDesc upper-casing and date de-duplication, 3-digit page padding, physical page offset = indexPages, and builder numbering per cbBldPlan.

## CaseLines (`caselines_tab`)

Group Case management. Owner CC-09. Live renderer line 3523. Static: 11 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 3523-3575 inside IIFE 3513-3644 (single definition)
- **Imported datasets:** window.__CASELINES_IDX__.pages (int, 1 value) -> BUNDLE.pages, fallback hard-coded 1745 (3516); window.__CASELINES_IDX__.index[] = [[page:int, text:str], ...] (1,745 entries) -> IDX (3517); window.__CASELINES_IDX__.file - present but NOT read; code constant BUNDLE 3514-3516 {name:'<caselines-bundle>.pdf', url:'./<pleadings-folder>/<caselines-bundle>.pdf' (percent-encoded, hard-coded), pages}; hard-coded text '<case-name> (PN-001)' (3530)
- **User-work stores:**
  - `ess_dcs_caselines_docs_v1` (read+write): array [{name, url}] where url = './' + path segments each encodeURIComponent'd. read on render (3550) and in drawDocs 3625; appended by Link file (3620, no de-duplication or existence check); entry removed by list index on Remove (3641). NOT in STORE_KEYS.
- **State:** CST (3520) = {q:'', res:null\|{q, res:[{p, count, snip}]}}; module-level, survives navigation (results re-rendered on return), lost on reload; uploads (3519) = [{name, size, url (blob from createObjectURL(File)), ext}] module-level, survives navigation, lost on reload; never revoked; File input #cl-file (multiple, any type) and drag-and-drop zone #cl-drop (dragenter/dragover add class 'drag'; dragleave/drop remove; drop reads dataTransfer.files)
- **Actions (16):**
  - link "Open in app" → modal viewer on BUNDLE.url (`global a.doc handler 205`)
  - link "Open in new tab" → open bundle PDF (`<a target=_blank> 3533`)
  - link "Download" → download bundle PDF (`<a download> 3534`)
  - input "Type a word or phrase, then Enter…" → run search (`keydown Enter -> doSearch 3565`)
  - button "Search <pages> pages" → run search (`doSearch 3564`)
  - input+button "Go to page <n> / Open" → if parseInt >= 1 open viewer at '#page=<n>' (no upper bound check) (`3566 -> openAt`)
  - div click "search result row 'p.<n> …snippet…'" → open viewer at that page (`3608 -> openAt`)
  - file-input "browse" → create blob URL per file, add to session list (`addUploads 3567`)
  - drag "Drag & drop files here" → same as browse (`drop 3571 -> addUploads`)
  - input+button "link a file already in the case folder / Link file (permanent)" → normalise to './'-relative encoded URL, append to store, clear input (`linkPath 3615`)
  - link "Open (linked doc)" → modal viewer when extension is in IFRAME_EXT, else same-tab navigation (`global a.doc handler`)
  - link "Download (linked doc)" → download (`<a download> 3630`)
  - link "Remove (linked doc)" → splice store by index, redraw; no confirm (`data-rmlink onclick 3641`)
  - link "Open (session upload)" → blob URL has no extension -> NOT intercepted -> same-tab navigation away from the app (`global a.doc handler`)
  - link "Download (session upload)" → download blob (`<a download=name> 3636`)
  - link "Remove (session upload)" → splice uploads by index (blob not revoked) (`data-rmup onclick 3642`)
- **Exports:** none
- **Derived values and rules:**
  - doSearch 3579-3592: q = input.trim(); CST.q=q; empty -> clear results and CST.res=null. If IDX empty -> openViewer(BUNDLE.url+'#search='+encodeURIComponent(q)) (browser PDF find). Else ql=q.toLowerCase(); for each [p,t] in IDX: lo=t.toLowerCase(); count non-overlapping occurrences via indexOf from hit+ql.length; loop stops once count>50 (so count max 51); first = first hit offset; pages with count>0 produce {p, count, snip}. Results sorted by page ascending
  - snippet 3593-3597: window = [max(0,at-70), min(len, at+qlen+90)); prefix '… ' if start>0, suffix ' …' if end<len; match wrapped in <mark>; all pieces attribute-escaped. Offsets from lower-cased text applied to original text
  - renderResults 3598-3609: none -> 'No pages contain “<q>”.'; else '<pages> page(s) · <sum counts> occurrence(s) of “<q>”.'; show first 400 pages, then note 'Showing first 400 pages — refine the search to narrow.'; '(<count>×)' suffix when count>1
  - linkPath 3615-3622: raw trimmed; empty -> no-op; rel = raw.replace(/^\.?\/*/,'') (drops one leading '.' and leading slashes); url = './' + rel.split('/').map(encodeURIComponent).join('/'); name = decodeURIComponent(last segment)
  - Upload list size label: Math.round(size/1024).toLocaleString()+' KB'
  - Hint 'Full-text index not loaded — searching opens Chrome’s built-in PDF find instead.' shown when IDX empty
- **Originals:** BUNDLE.url (hard-coded './'-relative path) for Open in app (modal iframe), new tab, download; '#page=<n>' for go-to-page and result clicks; '#search=<q>' fallback; User-linked paths stored as './'-relative URLs; Session uploads via File input / drag-drop -> blob: URLs (not persisted); No showDirectoryPicker; no network
- **Example candidates:**
  - Search is case-insensitive substring: a page whose text contains 'Foo foo FOO' yields count 3 for q 'foo'
  - Results ordered by ascending page and capped at 400 rendered rows; total occurrences summed over all matching pages
  - Per-page count saturates at 51 (loop breaks when count exceeds 50)
  - Snippet keeps at most 70 characters before and 90 after the first hit, with ellipsis markers when truncated
  - linkPath('/Folder A/x&y.pdf') stores {name:'x&y.pdf', url:'./Folder%20A/x%26y.pdf'} (synthetic path)
  - Go to page with empty or 0 input does nothing; 5 opens viewer at '<bundle url>#page=5'
  - Whitespace-only query clears results
- **Source defects:**
  - `S-caselines_tab-1` (medium) Session-upload 'Open' links are a.doc anchors to blob: URLs without target; the global handler finds no file extension in the blob URL, does not intercept, and the browser navigates the app tab itself to the blob (app state, including the uploads list, is lost). Evidence: 3635 '<a class="doc" href="'+u.url+'"'; 207-209 ext from url.split('/').pop()
  - `S-caselines_tab-2` (medium) <case-name> name, path, fallback page count and PN ref are hard-coded in code; __CASELINES_IDX__.file is ignored. Evidence: 3514-3516; 3530
  - `S-caselines_tab-3` (medium) Linked documents are not in STORE_KEYS, so they are not backed up. Evidence: 3518 vs 2829
  - `S-caselines_tab-4` (low) linkPath double-encodes already-encoded input ('%20' -> '%2520') and encodes Windows backslashes, producing broken links; no existence check or de-duplication. Evidence: 3617-3620
  - `S-caselines_tab-5` (low) Snippet offsets computed on toLowerCase() text are applied to original text; for characters whose lower-case form changes length the highlight shifts. Evidence: 3586 'lo=t.toLowerCase()' ; 3588 snippet(t,first,q.length)
  - `S-caselines_tab-6` (low) Removing an upload does not revoke its blob URL (memory held until reload). Evidence: 3642
  - `S-caselines_tab-7` (low) Go-to-page has no upper bound check (max attribute only). Evidence: 3566
- **Notes:** No exports of its own. The page index is a linear scan of all page texts (no inverted index). The '#search=' fallback relies on Chromium PDF viewer behaviour. Requires drag-and-drop and object URLs.

## Contradiction Tracker (`contradictions_tab`)

Group Analysis. Owner CC-05. Live renderer line 2662. Static: 1 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 2662-2695
- **Imported datasets:** DATA.contradictions (if falsy -> empty state 'No contradiction data.', 2664); DATA.contradictions.total, .highCount, .byCat.rate, .byCat.units, .categories.length (2668-2671); DATA.contradictions.checks[].check, .result (2674); checks[].n unused; DATA.contradictions.categories[] (4) .key, .title, .severity, .explain, .items[] (33) (2677-2692); items[].label, .detail, .spread, .rates{'BID RATE','OLD RATE','NEW/STANDARD'\|'NEW RATE'} (2682-2688); items[].refs[].ref, .url, .filename, .amount (2661); META.docCount (2693)
- **User-work stores:** none
- **State:** none
- **Actions (2):**
  - button "Export CSV" → downloads every item of every category (`exportContradictions 2696`)
  - link "ref chip '<ref> · R <amount>'" → opens refs[].url in viewer; title tooltip = filename (`refChips 2661 + delegated viewer`)
- **Exports:**
  - CSV `ess_dcs_contradictions.csv`: category,severity,item,detail,spread,refs (`exportContradictions 2696-2698: category=c.title, severity=c.severity (raw key, e.g. high), item=it.label, detail=it.detail\|\|'', spread=it.spread\|\|'' (raw string), refs = it.refs[].ref joined by single space`)
- **Derived values and rules:**
  - All flags are precomputed in DATA at build time; the app computes nothing except formatting. Category order = DATA order (no sort by severity); item order = DATA order.
  - KPIs (2668-2671): Total flags = C.total; 'across N categories' N = categories.length; High severity = C.highCount (precomputed, not recounted); Rate-conflict months = byCat.rate\|\|0; Supplied-vs-actual pairs = byCat.units\|\|0. In v5: 4 categories keys rate(high,6) units(high,19) recovery(info,7) dupamt(low,1); total 33; highCount 25 = 6+19.
  - Checks table (2674): result matching /PASS/ -> ok badge; /FLAG/ -> danger badge; else plain text
  - Category card header: sevBadge(severity), title, 'N item(s)'; explain line (2678-2679)
  - key==='rate' table (2680-2685): Month=label, Bid=money(rates['BID RATE']), Old=money(rates['OLD RATE']), New/standard=money(rates['NEW/STANDARD']\|\|rates['NEW RATE']), Spread=money(spread) in red, Sources=refChips
  - Other keys (2687-2688): Item=label, Detail=detail + (spread? ' Δ '+money(spread)) , Sources=refChips
  - Narrative footer interpolates META.docCount.toLocaleString() (2693)
- **Originals:** refs[].url embedded per ref object (not allRows lookup); all 64 v5 refs also resolve in DATA.chronology
- **Example candidates:**
  - Synthetic category {key:'rate',severity:'high',items:[{label:'M1',rates:{'BID RATE':'10','OLD RATE':'12','NEW/STANDARD':'15'},spread:'5',refs:[{ref:'OD-1',url:'u',filename:'f',amount:'100'}]}]} -> row 'M1 \| R 10.00 \| R 12.00 \| R 15.00 \| R 5.00 \| chip OD-1 · R 100.00'
  - Export of that category -> 'category,severity,item,detail,spread,refs' then '<title>,high,M1,,5,OD-1'
  - severity 'critical' (unknown) -> INFO badge
- **Source defects:**
  - `S-contradictions_tab-1` (low) highCount and byCat are trusted from DATA rather than derived; a results version where they disagree with categories would render inconsistent KPIs Evidence: 2669 C.highCount; 2670-2671 C.byCat.rate/units
  - `S-contradictions_tab-2` (low) Export throws if any item lacks refs (it.refs.map without guard); render refChips(refs) also throws Evidence: 2697 it.refs.map(x=>x.ref); 2661 refs.map
  - `S-contradictions_tab-3` (low) Paragraph of case reasoning hard-coded in the renderer (<case narrative>) Evidence: 2693
- **Notes:** Spread and amounts are strings in DATA; money() strips non-numeric characters. 'NEW RATE' fallback key does not occur in v5 data.

## Risk Matrix (`risk_matrix_tab`)

Group Analysis. Owner CC-05. Live renderer line 2704. Static: 0 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2704-2709
- **Imported datasets:** DATA.riskMatrix[] (6) .issue, .likelihood, .impact, .mitigation (2706-2707)
- **User-work stores:** none
- **State:** none
- **Actions (0):**
- **Exports:** none
- **Derived values and rules:**
  - Columns Issue \| Likelihood \| Impact \| Mitigation in DATA order (2708)
  - Chip colour (2706-2707): value==='High' -> danger; ==='Medium' -> warn; anything else (incl. 'Low') -> ok. Exact case-sensitive compare.
- **Originals:** none (no document links)
- **Example candidates:**
  - Row {likelihood:'High',impact:'Low'} -> likelihood chip danger, impact chip ok; 'high' (lower-case) -> ok (source quirk)
- **Source defects:**
  - `S-risk_matrix_tab-1` (low) No export and no edit for a register-like view; case-sensitive colour mapping Evidence: 2706 r.likelihood==='High'?'b-dang':...
- **Notes:** Read-only.

## Defence & Rebuttal (`vdm_matrix_tab`)

Group Analysis. Owner CC-05. Live renderer line 2710. Static: 1 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 2710-2718
- **Imported datasets:** DATA.defenceMatrix[] (8) .point, .dcs, .evidence, .rebuttal, .docs[] (51 objects: ref,url,filename,doc_type,date) (2714-2715); DATA.defenceMatrix[].refs (string, non-empty in 2 rows) exists but is NOT read
- **User-work stores:** none
- **State:** none
- **Actions (2):**
  - button "Export CSV" → downloads all rows (`exportDefence 2719`)
  - link "document chip '<ref>'" → opens docs[].url in viewer (`refChips 2714`)
- **Exports:**
  - CSV `ess_dcs_defence_rebuttal.csv`: dcs_point,dcs_case,ess_evidence,documents,rebuttal (`exportDefence 2719-2721; documents = docs[].ref joined by single space`)
- **Derived values and rules:**
  - Columns: <respondent> point (bold) \| <respondent> case \| <claimant> supporting evidence \| Documents (refChips, or '—' tag when docs empty) \| <claimant> rebuttal (2713-2715)
  - docs objects have no amount, so chips show the ref only
- **Originals:** docs[].url embedded (51 refs, all resolve in chronology)
- **Example candidates:**
  - Row with docs:[] -> Documents cell '—'; export documents column ''
  - Row with docs [{ref:'OD-1'},{ref:'SD-2'}] -> export documents 'OD-1 SD-2'
- **Source defects:**
  - `S-vdm_matrix_tab-1` (medium) DATA.defenceMatrix[].refs free-text field (non-empty in 2 of 8 rows) is never displayed or exported Evidence: 2714-2715 only r.point,r.dcs,r.evidence,r.docs,r.rebuttal
  - `S-vdm_matrix_tab-2` (low) Column headings and subtitle hard-code the party abbreviations Evidence: 2711, 2713
- **Notes:** Footer tag says chips open the source in the viewer (2716).

## Info Required (`info_required_tab`)

Group Analysis. Owner CC-05. Live renderer line 2722. Static: 1 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2722-2728
- **Imported datasets:** DATA.infoRequired[] (6) .item, .status, .owner (2723, 2726)
- **User-work stores:**
  - `ess_dcs_info_done_v1` (read+write): object {"<array index>": true\|false}. Read on render with default {} (2723). Checkbox i reads done[i] (2726). toggleInfo(i,v) (2729) loads, sets d[i]=v (false is stored, not deleted), saves, then go('info_required_tab') re-renders. Keyed by array INDEX into DATA.infoRequired (verified: 2726 onchange="toggleInfo('+i+',this.checked)" and d[i]=v), not by item text or id.
- **State:** none in memory
- **Actions (1):**
  - checkbox "done (per item)" → persists done flag by index; re-renders; checked rows get strikethrough + tertiary colour on the Item cell (`toggleInfo(i,checked) 2729`)
- **Exports:** none
- **Derived values and rules:**
  - Status chip colour (2726): 'Outstanding' -> danger; 'In progress' -> warn; any other (v5 also has 'To verify', 'To locate/confirm', 'To request') -> info
  - The checkbox does not change the displayed Status; status always comes from DATA
- **Originals:** none
- **Example candidates:**
  - Store {} + 6 items -> no strikethrough; toggle index 2 -> store {"2":true} and only row 3 struck through; untoggle -> {"2":false}
- **Source defects:**
  - `S-info_required_tab-1` (medium) Index-keyed user work: reordering/inserting DATA.infoRequired in a later results version silently moves done flags to other items Evidence: 2726 done[i]; 2729 d[i]=v
  - `S-info_required_tab-2` (low) No export; done state not reflected in Status column Evidence: 2724-2727
- **Notes:** Full re-render through go() on each toggle resets scroll to top (295).

## Witnesses (`witness_tab`)

Group Analysis. Owner CC-05. Live renderer line 2730. Static: 0 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2730-2734
- **Imported datasets:** DATA.witnesses[] (3) .name, .role, .willsay (2732)
- **User-work stores:** none
- **State:** none
- **Actions (0):**
- **Exports:** none
- **Derived values and rules:**
  - Columns Witness (bold name) \| Role \| Will say, DATA order
- **Originals:** none
- **Example candidates:**
  - 3 witnesses -> 3 rows in DATA order
- **Notes:** Read-only. Witness names are personal data held in DATA, not code.

## Conflict Check (`conflict_tab`)

Group Analysis. Owner CC-08. Live renderer line 2735. Static: 2 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2735-2748
- **Imported datasets:** DATA.entities[] (22) .name, .role, .note (2737, 2752); DATA.people[] (42) .name, .email, .org (2738, 2751)
- **User-work stores:** none
- **State:** none; result only in DOM #confres, cleared on navigation
- **Actions (2):**
  - select "Pick a party / correspondent" → copies the value into the free-text box after stripping a trailing ' <email>' and runs the check; choosing the blank option clears results (`pickConflict(value) 2749`)
  - button "Check" → runs the match and renders results (`runConflict 2750`)
- **Form fields (1):**
  - input "…or type a name / firm / email" → id confq (`none (read by runConflict; no Enter handler)`)
- **Exports:** none
- **Derived values and rules:**
  - Party list source: DATA only (not hard-coded, not user-maintained). Options (2736-2738): first every DATA.entities e -> value e.name, label e.name+' — '+(e.role\|\|'entity'); then every DATA.people p -> value p.name+(p.email?' <'+p.email+'>':''), label p.name+(p.email?' · '+p.email:'')+(p.org?' ('+p.org+')':''). DATA order, no sort, no de-dup.
  - Matching (2750-2752): q = val('confq').trim().toLowerCase(); empty -> clear results. People first: hit if (p.name+' '+p.email+' '+p.org).toLowerCase().includes(q) -> row ['Correspondent', p.name+' ('+p.email+')', p.org]. Then entities: hit if (e.name+' '+e.role+' '+e.note).toLowerCase().includes(q) -> row ['Entity', e.name, e.role]. Case-insensitive plain substring; spans field boundaries because fields are space-joined; no tokenisation, fuzzy match or normalisation of punctuation.
  - Result (2753-2755): 0 hits -> ok badge 'No conflict match found for "<q lowercased>"'; else danger badge 'N potential match(es) — review before acting' + table Kind \| Match \| Detail
  - pickConflict regex /\s*<[^>]+>$/ removes the email so a person pick searches by name only
- **Originals:** none
- **Example candidates:**
  - Synthetic DATA people [{name:'Ann Lee',email:'ann@x.test',org:'Org A'}], entities [{name:'Org A Ltd',role:'supplier',note:''}]; q='org a' -> 2 hits: Correspondent 'Ann Lee (ann@x.test)' detail 'Org A', then Entity 'Org A Ltd' detail 'supplier'
  - q=' ANN ' -> trimmed/lowercased 'ann' -> 1 hit (Correspondent)
  - q='lee ann' -> 'ann lee ann@x.test org a' contains 'lee ann' -> 1 hit (cross-field match quirk)
  - q='zzz' -> 'No conflict match found for "zzz"'
- **Source defects:**
  - `S-conflict_tab-1` (medium) Input placeholder hard-codes a real company name and a real person's email address from the case (personal data in code) Evidence: 2744 placeholder="e.g. <company>, <person-email>"
  - `S-conflict_tab-2` (low) Substring over space-joined fields gives cross-field false positives; very short queries (e.g. 'a') match nearly everything Evidence: 2751 (p.name+' '+p.email+' '+p.org).toLowerCase().includes(q)
  - `S-conflict_tab-3` (low) Free-text box has no Enter-key handler; only the Check button or select change runs it Evidence: 2744-2745
  - `S-conflict_tab-4` (low) Match/haystack concatenate p.email and p.org unguarded (the select guards them): a person with an empty email shows 'name ()', and a missing field would print 'undefined' and be searchable as such. All 42 v5 people have email and org. Evidence: 2751 p.name+' '+p.email+' '+p.org and p.name+' ('+p.email+')' vs 2738 p.email?...:''
- **Notes:** Only matter-internal lists are screened; no external conflict register.

## Enforcement Roadmap (`enforcement_tab`)

Group Litigation strategy. Owner CC-08. Live renderer line 2872. Static: 1 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2872-2887
- **Imported datasets:** DATA.lit.enforcement[] (7) .phase, .step, .basis, .status, .note (2873-2882)
- **User-work stores:**
  - `ess_dcs_enf_status_v1` (read+write): object {"<array index>": one of ENF_OPTS}. Read on render default {} (2873). Displayed status cur = st[i]\|\|s.status (2879) where i is the GLOBAL index into DATA.lit.enforcement (forEach over all steps inside each phase loop). setEnf(i,v) (2888) loads, sets st[i]=v, saves; no re-render. Keyed by array index (verified 2881 onchange="setEnf('+i+',this.value)").
- **State:** ENF_OPTS const ['To do','In progress','Done','Contingent','Monitor'] (2871)
- **Actions (1):**
  - select "Status (per step)" → persists status for step index i (`setEnf(i,value) 2888`)
- **Exports:** none
- **Derived values and rules:**
  - Phases = [...new Set(steps.map(s=>s.phase))] in first-appearance order (2876); one card per phase; rows = steps with that phase in DATA order
  - Row: Step (bold) \| Legal basis \| Status select (ENF_OPTS, selected = cur) \| Note
  - v5 seed statuses: To do x4, Contingent x2, Monitor x1 — all within ENF_OPTS; 4 phases
- **Originals:** none
- **Example candidates:**
  - Store {} -> each select shows the DATA status; setEnf(3,'Done') -> store {"3":"Done"}; re-render shows 'Done' for step index 3 regardless of its phase grouping
- **Source defects:**
  - `S-enforcement_tab-1` (medium) Index-keyed user work: changing the order or count of DATA.lit.enforcement remaps saved statuses to different steps Evidence: 2879 st[i]\|\|s.status; 2888 st[i]=v
  - `S-enforcement_tab-2` (low) A seed status outside ENF_OPTS leaves no option selected, so the browser shows 'To do' while the stored/seed value differs Evidence: 2881 o===cur?' selected':''
  - `S-enforcement_tab-3` (low) Case-specific recovery narrative (<case narrative>) hard-coded in renderer Evidence: 2874-2875
- **Notes:** No export. Footer disclaimer (2885).

## Legality & SIU Risk (`legality_tab`)

Group Litigation strategy. Owner CC-08. Live renderer line 2891. Static: 0 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2891-2905
- **Imported datasets:** DATA.lit.legality.intro (2894); DATA.lit.legality.docs[] (8) .ref, .date, .title, .url (2895-2896); DATA.lit.legality.scenarios[] (3) .scenario, .effect, .prob, .action (2899); DATA.lit.legality.factors[] (4) .factor, .note (2902)
- **User-work stores:** none
- **State:** none
- **Actions (1):**
  - link "open ↗ (per doc)" → opens docs[].url in viewer (`docLink 2896`)
- **Exports:** none
- **Derived values and rules:**
  - Docs card header 'SIU / arbitration documents in the bundle (docs.length)'; row Ref \| date\|\|'—' \| cleanName(title) \| open
  - Scenario likelihood chip (2899): /base/i -> ok; else /material/i -> danger; else warn
- **Originals:** docs[].url via docLink (all 8 refs also resolve in chronology)
- **Example candidates:**
  - prob 'Base case' -> ok chip; 'Material risk' -> danger; 'Possible' -> warn
- **Source defects:**
  - `S-legality_tab-1` (low) Subtitle hard-codes case-specific text (<case narrative>) Evidence: 2893
- **Notes:** Read-only; no export.

## Prescription (`prescription_tab`)

Group Litigation strategy. Owner CC-06. Live renderer line 2909. Static: 5 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 2909-2921
- **Imported datasets:** DATA.lit.prescSummary.total, .reliesOnInterruption, .awardDate, .note (2910-2917); DATA.lit.prescription[] (306) .ref, .no, .date, .prescDate, .risk, .url (2922-2929)
- **User-work stores:** none
- **State:** PR={q:'',risk:'',page:1,size:80} module-level (2908); survives tab switches within the page session, lost on reload; NOT reflected back into the rendered filter controls (see defects)
- **Actions (6):**
  - button "Export CSV" → downloads all prescription rows (ignores filters) (`exportPresc 2929`)
  - input "Filter invoice / ref" → live filter (`oninput PR.q=value;PR.page=1;drawPresc() 2918`)
  - select "Any risk \| Relies on interruption \| Not yet due to prescribe" → exact risk filter (`onchange PR.risk=value;PR.page=1;drawPresc() 2919`)
  - button "Prev" → previous page (disabled on page 1) (`PR.page--;drawPresc() 2927`)
  - button "Next" → next page (disabled on last page) (`PR.page++;drawPresc() 2927`)
  - link "open ↗" → opens prescription[].url (`docLink 2926`)
- **Exports:**
  - CSV `ess_dcs_prescription.csv`: ref,no,date,prescDate,risk (`exportPresc 2929 (all DATA.lit.prescription rows, DATA order, url omitted)`)
- **Derived values and rules:**
  - prescDate and risk are PRECOMPUTED in DATA; the app does not compute them and has no clock dependence. Inferred build rule (checked over all 306 v5 rows, not stated in code): prescDate = invoice date + 3 calendar years (306/306 match); risk = 'Relies on interruption' iff prescDate < DATA.lit.interestBasis.headline_date (= DATA.lit.settlement.claimDate), else 'Not yet due to prescribe' (306/306 match; comparing to the award date or build date does not fit). Treat this rule as a build-time fact to reproduce in import, flagged UNCERTAIN as to the exact boundary (< vs <=; no row sits on the boundary).
  - KPIs (2914-2916): Invoices tracked = S.total; Rely on interruption = S.reliesOnInterruption (sub '3-yr window has closed'); Key interruption 'Award '+S.awardDate. v5: S.total == prescription.length and S.reliesOnInterruption == count(risk=='Relies on interruption') (269 of 306; 37 not yet due). S.awardDate == interestBasis.award_date.
  - Filter (2922): start from a copy of DATA order; if PR.q: keep rows where (r.no+' '+r.ref).toLowerCase().includes(PR.q.toLowerCase()) (q not trimmed); if PR.risk: keep r.risk===PR.risk. No sorting.
  - Pagination 80 per page via paginate (page clamped and written back to PR.page, 2923)
  - Row: Ref \| Invoice no \| Invoice date \| Prescribes (3yr) = prescDate \| risk chip ('Relies on interruption' -> warn, else ok) \| open (2925-2926)
- **Originals:** prescription[].url via docLink (identical to the chronology row url for all 306 rows)
- **Example candidates:**
  - Synthetic rows [{ref:'OD-1',no:'INV10',risk:'Relies on interruption'},{ref:'SD-2',no:'INV20',risk:'Not yet due to prescribe'}]: q='inv1' -> only OD-1; risk='Not yet due to prescribe' -> only SD-2; q='od-1 ' (trailing space) -> 0 rows only if no row's 'no ref' contains it — 'INV10 OD-1' does not contain 'od-1 ' so 0 rows
  - 200 rows unfiltered -> 'Page 1 / 3', 'Showing 1–80 of 200'; Next twice -> 'Showing 161–200 of 200'
  - Build rule (synthetic dates): invoice date 2001-02-03 -> prescDate 2004-02-03; with headline date 2005-06-07 -> 'Relies on interruption'
- **Source defects:**
  - `S-prescription_tab-1` (medium) Stale filter state: PR persists across navigation but the re-rendered input (no value attribute) and select (selected '') show empty, so the table is silently filtered by the old PR.q/PR.risk Evidence: 2908 const PR={...}; 2918 '<input ... placeholder="Filter invoice / ref" oninput=...' (no value=PR.q); 2919 selEl('prrisk',[...],'',...)
  - `S-prescription_tab-2` (medium) Risk classification is frozen at build time relative to the headline/claim date, not today; 'Not yet due to prescribe' rows become wrong as time passes and the UI gives no as-at date for the classification Evidence: 2925-2926 renders r.prescDate/r.risk verbatim; no Date use
  - `S-prescription_tab-3` (low) Export ignores the active filters and drops url Evidence: 2929 DATA.lit.prescription.map(...) head ['ref','no','date','prescDate','risk']
  - `S-prescription_tab-4` (low) Leap-day invoices: the 3-year rule for 29 Feb is unspecified in the app (precomputed); no v5 row exercises it Evidence: data-derived; no code
- **Notes:** Subtitle 'Three-year extinctive prescription per invoice' (2911). S.note is DATA narrative (2917).

## Interest Recalculator (`interest_calc_tab`)

Group Litigation strategy. Owner CC-06. Live renderer line 2932. Static: 2 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2932-2945
- **Imported datasets:** DATA.lit.interestBasis.note (2935); DATA.lit.interestBasis.first_invoice_date \|\| .award_date -> default From (2940); DATA.lit.interestBasis.headline_date -> default To (2941); DATA.lit.interestBasis.headline_due -> comparison figure (2952)
- **User-work stores:** none
- **State:** none; inputs reset to defaults on every render; output only after Compute
- **Actions (1):**
  - button "Compute" → renders 4 KPIs + caution note into #ic_out (`calcInterest 2946`)
- **Form fields (5):**
  - input "Capital outstanding (R)" → id ic_p, default empty, placeholder 'e.g. from latest statement' (`none (read by calcInterest)`)
  - input "Rate (% per annum)" → id ic_r, default <const:ic_r_default> hard-coded at line 2938 (not from DATA) (`none`)
  - select "Method Simple \| Compound (monthly)" → id ic_m default 'Simple' (`none (selEl onchange '')`)
  - input "From (mora) date" → id ic_from default first_invoice_date\|\|award_date (`none`)
  - input "To date" → id ic_to default headline_date (`none`)
- **Exports:** none
- **Derived values and rules:**
  - P = parseFloat(ic_p)\|\|0; r = parseFloat(ic_r)\|\|0; m = ic_m value (2946). parseFloat stops at the first non-numeric char, so '1 000 000' -> 1 and 'R 5000' -> 0.
  - from = new Date(ic_from+'T00:00:00'), to = new Date(ic_to+'T00:00:00') — local time (2947); days = (to-from)/86400000 (not rounded; fractional across DST shifts in DST time zones); years = days/365.25 (2948). Actual/365.25 day count; both ends: difference only (from-date excluded, to-date included).
  - Compound if m contains 'Compound' (2950): months = years*12 (fractional); total = P*(1+r/100/12)^months; interest = total-P. Monthly compounding with fractional final period exponent.
  - Else Simple (2951): interest = P*(r/100)*years; total = P+interest.
  - head = parseFloat(DATA.lit.interestBasis.headline_due)\|\|0; diff = total-head (2952). headline_due is a plain decimal string in v5 (parses fully).
  - Output (2953-2957): Capital fmtR(P); 'Interest (' + (years>0 ? years.toFixed(2) : '0') + ' yrs)' fmtR(interest); Total fmtR(total); 'vs extracted Amount Due' fmtR(head) with sub-line: P truthy -> (diff>=0?'+':'') + fmtR(diff) + ' vs your calc', else 'enter a capital figure'. fmtR rounds via toFixed(2) for display only; no intermediate rounding.
  - Invalid/empty date -> NaN -> interest/total display '' (fmtR NaN) and '0 yrs'. Negative period -> negative simple interest / total<P compound, label '0 yrs'.
  - No clock dependence (no new Date() without argument).
- **Originals:** none
- **Example candidates:**
  - P=100000, r=10, Simple, from 2004-02-03 to 2005-02-03: days=366, years=366/365.25=1.0020533881 -> label 'Interest (1.00 yrs)', interest R 10 020.53, total R 110 020.53
  - Same inputs, Compound (monthly): months=12.0246406571, total=100000*(1+0.1/12)^12.0246406571 = 110493.8991 -> interest R 10 493.90, total R 110 493.90
  - P=100000, r=10.5, Simple, 2004-02-03 to 2007-02-03: days=1096, years=3.0006844627 -> 'Interest (3.00 yrs)' R 31 507.19, total R 131 507.19; Compound -> interest R 36 848.11, total R 136 848.11
  - P empty -> P=0, sub-line 'enter a capital figure', capital 'R 0.00'
  - P='1 000' -> P=1 (source quirk)
- **Source defects:**
  - `S-interest_calc_tab-1` (medium) Capital parsed with parseFloat: values typed with the app's own thousands separator (space) or 'R' prefix parse as 1 or 0 Evidence: 2946 parseFloat(val('ic_p'))\|\|0
  - `S-interest_calc_tab-2` (medium) Default rate is a hard-coded constant in the renderer, not from DATA.lit.interestBasis; the caution text itself says to replace it with the award/contract rate Evidence: 2938 id="ic_r" value="<const:ic_r_default>"; 2958
  - `S-interest_calc_tab-3` (low) 'yrs' label shows '0' for negative or invalid periods while interest is still computed (negative) or blank Evidence: 2955 (years>0?years.toFixed(2):'0')
  - `S-interest_calc_tab-4` (low) Day count uses local-time Date subtraction; in time zones with DST the day count is fractional Evidence: 2947-2948
  - `S-interest_calc_tab-5` (low) 'vs extracted Amount Due' compares the computed total (capital+interest on one capital figure) with the headline amount due; same-basis comparison is not guaranteed Evidence: 2952 diff=total-head
- **Notes:** No persistence of inputs or results. From default prefers first_invoice_date (== earliest prescription invoice date in v5) over award_date.

## Payments & Net Claim (`payments_tab`)

Group Litigation strategy. Owner CC-06. Live renderer line 2962. Static: 3 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 2962-2983
- **Imported datasets:** DATA.lit.settlement.claim (gross, 2963) and .claimDate (2968); DATA.lit.recon[] (135) .month, .invoice[], .supporting[], .charging[], .pod[], .statement[], .amountdue[] (string ref arrays; pod empty in all v5 rows) (2978-2980); allRows() (includes rescan store) via refLink for every recon ref
- **User-work stores:**
  - `ess_dcs_payments_v1` (read+write): [{date,amount,method,note}] all strings as typed. Read on render (2963) and drawPay (2984) default []. addPay (2988): if amount==='' no-op; else push and save, then go('payments_tab') full re-render. delPay(i) (2989) splice by array index, no confirm, re-render. No seed.
- **State:** none in memory
- **Actions (4):**
  - button "Export payments" → downloads stored payments (`ledgerCSVp 2990`)
  - button "Add" → appends payment when Amount non-empty (any text accepted) (`addPay 2988`)
  - button "Delete (per payment)" → removes payment at index i (`delPay(i) 2989`)
  - link "recon ref links" → each ref resolves via allRows().find -> docLink(url, ref); unresolved -> plain text (`refLinks 2980`)
- **Form fields (1):**
  - input "Date(date) / Amount (R) / Method-reference / Note" → ids pay_date, pay_amount, pay_method, pay_note (`none (read by addPay)`)
- **Exports:**
  - CSV `ess_dcs_payments.csv`: date,amount,method,note (`ledgerCSVp 2990 (raw stored strings, insertion order)`)
- **Derived values and rules:**
  - claim = parseFloat(DATA.lit.settlement.claim)\|\|0 (2963). Claim source is DATA.lit.settlement.claim (equal to interestBasis.headline_due in v5; plain decimal string).
  - paid = Σ (parseFloat(p.amount)\|\|0) over ess_dcs_payments_v1 (2964); net = claim - paid (2964). No rounding except fmtR display. Payments not filtered by date; no interest on payments.
  - KPIs (2968-2970): Gross amount due fmtR(claim) 'as at '+claimDate; Payments recorded fmtR(paid) + '<n> receipts' (n = pays.length, includes rows that parse to 0); Net claim fmtR(net)
  - Payments table (2984-2987): Date\|\|'—' \| money(amount) \| method \| note \| Delete; empty -> 'No payments recorded — the claim is currently gross.'
  - Recon chain (2978-2980): header 'Monthly reconciliation chain (<recon.length> months) — invoice → statement → charging → proof of delivery → amount due'; columns Month \| Invoice \| Supporting stmt \| Charging \| POD \| Statement \| Amount due, each = refLinks(array). DATA order; v5 recon refs: 561, all resolvable.
- **Originals:** recon arrays are bare ref strings resolved through allRows().find(x=>x.ref===ref) (2867); unresolved refs print as text
- **Example candidates:**
  - DATA claim '1000.00', payments [{amount:'100'},{amount:'250.50'}] -> Gross R 1 000.00, Payments R 350.50 '2 receipts', Net R 649.50
  - No payments -> Payments R 0.00 '0 receipts', Net = gross
  - Payment amount '1 000' -> table shows R 1 000.00 (money strips space) but paid adds 1 -> Net = claim-1 (source defect)
  - Add with empty Amount -> nothing stored
- **Source defects:**
  - `S-payments_tab-1` (high) Net claim and table disagree for amounts with separators or currency text: KPI sum uses parseFloat (stops at first space/comma, 'R 500' -> 0) while the table uses money() (strips non-digits). Net claim is therefore wrong while the list looks right Evidence: 2964 a+(parseFloat(p.amount)\|\|0) vs 2986 money(p.amount)
  - `S-payments_tab-2` (medium) Non-numeric amounts are accepted and counted as receipts Evidence: 2988 if(!row.amount)return;
  - `S-payments_tab-3` (low) Settlement/BATNA and Interest views ignore recorded payments (use gross DATA figures) Evidence: 3061 parseFloat(DATA.lit.settlement.claim); 2952 headline_due
  - `S-payments_tab-4` (low) POD column is always empty in v5 data (recon[].pod has 0 items) Evidence: 2980 refLinks(m.pod)
  - `S-payments_tab-5` (low) Subtitle hard-codes the <respondent> abbreviation Evidence: 2965
- **Notes:** Payments are not sorted by date. Delete is index-based on the current stored order.

## Cause of Action (`elements_tab`)

Group Litigation strategy. Owner CC-08. Live renderer line 2993. Static: 0 handler sites, 1 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2993-2998
- **Imported datasets:** DATA.lit.elements[] (6) .element, .must, .evidence, .witness, .tab (2996)
- **User-work stores:** none
- **State:** none
- **Actions (1):**
  - link "open →" → navigates to the view named in DATA (v5 targets: contracts_tab, documents, invoice_ledger_tab, quantum_tab, interest_calc_tab, filings_tab — all valid nav ids) (`delegated click on [data-tab] 297 -> go(e.tab)`)
- **Exports:** none
- **Derived values and rules:**
  - Columns Element (bold) \| What <claimant> must prove \| Evidence \| Witness \| Go to, DATA order
  - Evidence is free text; refs inside it are not linked
- **Originals:** none directly; evidence text holds unlinked free-text refs
- **Example candidates:**
  - Element with tab 'filings_tab' -> clicking 'open →' renders Filings & Affidavits and sets crumb; an unknown tab id -> renderMissing 'Unknown tab.'
- **Source defects:**
  - `S-elements_tab-1` (low) Navigation target ids come from DATA without validation (unknown id -> 'Not found' page) Evidence: 2996 data-tab="'+esc(e.tab)+'"; 296 RENDER[tab]\|\|renderMissing
- **Notes:** Read-only.

## Authorities (`authorities_tab`)

Group Litigation strategy. Owner CC-08. Live renderer line 3001. Static: 2 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 3001-3012
- **Imported datasets:** DATA.lit.authorities[] (11) .topic, .authority, .proposition (3002)
- **User-work stores:**
  - `ess_dcs_authorities_v1` (read+write): [{topic,authority,proposition}]. Read on render default [] and appended after the DATA seed: all = seed.concat(extra) (3002). addAuth (3013): if authority==='' no-op; else push, save, go('authorities_tab'). Seed is NOT copied into storage. No delete or edit of user rows.
- **State:** none
- **Actions (2):**
  - button "Export CSV" → downloads seed + user rows (`exportAuth 3014`)
  - button "Add" → appends a user authority when Authority non-empty; re-render clears inputs (`addAuth 3013`)
- **Form fields (1):**
  - input "Topic / Authority / Proposition" → ids au_topic, au_auth, au_prop (`none (read by addAuth)`)
- **Exports:**
  - CSV `ess_dcs_authorities.csv`: topic,authority,proposition (`exportAuth 3014 (DATA rows first, then user rows)`)
- **Derived values and rules:**
  - Table Topic (bold) \| Authority \| Proposition; DATA rows then user rows in insertion order (3008-3009)
- **Originals:** none (authorities not linked)
- **Example candidates:**
  - 11 seed rows + add {topic:'T',authority:'A',proposition:'P'} -> 12 rows, last 'T\|A\|P'; store [{topic:'T',authority:'A',proposition:'P'}]; export has 13 lines (header + 12)
  - Add with Authority empty -> no change
- **Source defects:**
  - `S-authorities_tab-1` (low) User-added authorities cannot be deleted or edited Evidence: 3001-3014 no delete handler
- **Notes:** Footer disclaimer (3010).

## Heads of Argument (`heads_tab`)

Group Litigation strategy. Owner CC-08. Live renderer line 3017. Static: 3 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 3017-3028
- **Imported datasets:** allRows() (includes rescan store) via refLink for evidence refs (3031)
- **User-work stores:**
  - `ess_dcs_heads_v1` (read+write): [{head,sub,auth,ref}]. No seed. Read on render (3018, unused var) and in drawHeads. addHead (3034): if both head and sub empty -> no-op; else push, save, clear 4 inputs, redraw. delHead(i) (3035) splice by index, no confirm.
- **State:** none
- **Actions (4):**
  - button "Export" → downloads a plain-text skeleton (`exportHeads 3036`)
  - button "Add" → appends a submission (`addHead 3034`)
  - button "Delete (per row)" → removes row i (`delHead(i) 3035`)
  - link "evidence ref" → opens the referenced document if the ref resolves (`refLink 3031`)
- **Form fields (1):**
  - input "Heading / Submission / Authority / Evidence ref(s)" → ids hd_head, hd_sub, hd_auth, hd_ref (placeholder 'e.g. OD-596, SD-352') (`none (read by addHead)`)
- **Exports:**
  - TXT `ess_dcs_heads_of_argument.txt`: n/a — text: 'HEADS OF ARGUMENT — <claimant> v <respondent>\n\n' then per row i: (i+1)+'. '+(head\|\|'')+'\n '+(sub\|\|'')+'\n Authority: '+(auth\|\|'')+'\n Evidence: '+(ref\|\|'')+'\n\n' (`exportHeads 3036 (text/plain)`)
- **Derived values and rules:**
  - Row: # (i+1) \| Heading (bold) \| Submission \| Authority \| Evidence = (ref\|\|'').split(/[ ,]+/).filter(Boolean).map(refLink).join(' ') \| Delete (3031-3032)
  - Empty -> 'No submissions yet — build your skeleton argument here.'
- **Originals:** evidence refs typed by the user resolved via allRows().find(x=>x.ref===ref); unresolved shown as escaped text
- **Example candidates:**
  - Row {head:'H',sub:'S',auth:'A',ref:'OD-1, XX-9'} with OD-1 in chronology -> Evidence: link 'OD-1' + text 'XX-9'; export text '...\n\n1. H\n S\n Authority: A\n Evidence: OD-1, XX-9\n\n'
  - Ref 'OD-1;SD-2' is one token (semicolon not a separator) -> unresolved text
- **Source defects:**
  - `S-heads_tab-1` (low) Export header hard-codes the case caption '<claimant> v <respondent>' Evidence: 3036 'HEADS OF ARGUMENT — <claimant> v <respondent>\n\n'
  - `S-heads_tab-2` (low) Ref splitting only on spaces/commas; semicolons or newlines leave refs unresolved Evidence: 3031 split(/[ ,]+/)
  - `S-heads_tab-3` (low) No reorder/edit of submissions; delete is index-based without confirm Evidence: 3032, 3035
- **Notes:** Variable hs at 3018 is loaded but unused in the render function.

## Cross-Exam Prep (`crossexam_tab`)

Group Litigation strategy. Owner CC-08. Live renderer line 3039. Static: 3 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 3039-3051
- **Imported datasets:** DATA.lit.crossexam_seed[] (4) .witness, .topic, .put, .docs (seed only, 3040)
- **User-work stores:**
  - `ess_dcs_crossexam_v1` (read+write): [{witness,topic,put,docs}] (docs is free text). Render (3040): load(key,null); if null, copies DATA.lit.crossexam_seed.slice() (shallow) into storage and saves — first visit writes user storage; seed never consulted again; [] is not reseeded. drawCx (3052) reads with default []. addCx (3056): if witness and topic both empty -> no-op; else push, save, clear inputs, redraw. delCx(i) (3057) splice by index, no confirm.
- **State:** none
- **Actions (3):**
  - button "Add (page header, primary)" → same as form Add (`addCx 3041`)
  - button "Add (form)" → appends a topic (`addCx 3047`)
  - button "Delete (per row)" → removes row i (`delCx(i) 3057`)
- **Form fields (1):**
  - input "Witness / Topic / What to put / Documents" → ids cx_w, cx_t, cx_put, cx_docs (`none (read by addCx)`)
- **Exports:** none
- **Derived values and rules:**
  - Table Witness (bold) \| Topic \| What to put \| Documents (plain escaped text) \| Delete (3054)
  - Empty -> 'No cross-exam topics yet.'
- **Originals:** Documents column is unlinked free text (seed and user rows); no ref resolution
- **Example candidates:**
  - Fresh storage -> after render ess_dcs_crossexam_v1 holds the 4 seed rows; add {witness:'W',topic:''} -> 5 rows
  - Add with witness and topic empty (put filled) -> no change
- **Source defects:**
  - `S-crossexam_tab-1` (medium) Seed-copy store: crossexam_seed copied into user storage on first render; later seeds never shown Evidence: 3040 if(store===null){store=DATA.lit.crossexam_seed.slice();save('ess_dcs_crossexam_v1',store);}
  - `S-crossexam_tab-2` (low) No export for this register; document references are not linked Evidence: 3041-3055
  - `S-crossexam_tab-3` (low) Duplicate Add buttons (header and form) with the same handler Evidence: 3041, 3047
- **Notes:** Tip text points to the Contradiction Tracker (3049).

## Settlement / BATNA (`settlement_tab`)

Group Litigation strategy. Owner CC-06. Live renderer line 3060. Static: 1 handler sites, 0 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 3060-3073
- **Imported datasets:** DATA.lit.settlement.claim -> claim prefill (3061, 3065)
- **User-work stores:** none
- **State:** none; inputs reset to defaults on each render
- **Actions (1):**
  - button "Model" → recomputes the three scenarios (`calcSettle 3074`)
- **Form fields (5):**
  - input "Claim value (R)" → id se_claim default (parseFloat(DATA.lit.settlement.claim)\|\|0).toFixed(0) — rounded to whole rand, no separators (`none (read by calcSettle)`)
  - input "Probability of full recovery (%)" → id se_p default <const:se_p_default> (3066) (`none`)
  - input "Years to recover" → id se_y default <const:se_y_default> (3067) (`none`)
  - input "Discount rate (% p.a.)" → id se_d default <const:se_d_default> (3068) (`none`)
  - input "Enforcement cost (R)" → id se_c default <const:se_c_default> (3069, an amount) (`none`)
- **Exports:** none
- **Derived values and rules:**
  - calcSettle runs automatically once on render (3072) with the defaults, and again on Model.
  - Inputs (3074): claim, p, y, d, c = parseFloat(field)\|\|0 each.
  - ev(prob) = claim*prob/100 / (1+d/100)^y - c (3075). Cost c is NOT discounted; annual discounting with fractional y allowed.
  - base = ev(p); opt = ev(min(100, p+15)); pess = ev(max(0, p-25)) (3076). Labels fixed: 'Pessimistic (p-25)', 'Base (p=<p>%)', 'Optimistic (p+15)' even when clamped.
  - Output (3077-3081): three KPIs fmtR; settlement-floor sentence = base, with claim fmtR, p, y, d echoed raw and costs fmtR(c). Display rounding only (toFixed(2)). Values may be negative ('-R ...').
  - Uses gross claim; ignores ess_dcs_payments_v1. No clock dependence.
- **Originals:** none
- **Example candidates:**
  - claim=1000000, p=70, y=2, d=10, c=100000 -> base 700000/1.21-100000 = R 478 512.40; optimistic (p=85) R 602 479.34; pessimistic (p=45) R 271 900.83
  - p=95 -> optimistic uses 100: 1000000/1.21-100000 = R 726 446.28 (label still 'p+15')
  - p=10, c=100000 -> pessimistic uses 0 -> -R 100 000.00
  - y=0, d=10, p=50, c=0 -> base R 500 000.00
- **Source defects:**
  - `S-settlement_tab-1` (low) Enforcement cost default and the probability/years/discount defaults are hard-coded in renderer (cost is a case-scale amount) Evidence: 3066-3069 value="<const:...>"
  - `S-settlement_tab-2` (medium) Gross claim used; recorded payments (Payments & Net Claim) not deducted Evidence: 3061 parseFloat(DATA.lit.settlement.claim)
  - `S-settlement_tab-3` (low) Claim prefill toFixed(0) silently drops cents; user-typed separators break parseFloat Evidence: 3065 claim.toFixed(0); 3074 parseFloat(val('se_claim'))
  - `S-settlement_tab-4` (low) Scenario labels do not reflect clamping; costs undiscounted while recovery is discounted Evidence: 3076-3080
  - `S-settlement_tab-5` (low) Case narrative hard-coded in the renderer (<case narrative>) Evidence: 3063
- **Notes:** Illustrative-model disclaimer (3082).

## Privilege Log (`privilege_tab`)

Group Registers. Owner CC-07. Live renderer line 622. Static: 4 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 622-623 via ledgerTab 588-615; single definition
- **Imported datasets:** cfg only. Doc ref is free text; it is not resolved or linked to the chronology.
- **User-work stores:**
  - `ess_dcs_privilege_v1` (read+write): [{ref,date,desc,basis}] basis in ''\|'Legal advice'\|'Litigation'\|'Without prejudice'\|'Other'. Generic ledger; no seed; keyed by index; the ref field is a user-typed ref code (join key into chronology refs, but unvalidated).
- **State:** Form inputs in_ess_dcs_privilege_v1_<k>.
- **Actions (3):**
  - button "Add" → generic (`ledgerAdd 610`)
  - button "Delete (per row)" → generic (`ledgerDel 613`)
  - button "Export CSV" → download (`ledgerCSV 614`)
- **Form fields (4):**
  - input text "Doc ref" → ref (`ledgerAdd`)
  - input date "Date" → date (`ledgerAdd`)
  - input text "Description" → desc (`ledgerAdd`)
  - select "Privilege basis" → basis (`ledgerAdd`)
- **Exports:**
  - CSV `ess_dcs_privilege_v1.csv`: ref,date,desc,basis (`ledgerCSV 614`)
- **Derived values and rules:**
  - Title 'Privilege Log', sub 'Documents withheld / redacted for privilege', empty 'No privilege entries.'; all cells esc(v\|\|''); insertion order.
- **Originals:** None (ref is not linked).
- **Example candidates:**
  - Add {ref:'OD-001', basis:'Litigation'} -> one row; CSV 'ref,date,desc,basis' then 'OD-001,,,Litigation'
- **Source defects:**
  - `S-privilege_tab-1` (low) Doc ref is not validated against or linked to the chronology. Evidence: 623 {k:'ref',label:'Doc ref'}
- **Notes:** Generic ledger semantics as under disbursements_tab.

## POPIA Register (`popia_tab`)

Group Registers. Owner CC-07. Live renderer line 624. Static: 4 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 624-625 via ledgerTab 588-615; single definition
- **Imported datasets:** cfg only.
- **User-work stores:**
  - `ess_dcs_popia_v1` (read+write): [{activity,category,lawful,retention}]. Generic ledger; no seed; keyed by index.
- **State:** Form inputs in_ess_dcs_popia_v1_<k>.
- **Actions (3):**
  - button "Add" → generic (`ledgerAdd 610`)
  - button "Delete (per row)" → generic (`ledgerDel 613`)
  - button "Export CSV" → download (`ledgerCSV 614`)
- **Form fields (4):**
  - input text "Processing activity" → activity (`ledgerAdd`)
  - input text "Data category" → category (`ledgerAdd`)
  - input text "Lawful basis" → lawful (`ledgerAdd`)
  - input text "Retention" → retention (`ledgerAdd`)
- **Exports:**
  - CSV `ess_dcs_popia_v1.csv`: activity,category,lawful,retention (`ledgerCSV 614`)
- **Derived values and rules:**
  - Title 'POPIA Data-Processing Register' (NAV label 'POPIA Register'), sub 'Records of personal-information processing in the matter', empty 'No POPIA records.'
- **Originals:** None.
- **Example candidates:**
  - Add one row with only Retention filled -> row saved with other fields ''
- **Notes:** Generic ledger semantics as under disbursements_tab.

## Annotations (`annotations_tab`)

Group Registers. Owner CC-07. Live renderer line 626. Static: 4 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 626-627 via ledgerTab 588-615; single definition
- **Imported datasets:** cfg only. Doc ref is free text, not linked.
- **User-work stores:**
  - `ess_dcs_annotations_v1` (read+write): [{ref,date,note}] (note from a textarea, may contain newlines). Generic ledger; no seed; keyed by index; ref is an unvalidated join key to chronology refs.
- **State:** Form inputs in_ess_dcs_annotations_v1_<k>.
- **Actions (3):**
  - button "Add" → generic (`ledgerAdd 610`)
  - button "Delete (per row)" → generic (`ledgerDel 613`)
  - button "Export CSV" → download (`ledgerCSV 614`)
- **Form fields (3):**
  - input text "Doc ref" → ref (`ledgerAdd`)
  - input date "Date" → date (`ledgerAdd`)
  - textarea "Note" → note (`ledgerAdd`)
- **Exports:**
  - CSV `ess_dcs_annotations_v1.csv`: ref,date,note (multi-line notes quoted) (`ledgerCSV 614`)
- **Derived values and rules:**
  - Title 'Counsel Annotations' (NAV 'Annotations'), sub 'Private notes (saved in this browser)', empty 'No annotations yet.'; newlines in notes collapse in the HTML table (no white-space:pre).
- **Originals:** None (ref not linked).
- **Example candidates:**
  - Note containing a newline exports as a quoted CSV cell
- **Source defects:**
  - `S-annotations_tab-1` (low) Annotations are not shown alongside the referenced document anywhere in group-A views; the ref is not validated. Evidence: 627
- **Notes:** Generic ledger semantics as under disbursements_tab.

## Transcripts (`transcriptions_tab`)

Group Registers. Owner CC-07. Live renderer line 628. Static: 4 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 628-629 via ledgerTab 588-615; single definition
- **Imported datasets:** cfg only.
- **User-work stores:**
  - `ess_dcs_transcripts_v1` (read+write): [{title,date,source,body}] (body from textarea). Generic ledger; no seed; keyed by index. Note key name 'transcripts' differs from the tab id 'transcriptions_tab'.
- **State:** Form inputs in_ess_dcs_transcripts_v1_<k>.
- **Actions (3):**
  - button "Add" → generic (`ledgerAdd 610`)
  - button "Delete (per row)" → generic (`ledgerDel 613`)
  - button "Export CSV" → download (`ledgerCSV 614`)
- **Form fields (4):**
  - input text "Title" → title (`ledgerAdd`)
  - input date "Date" → date (`ledgerAdd`)
  - input text "Source" → source (`ledgerAdd`)
  - textarea "Transcript text" → body (`ledgerAdd`)
- **Exports:**
  - CSV `ess_dcs_transcripts_v1.csv`: title,date,source,body (`ledgerCSV 614`)
- **Derived values and rules:**
  - Title 'Transcripts', sub 'Transcript store (hearings, recordings)', empty 'No transcripts stored.'; full body rendered in the table cell (no truncation).
- **Originals:** None.
- **Example candidates:**
  - Add a transcript with only Title -> row saved; CSV 'title,date,source,body' + 'x,,,'
- **Source defects:**
  - `S-transcriptions_tab-1` (low) Large transcript bodies are stored in localStorage (quota ~5 MB) and rendered whole; save() failure only alerts. Evidence: 189, 605
- **Notes:** Generic ledger semantics as under disbursements_tab.

## Rescan & Update (`rescan_tab`)

Group System. Owner CC-10. Live renderer line 2778. Static: 4 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 2778-2792 (single definition); handlers 2793-2826
- **Imported datasets:** DATA.chronology[].url (via allRows) and .bundle (bundle counts for sequence numbers); META.builtAt / META.docCount via freshnessStamp
- **User-work stores:**
  - `ess_dcs_rescan_v1` (read+write): array of chronology-shaped rows {n:'R<seq>', ref:'<OD\|SD\|EM\|PN>-<seq>', date:'YYYY-MM-DD'\|'', filename, subject:'', sender:'', to:'', cc:'', excerpt:'', doc_type:'email'\|'invoice'\|'other', bundle, amount:'', also_in:[], text_status:'pending'\|'extracted', url:'../'+encoded rel path, refs:[], _new:true}. read by allRows (merged into every chronology-based view), rescanRows, freshness stamp; appended by rescanNow (save at 2814); cleared to [] by rescanClear (confirm). In STORE_KEYS.
- **State:** DIRH (2793): FileSystemDirectoryHandle from window.showDirectoryPicker(); module-level, survives navigation, lost on reload (permission not persisted); Feature detection: supported = 'showDirectoryPicker' in window (2779); Connect and Rescan buttons disabled otherwise; warning card shown; Write index uses showSaveFilePicker when available (2825)
- **Actions (5):**
  - button "Connect case folder" → directory picker; show 'Connected: <folder name>'; errors (cancel) swallowed (`rescanConnect 2794`)
  - button "Rescan now" → connect if needed, walk folder recursively, classify new files, append rows to rescan store, update status, stamp and table (`rescanNow 2795`)
  - button "Write updated index to file" → save the rescan store (not the full index) as JSON via save-file picker, else download (`rescanWriteIndex 2824`)
  - button "Clear rescan additions" → confirm, store [] , refresh stamp, re-render (`rescanClear 2823`)
  - link "open (rescan row)" → open '../'-relative URL (modal for IFRAME_EXT, else new tab) (`docLink 2821`)
- **Exports:**
  - JSON `ess_dcs_rescan_v1.json`: JSON.stringify(rescan store array, null, 2) (`rescanWriteIndex 2824-2826 (showSaveFilePicker with suggestedName, alert 'Index written.' on success; if the API is missing OR the picker throws (including user cancel) it falls back to dl(..., application/json))`)
- **Derived values and rules:**
  - (1) PREFIX BUG, verified statically: seen-map key = decodeURIComponent(r.url.replace(/^\.\.\//,'')) for every allRows() row (2797); walked files are keyed by rel = 'dir/sub/file' with NO prefix (2798). Every embedded URL starts with './' (grep of the v5 data lines: 6,420 '"url":"./' in DATA plus 1,101 '"url": "./' in __SCHED__; 0 with '../'), so '../' is never stripped and seen keys look like './dir/file' - they can never equal rel. Result: every file under the chosen folder that is not already in the rescan store is classified NEW (the first rescan re-adds the whole corpus, ~1,689+ files plus the app's own files, as duplicates with new refs). Only rows previously written by rescan (url '../'+rel) match, via storePaths (2802), so a second rescan adds nothing further
  - New-vs-seen rule (2803): skip if seen[rel] or storePaths[rel]; otherwise new. The 'changed' array (2802) is never filled; size and lastModified are collected (2799) but never compared, contrary to the on-page text 'relative path + size + modified date' (2787)
  - Walk (2798-2799): recursive dir.entries(); directories recurse; files -> getFile() -> {rel,size,mod}; per-file errors swallowed; walk error -> 'Scan failed: <message>' badge
  - bundleOf (2801): top-level path segment upper-cased; includes 'ORIGINAL' -> Original; 'SUPPLEMENTRY' or 'SUPPLEMENTARY' -> Supplementary; 'CORRESPOND' -> Correspondence; 'PLEADING' -> Pleadings; otherwise Original (files at the root use the file name itself)
  - Sequence (2804-2805): prefixCount initialised per bundle from allRows() counts (Original/Supplementary/Correspondence/Pleadings only); each new file increments its bundle's counter: seq = count+1; ref = refCode(bundle, seq) (no zero padding), n = 'R'+seq
  - Date (2807-2808): first match of `(20YY)[._-](M)[._-](D)` -> 'YYYY-MM-DD' (zero-padded), else `(D)[._-](M)[._-](20YY)` -> 'YYYY-MM-DD'; no range validation; else ''
  - doc_type (2810): ext eml/msg -> 'email'; else filename matching /<invoice-prefix>\d{4,6}/i (case-specific prefix hard-coded) -> 'invoice'; else 'other'
  - text_status (2811): msg -> 'pending'; pdf -> 'pending'; everything else (incl. eml, docx, images) -> 'extracted' although nothing is extracted
  - url (2812): '../' + rel segments each encodeURIComponent'd joined by '/'
  - Status line (2815-2816): 'New: <isNew>' 'Already indexed: <found-isNew>' 'Total scanned: <found>' plus '<added> rows added with best-effort metadata; <pending count in store> flagged "needs deep extraction".'
  - Rescan table columns Ref, Date, Filename, Type, Bundle, Status, Doc
- **Originals:** window.showDirectoryPicker() folder handle (read-only walk; Chrome/Edge only); Stored rescan URLs are '../'-relative (assume the app sits one folder below the scanned root), whereas embedded URLs are './'-relative (app at the root). If the user picks the folder containing the app, rescan links point one level too high; Links rendered with docLink
- **Example candidates:**
  - Given an embedded row url './A%20B/x.pdf' and a walked file 'A B/x.pdf', v5 classifies the file as NEW (key mismatch). A correct reimplementation should classify it as already indexed - the checklist must state which behaviour is expected
  - bundleOf('<case-name>/x.pdf')='Supplementary'; bundleOf('misc/x.pdf')='Original'
  - Date parse: '2001-2-3 note.pdf' -> '2001-02-03'; '3.2.2001.pdf' -> '2001-02-03'; 'no date.pdf' -> ''
  - text_status: '.msg' -> pending, '.pdf' -> pending, '.eml' -> extracted
  - With 605 Original rows already loaded, the first new Original file gets ref 'OD-606' and n 'R606'
  - url for rel 'A B/c&d.pdf' = '../A%20B/c%26d.pdf'
- **Source defects:**
  - `S-rescan_tab-1` (high) Prefix mismatch: rescan strips '../' but every embedded URL begins with './', so nothing embedded is ever recognised; the first rescan re-adds the whole case folder as new rows with fresh refs, duplicating the corpus in every chronology-based view. Evidence: 2797 'decodeURIComponent(r.url.replace(/^\.\.\//,''))' vs data urls all './...'; 2803 'if(seen[f.rel]\|\|storePaths[f.rel])return;isNew.push(f);'
  - `S-rescan_tab-2` (medium) No change detection: size/mod collected but 'changed' never populated or shown; UI text promises path + size + modified-date diff. Evidence: 2799 '{rel,size:f.size,mod:f.lastModified}'; 2802 'changed=[]' unused; 2787
  - `S-rescan_tab-3` (medium) Rescan URLs are '../'-relative while embedded URLs are './'-relative; one of the two link bases is wrong for any given app location. Evidence: 2812 'url:'../'+...'
  - `S-rescan_tab-4` (medium) Ref numbering = bundle row count + 1 without zero padding; can collide with or misorder against existing refs, and ignores the Additional bundle. Evidence: 2804-2805, 193
  - `S-rescan_tab-5` (low) Walk includes everything under the folder (the app HTML, assembled court bundles, extracts), each becoming a document row. Evidence: 2798-2799 (no filter)
  - `S-rescan_tab-6` (low) 'Write updated index to file' writes only the rescan additions, not an updated index. Evidence: 2824 'JSON.stringify(rescanRows(),null,2)'
  - `S-rescan_tab-7` (low) Non-PDF/non-msg files marked 'extracted' with no extraction; invoice detection uses a case-specific filename regex. Evidence: 2810-2811
  - `S-rescan_tab-8` (low) Picker cancel/permission errors are swallowed silently. Evidence: 2794 'catch(e){}'
- **Notes:** Requires the File System Access API (showDirectoryPicker; showSaveFilePicker optional). No network. Rescan rows feed allRows(), so they appear in chronology, documents, search, overview counts and the freshness stamp.

## Backup / Restore (`backup_tab`)

Group System. Owner CC-10. Live renderer line 2830. Static: 2 handler sites, 0 navigation sites, 2 download calls, 1 download anchors, 0 print calls.

- **Code:** 2830-2837 (single definition); STORE_KEYS 2829; backupExport 2838; backupImport 2839-2840
- **Imported datasets:** code constant STORE_KEYS (20 keys) 2829
- **User-work stores:**
  - `all 20 STORE_KEYS` (read+write): export file: {<key>: <parsed value or null>} for every STORE_KEYS entry. table shows per key load(k,[]) size: array length, else Object.keys count. Export reads every key (null when absent). Import writes each key present in the file that is in STORE_KEYS and whose value != null.
- **State:** File input (accept application/json, hidden inside the 'Import state' label) read with FileReader.readAsText; No module state
- **Actions (2):**
  - button "Export all state" → download JSON of all STORE_KEYS (`backupExport 2838`)
  - file-input "Import state" → parse JSON, restore listed keys, alert 'State restored.', refresh stamp, re-render; alert 'Import failed: <message>' on parse error (`backupImport 2839`)
- **Exports:**
  - JSON `ess_dcs_backup.json`: JSON.stringify({key: load(key,null)} for the 20 STORE_KEYS, null, 2) (`backupExport 2838`)
- **Derived values and rules:**
  - Restore semantics: per-key REPLACE of the whole stored value; keys absent from the file, or present with null, leave the existing local value untouched (no clearing); keys not in STORE_KEYS are ignored; no schema/shape/version validation, no confirmation, no preview
  - Export writes null for never-used keys; importing that file therefore skips them
  - Table count for a key whose stored value is an object = number of own keys (e.g. info_done, enf_status)
- **Originals:** none
- **Example candidates:**
  - Export of an empty browser produces an object with exactly the 20 STORE_KEYS, all null
  - Importing {'ess_dcs_timesheet_v1':[...], 'unknown_key':1, 'ess_dcs_deadlines_v1':null} writes only the timesheet key
  - Importing a backup never touches ess_dcs_bundle_header_v2, ess_dcs_schedule_*_v1 or ess_dcs_caselines_docs_v1
- **Source defects:**
  - `S-backup_tab-1` (high) STORE_KEYS misses 5 live user-work keys (bundle header v2, schedule C/O map, schedule selection, schedule mode, CaseLines linked docs), so backup/restore silently loses that work. Evidence: 2829 vs 1847, 3187-3189, 3518
  - `S-backup_tab-2` (low) STORE_KEYS includes 4 keys no code reads or writes (ess_dcs_courtbundle_v1, ess_dcs_bundle_header_v1, ess_dcs_bundle_extents_v1, ess_dcs_bundle_overrides_v1). Evidence: 2829; CBK.ext/ovr/legacy never referenced
  - `S-backup_tab-3` (medium) Import has no validation or confirmation; a malformed but parseable file overwrites stores with wrong shapes. Evidence: 2840 'if(STORE_KEYS.includes(k)&&o[k]!=null)save(k,o[k]);'
  - `S-backup_tab-4` (low) A failed import leaves the file input value set, so choosing the same file again does not fire change until re-render. Evidence: 2840 (go() only on success)
- **Notes:** The manual (2849) tells users that register tabs incl. court bundle save under ess_dcs_<feature>_v1 keys and that Backup / Restore moves them - not true for the 5 missing keys.

## Manual (`manual`)

Group System. Owner CC-10. Live renderer line 2843. Static: 2 handler sites, 1 navigation sites, 0 download calls, 0 download anchors, 0 print calls.

- **Code:** 2843-2857 (single definition); showNone 2858-2860; verifyLinks 2861-2864
- **Imported datasets:** DATA.buildReport.generatedFrom; DATA.buildReport.textNone[] {ref, bundle, filename} (237); DATA.quantum.headline_ref, DATA.quantum.headline_date; META.docCount, META.emails, META.people, META.textNone, META.textPending; DATA.linkSample[] {ref, bundle, filename, url} (18); DATA.buildReport.pending - NOT read
- **User-work stores:** none
- **State:** none; showNone and verifyLinks both write into the same #noneList container, replacing each other
- **Actions (4):**
  - link "Rescan & Update (in text)" → go('rescan_tab') (`data-tab router 297`)
  - button "List scanned documents needing OCR (<n>)" → table Ref/Bundle/Filename of buildReport.textNone, scroll box max-height 360px (`showNone 2858`)
  - button "Verify link sample" → table Ref/Bundle/Filename/Resolved link of DATA.linkSample (no check performed) (`verifyLinks 2861`)
  - link "open ↗ (link sample row)" → open original (modal for IFRAME_EXT, else new tab) (`docLink 2862`)
- **Exports:** none
- **Derived values and rules:**
  - Static narrative: ref prefixes OD-/SD-/EM-/PN- meaning; freshness stamp; tabs; storage keys; quantum caveat quoting DATA.quantum.headline_ref and headline_date
  - Build report badges: Documents META.docCount, Emails META.emails, People META.people, Scanned (none) META.textNone, Pending META.textPending; OCR button count = DATA.buildReport.textNone.length (can differ from META.textNone)
- **Originals:** DATA.linkSample[].url via docLink
- **Example candidates:**
  - OCR button label count equals DATA.buildReport.textNone.length
  - Verify link sample renders exactly DATA.linkSample.length rows in input order
- **Source defects:**
  - `S-manual-1` (low) 'Verify link sample' verifies nothing; the footnote hard-codes '18 links ... were verified ... at build time' instead of using the data length. Evidence: 2863 '18 links across bundles/types were verified'
  - `S-manual-2` (low) Manual claims all register/court bundle stores use ess_dcs_<feature>_v1 keys and move via Backup/Restore; header _v2, schedule and CaseLines keys do not. Evidence: 2849 vs 2829
  - `S-manual-3` (low) Manual lists only four ref prefixes; the Additional bundle prefixes in data are not explained. Evidence: 2847
- **Notes:** Read-only page. META counts may disagree with derived counts (probe noted META.textNone vs rows with text_status none).

## Shared helpers

- `esc`: 180 (HTML-escape &<>"')
- `load`: 188 (localStorage.getItem + JSON.parse; returns def when missing/falsy/parse error)
- `save`: 189 (localStorage.setItem(JSON.stringify); alert('Storage failed: ...') on quota error)
- `dl`: 190-191 (Blob -> object URL -> hidden <a download> click -> revokeObjectURL immediately)
- `toCSV`: 192 (quote cell if it contains comma, double quote or \n; double inner quotes; CRLF row separator)
- `refCode`: 193 ({Original:'OD',Supplementary:'SD',Correspondence:'EM',Pleadings:'PN'}[bundle]\|\|'XX') + '-' + seq (seq NOT zero-padded)
- `docLink`: 194 (<a class='doc' target=_blank rel=noopener>label ↗</a>; empty url -> escaped label only)
- `openViewer/closeViewer`: 197-204 (modal #docModal; iframe for IFRAME_EXT set at 196: .pdf .jpg .jpeg .png .gif .svg .webp .html .htm .txt .md .json .csv; fallback panel otherwise; Escape closes at 210)
- `global a.doc click`: 205-209 (plain left click on a.doc: name = last '/' segment of href, decodeURIComponent; ext = '.'+text after last '.', lower-cased; if ext in IFRAME_EXT -> preventDefault + openViewer; else default anchor navigation). NOTE: a '#page=N' fragment makes ext '.pdf#page=n' so such links bypass the viewer.
- `bundleBadge/statusBadge/typeBadge`: 211/214/216
- `rescanRows/allRows`: 235-236 (allRows = DATA.chronology.concat(load('ess_dcs_rescan_v1',[])))
- `freshnessStamp`: 286-287 ('Built on '+META.builtAt+' · '+(META.docCount+rescan.length)+' documents indexed'+(' · +N via rescan'))
- `go`: 292-296 (sets CURRENT, nav highlight, crumb, scroll top, calls `RENDER[tab](#main)`)
- `pageHead/emptyState`: 301/302
- `cleanName`: 439 (strip leading '(digits) ' and trailing .pdf/.eml/.msg, case-insensitive)
- `val`: 496 (document.getElementById(id).value or '')
