# Round 2 synthesis and final correction (GRS-89)

Round 2 reviewed prototype `b68343d5ade622fa18a0b9f1963c2aba28b09ba9` (Round 1 `1b092b5`, source base `8693ed886b7c641eacba76d06806f723f515cedb`). The final correction is the commit that adds this file. Everything here is reviewer or builder opinion on invented fixtures. No participant took part, and none of it is client usability, hosted-implementation or parity evidence.

## Methods, exactly

| Reviewer | Method | Not done |
| --- | --- | --- |
| Novice (first-time client) | Own T3 tab, B 1280 → B 390 → A 1280 → A 390, fresh load each. Real clicks, typing and Tab, Shift+Tab, Enter, Escape, `/`. Back was a scripted `history.back()`. Four real downloads. Served bytes matched HEAD at start and end. | Real Back button, screen reader, contrast, phone keyboard |
| Expert (case work, coverage) | **Source walkthrough only; no browser.** Read all of `prototype.html`. One Bun probe evaluated the data block (D-0344, issue counts, filter order). Served bytes matched HEAD. | Any executed task; mobile and keyboard scores are predictions |
| Mobile and keyboard | Own T3 tab, B 390 → A 390 → 1280 (A, then B) → 320 (B, then A). Real Tab, Shift+Tab, Enter, Escape, `/`, arrows and select ArrowUp; geometry from `elementFromPoint`. Back was scripted. Two real downloads. | Real Back button, screen reader, real phone, zoom |

## Round 2 scores (0 absent, 1 hard, 2 friction, 3 clear). PRE-FIX opinions, not re-scored

| Reviewer | Arm | Find | Context | Coverage | Load | Mobile | Keyboard |
| --- | --- | --: | --: | --: | --: | --: | --: |
| Novice | A | 2 | 2 | 3 | 2 | 2 | 2 |
| Novice | B | 3 | 2 | 3 | 2 | 3 | 2 |
| Expert (source predictions) | A | 2 | 2 | 3 | 2 | 2 | 2 |
| Expert (source predictions) | B | 2 | 2 | 3 | 2 | 2 | 2 |
| Mobile and keyboard | A | 2 | 3 | 3 | 2 | 2 | 2 |
| Mobile and keyboard | B | 2 | 2 | 3 | 2 | 2 | 2 |

Preferences, all weak: novice B for a first-time client; expert A for a desktop case worker, B for phone capture; mobile split, B on phones for capture and A at a desktop keyboard. No winner.

## Evidence against predictions

- **Risk link.** The expert proved from source that R-2 did not cite D-0344 (M1). Both browser reviewers passed the chronology task, because the filter survived. The source reading was right; the browser pass did not check the citation.
- **Operator reach.** The novice saw no operator surfaces in navigation. The expert proved they were two clicks away through All tools, and that publish buttons sat on the client's Submissions page (M2).
- **Filter "time".** Predicted from source (L1) and observed by both browser reviewers: Enter opened Timeline.
- **Rail regression.** The mobile reviewer's inferred cause was largely right. A red loop at `b68343d` showed three writers of the current section: the jump (which never wrote the URL), an IntersectionObserver that also fired on the viewer's reflow and re-rendered B's rail (removing the focused opener), and popstate overwriting it from a stale URL.

## Accepted classes and what changed

