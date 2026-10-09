# Independent v5 oracle reconciliation

Reviewed implementation: `c3c773cf4016d02ab22d62754c6eab5a23ca9401`. The independent oracle has 42 views, 243 capability entries and 35 export entries. The checklist has 213 activated controls, 58 form-field groups/entries and eight shared-shell controls. All 26 action-count differences were resolved by reading the main v5 source as text. Source line numbers below refer to the pinned main HTML; no archive code was executed.

| View | Oracle | Checklist | Fields | Resolution from v5 source |
| --- | ---: | ---: | ---: | --- |
| `elements_tab` | 1 | 1 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.elements_tab lines 2993-2998 (single definition, no helper functions). Dispatched by go() at lines 292-296 via RENDER[tab]. NAV entry at line 277. Source file: /home/operator/Work/Active/MX-two/ClearCase/spikes/v5-probe/raw/ESS_DCS_Workspace.html (all line numbers refer to it).. |
| `authorities_tab` | 5 | 2 | 1 | Three passive inputs are one documented field group; Add and CSV are controls. Source lines 3001–3014. |
| `heads_tab` | 8 | 4 | 1 | Four passive inputs are a field group; Export/Add/Delete/reference links retained. Detailed checklist records chronology/rescan helper reads. Source lines 3017–3036; refLink 2867; allRows 236. |
| `crossexam_tab` | 7 | 3 | 1 | Four passive inputs are a field group; two differently located Add buttons and Delete retained. Source lines 3039–3057. |
| `settlement_tab` | 6 | 1 | 5 | Five passive model inputs feed Model. Source lines 3060–3083. |
| `enforcement_tab` | 1 | 1 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.enforcement_tab lines 2872-2887; setEnf 2888; ENF_OPTS const 2871; NAV entry line 277; dispatched by go() 292-296 via RENDER map (311). |
| `legality_tab` | 1 | 1 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.legality_tab lines 2891-2905; docLink 194; global a.doc click handler 205-209; cleanName 439; chip 231. |
| `prescription_tab` | 5 | 6 | 0 | Prev and Next are two controls. Source lines 2908–2929; pager 307–309. |
| `interest_calc_tab` | 6 | 1 | 5 | Five passive fields feed Compute. Source lines 2932–2959. |
| `payments_tab` | 4 | 4 | 1 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.payments_tab lines 2962-2983; drawPay 2984-2987; addPay 2988; delPay 2989; ledgerCSVp 2990; refLinks/refLink 2867-2868 with allRows() 236; docLink 194; money 185; fmtR 182-183. |
| `privilege_tab` | 4 | 3 | 4 | Passive form excluded from action count, fields retained; Add/Delete/CSV retained. Source lines 588–615; 622–623. |
| `popia_tab` | 4 | 3 | 4 | Same ledger factory; passive form recorded separately. Source lines 588–615; 624–625. |
| `annotations_tab` | 4 | 3 | 3 | Same ledger factory; passive form recorded separately. Source lines 588–615; 626–627. |
| `transcriptions_tab` | 4 | 3 | 4 | Same ledger factory; passive form recorded separately. Source lines 588–615; 628–629. |
| `rescan_tab` | 5 | 5 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.rescan_tab L2778-2792; rescanConnect L2794; rescanNow L2795-2818 (walk L2798-2800, bundleOf L2801, diff L2802-2804, row build L2805-2813, save L2814, status L2815-2816); drawRescanTbl L2819-2822; rescanClear L2823; rescanWriteIndex L2824-2826. Helpers: RKEY L234, rescanRows L235, allRows L236, freshnessStamp L286-287, refCode L193, docLink L194, openViewer L197-203, a.doc click handler L205-209. Dispatch: go() L292-296; NAV 'System' L279.. |
| `backup_tab` | 3 | 2 | 0 | Store-count table is display-only; Export/Import retained. Missing five live backup keys remain disclosed. Source lines 2829–2840. |
| `manual` | 4 | 4 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.manual L2843-2857; showNone L2858-2860; verifyLinks L2861-2864. Helpers: docLink L194, bundleBadge L211-213, a.doc click handler L205-209, global [data-tab] click handler L297. Dispatch: NAV 'System' L279.. |
| `overview` | 4 | 8 | 0 | Six quick links split into six controls; global search counted once in the shell. Source lines 316–345; shell 299. |
| `matter` | 0 | 0 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.matter, lines 348-356. |
| `timeline` | 6 | 5 | 0 | Hover titles are display-only, not activated controls. Source lines 359–403; quantumChart 568–573. |
| `chronology` | 8 | 13 | 0 | Five sort headers and Prev/Next are distinct controls. Source lines 407–444; pager 307–309. |
| `quantum_tab` | 5 | 5 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.quantum_tab, lines 540-566. Helpers: docLinkText 567, quantumChart 568-573, exportInvoices 574-575.. |
| `contradictions_tab` | 2 | 2 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.contradictions_tab, lines 2662-2695. Helpers: sevBadge 2660, refChips 2661 (also used by vdm_matrix_tab), exportContradictions 2696-2698. Dispatch: go(tab) at lines 292-296 calls RENDER[tab] or renderMissing.. |
| `risk_matrix_tab` | 0 | 0 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.risk_matrix_tab, lines 2704-2709. Helpers: tableCard 2701-2703 (shared with witness_tab), chip 231, pageHead 301.. |
| `vdm_matrix_tab` | 2 | 2 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.vdm_matrix_tab, lines 2710-2718. Export: exportDefence 2719-2721. Shared helpers: refChips 2661, pageHead 301.. |
| `info_required_tab` | 1 | 1 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.info_required_tab, lines 2722-2728. toggleInfo, global function, line 2729. Re-render goes through go() at 292-296. pageHead 301.. |
| `witness_tab` | 0 | 0 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.witness_tab, lines 2730-2734. Shared helpers: tableCard 2701-2703, pageHead 301.. |
| `conflict_tab` | 3 | 2 | 1 | Typed query is a passive field; select-change and Check are controls. Source lines 2735–2757. |
| `documents` | 6 | 8 | 0 | Oracle lists Original separately and groups the other three bundle buttons; split that group and Prev/Next, exclude passive badges. Source lines 449–470; pager 307–309. |
| `contracts_tab` | 2 | 2 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.contracts_tab L2588-2604; row builder contractRow L2584-2587; exportContracts L2605-2607. Shared: pageHead L301, chip L231, statusBadge L214, docLink L194, cleanName L439, toCSV L192, dl L190.. |
| `filings_tab` | 7 | 6 | 1 | The register form supplies values to Add; fields listed separately. Source lines 2610–2657. |
| `search` | 13 | 6 | 9 | Nine passive fields occupy seven oracle entries; split Prev/Next; global search belongs to the shell. Source lines 474–516; shell 299; pager 307–309. |
| `people` | 0 | 0 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.people L526-531. Shared: pageHead L301 only.. |
| `entity_ledger_tab` | 0 | 0 | 0 | Counts agree; action capabilities, datasets, store reads/writes and export descriptions inspected. Source lines RENDER.entity_ledger_tab L533-538. The ledgerTab() factory (L588) is not used here. Shared: pageHead L301.. |
| `hoa_diff_tab` | 4 | 1 | 3 | Three passive selectors feed Compare; fields retained separately. Source lines 2759–2774. |
| `invoice_ledger_tab` | 4 | 2 | 0 | KPI and table are display-only; Export and original link are actions. Source lines 576–584. |
| `disbursements_tab` | 5 | 3 | 4 | Passive form and display table excluded from actions; Add, Delete and CSV retained. Source lines 588–618. |
| `timesheet_tab` | 5 | 3 | 6 | Derived Value column and table are passive; six fields retained separately. Source lines 588–621. |
| `deadlines_tab` | 9 | 3 | 4 | Four passive fields, date-sorted display and table excluded; Add/Delete/ICS retained. Wrong-row deletion remains disclosed. Source lines 632–655. |
| `discovery_tab` | 24 | 23 | 0 | Selection counter is display-only. Effective second renderer is used; both mode buttons and all bundle controls retained. Source lines 3220–3414; cover 3434–3474. |
| `court_bundle_tab` | 46 | 55 | 1 | Split paired links, three tabs, from/to, up/down and three built-output controls (+9). Include two buttons omitted by oracle (2051 and 2219); exclude passive header-field group and KPI (-2). Net +9 controls. Source lines 1872–1877; 1942–2081; 2127–2381; 2570–2578. |
| `caselines_tab` | 15 | 16 | 0 | Enter in search input and Search button are separately activated controls. Existing-file downloads are retained as actions, not generated exports. Source lines 3521–3642. |

The export counts use different units: Timeline prints the existing page; Discovery separates cover and index printing; Court Bundle separates HTML index print from PDF print and retains the explicitly unreachable CSV; CaseLines generates no exports but has existing-file downloads. These differences omit no control.

The summary table omits indirect chronology/rescan reads for Payments and Heads of Argument. The detailed sections and shared-helper preamble record them correctly; this is a non-blocking summary correction for the coordinator. Twenty-five store names occur overall, 21 are live, the backup set has 20, and five live stores are missing from it. The source defect remains open.