| # | Findings | Change |
| --: | --- | --- |
| 1 | Mobile 1 (HIGH), 2, 4; novice F1, F2, F4, F9 (focus) | One section model: changes only on a jump or a deliberate scroll (wheel, touch, scroll keys, scrollbar). A reading line under the sticky bars decides it, and it freezes while the viewer is open. Each change writes `sec`. Reload, share and A↔B keep it. The version select no longer commits on arrows: **View** applies it and focus stays. |
| 2 | Mobile 3; novice F10 | Scroll padding from the measured sticky and bottom bars keeps focus visible. B's task row wraps with the viewer open. The phone toast sits above the bottom bars. |
| 3 | Novice F3, F7, F8; expert M4, L6; mobile 8 | Save before Discard; Discard asks Keep or Discard and keeps focus. Note links: case, document page or analysis section only, never the page you left; the view anchor is gone. The draft link follows the viewer page. A's phone header shows Today and notes chips. |
| 4 | Expert L1; novice F5, F6, F11; mobile 6 | Ranked filter (exact label, task word, prefixes, then descriptions), "n of 58", Best match, Enter, Clear. The filter clears on navigation. |
| 5 | Expert M1 | Events have stable ids. R-2 cites D-0344 (K6 p.3); a chronology row links only to the risks that cite it, and the Risk Matrix links back to that one event. |
| 6 | Expert M2 | Operator surfaces and actions moved to a separate, simulated **Operator study** page in the prototype bar. `selfCheck` now covers both navs, All tools and Submissions. |
| 7 | Expert M3 | Results v4 has real synthetic changes (order, merged section, two events, a reassessed risk). Ids are stable; a missing target says so and opens the Summary. |
| 8 | Expert M5, L3, L5; mobile 5 | **Client packet export** (planned, simulated) split from Court Bundle, which now maps the v5 DOCX index and print. Every page names its v5 export. Overview rollback and `/import`, `/recovery` are mapped in Operator study. Planned labels and 32 px tags on phones. |

## Not taken or deferred

- **Placement splits** (expert L2: Witnesses, Cross-Exam, Prescription, Disbursements) are taxonomy opinion for client testing, not defects.
- **"S-4 … Planned" reads as a planned status** (novice, inferred): the Planned label is required on every planned capability, phones included, so it stays.
- **Not rechecked:** Forward after a detour (expert L4); a px-restored Search row under the header once the banner goes (novice F9: geometry only in the final recheck). Focus after a page-level Back (mobile 7) was fixed and rechecked in the sticky-focus correction below.
- **Implementation work, not modelled:** matching records across versions by ref and original fingerprint; any rollback control or its permission; real DOCX, PDF or packet assembly; authorization, audit and storage.

## Sticky-focus correction (after the final recheck)

The final recheck found one regression: `html{scroll-padding-top}`, added for class 2, made focus on a control inside a sticky bar scroll the page. `/` (A 1280, A 390, B 390) and Shift+Tab or Tab to the version select and View moved the viewport away from the section the URL named. A related low: after a scripted page-level Back, focus sat on the off-screen H1.

- **Change.** The padding stays for content. While focus is inside any sticky or fixed bar (header, task row, tools row, sidebar, rail, viewer, capture sheet, switcher) the page's scroll padding is 0 (`html:has(…:focus-within)`), so a bar control never scrolls the page. After a page-level Back or a restored place, focus goes to the page heading if it is on screen, else the section heading, else the first block in view. Section links in lists now carry `sec` in their href (Risk Matrix issue tags); the All tools label no longer counts operator surfaces.
- **Method.** T3 browser tab, Chrome, real Tab, Shift+Tab, Enter, Escape, `/` and ArrowUp, against the served bytes. Back was a scripted `history.back()`. Red at `7b9f6d5` (served bytes = that blob), green with the change served from the working tree and again at the commit.
- **Result.** Red: A 1280 `/` scrollY 670 to 0; Shift+Tab to "2 notes" 670 to 330; B 390 `/` 1359 to 600; Back focus on `page-h1` at y -1159. Green: 670, 670, 1359 stay; version select and View keep 670 (View applies v2, focus stays on the select, Issue C at the same y); Back focuses `h-issue-c` at y 156, next Tab is rail D-0311. Content focus still stops clear of the bars: B 390 Download CSV scrolled to y 416, Shift+Tab to a citation under the header scrolled it into view.
- **Unchanged paths rechecked.** B 1280 chip C, Tab to rail D-0311, Enter, Escape (focus back on the rail item, URL, rail and Issue C unchanged); A and B switch keeps C; B 390 capture sheet trap and Escape; A 390 drawer trap and Escape; real packet CSV download (792 B) with focus visible.
- **Limits.** A first Tab from the header to a control in the page's top status row still scrolls to that row, as a browser does. Operator study still overflows at 320. Focus scrolling never updates `sec` (by design). Headless Chrome only; no real phone, screen reader or real Back button. The ratings above are the pre-fix opinions and are unchanged.

## Final gaps

The real browser Back button, Forward, a screen reader, contrast, zoom, a real phone keyboard and real participants remain untested. Optional taxonomy preferences, full specialty views and assistive-technology testing are gaps, not scope. [`client-test-script.md`](client-test-script.md) is the next step.
