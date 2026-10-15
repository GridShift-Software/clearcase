# Round 1 synthesis and revision response (GRS-89)

Round 1 reviewed prototype `1b092b524ff228b5d3f7ab79627febaa36cbab5f` (source base `8693ed886b7c641eacba76d06806f723f515cedb`). This revision answers it. Everything below is reviewer or builder opinion on invented fixtures. No participant took part, and none of it is client usability evidence, hosted-implementation evidence or parity evidence.

## Methods, exactly

| Reviewer | Method | Not done |
| --- | --- | --- |
| Expert (case-work continuity, coverage) | **Source and screenshot walkthrough only; no browser ran.** Read the AGENTS files, README, both source audits, all of `prototype.html`, and the parent's screenshot (A, desktop, Overview). Script check of 42/42 ids, labels and groups against `view-registry.ts`. Assessed B before A. | Execution of any task; mobile; keyboard; screen reader |
| Novice (first-time client findability) | Own T3 browser tab: A then B, each at 1280 then 390 wide; a 48-destination crawl; a tab-stop count; task paths timed in actions, not seconds. | Participants; screen reader |
| Mobile and keyboard | One T3 browser tab: A then B, each at 390x844 then 1280x800, plus a 320 px viewport reflow check. Real key presses for Tab, Enter, Escape, `/` and the arrow keys; focus and geometry read from the DOM. Desktop user agent, so no virtual keyboard. | Screen reader; contrast tool; browser zoom; real phone |

All three recorded `doctor` FAIL on three skill-pin drifts only, and confirmed the served page matched the file at head.

Revision checks (this document's author, no subagents, no automated tests, no app gate): `git diff` and link checks wrapped in receipts, and targeted actions in the T3 browser tab at 1280x800 and 390x844 in both arms. Details are in `.local/grs89-revision-report.md` (ignored; not committed).

## Round 1 scores (0 absent, 1 hard, 2 friction, 3 clear; opinion)

| Reviewer | Arm | Find | Context | Coverage | Load | Mobile | Keyboard |
| --- | --- | --: | --: | --: | --: | --: | --: |
| Novice | A | 2 | 2 | 3 | 2 | 2 | 1 |
| Novice | B | 2 | 3 | 2 | 2 | 2 | 2 |
| Expert | A | 3 | 2 | 3 | 2 | 2 | 2 |
| Expert | B | 2 | 2 | 2 | 2 | 2 | 2 |
| Mobile | A | 2 | 2 | 3 | 2 | 2 | 2 |
| Mobile | B | 2 | 2 | 2 | 2 | 2 | 2 |

Preference was split and weak: novice B (narrowly), expert A (weakly, for desktop case workers), mobile B (narrowly, for quick work). That split is the finding that justifies keeping two structurally different arms.

## Accepted classes and what changed

| # | Class (reviewers) | Change | Where |
| --- | --- | --- | --- |
| 1 | Invented extraction percentage; 62% in the header against 52% on the Overview (all three, high) | Removed every percentage. Processing is manual (`docs/product-brief.md`, V2 workflow), so the page shows three separate facts with timestamps: **Submission** (uploading, finalized, input revision), **Processing** (not started, with an operator, finished; "no progress figure is available") and **Publication** (which Results version is active). Header chip, Overview card and page agree because they read one state. | Submissions & publication; header chips |
| 2 | Unsaved drafts dropped by navigation, Escape, original page changes and variant switch (all three) | Drafts live in memory per place of entry and survive all of those. A yellow cue appears in the form ("Unsaved draft ... lost if you reload"), with Save and Discard draft, plus a header chip "n unsaved drafts" that resumes or discards each. Closing with Escape says the draft was kept. **No backend persistence is claimed.** | all note, edit and time forms |
| 3 | Overlays: focus leaves, nothing inert, Back leaves the page, focus lost on B rail citations, arrow keys hijacked (all three) | One overlay mechanism. On a phone the viewer, capture, More and A's drawer are modal sheets: one at a time, `aria-modal`, background `inert`, Tab wraps inside, backdrop dismisses. The viewer is history-tracked at every width: browser Back closes it (or the sheet) before leaving. Focus returns to the opener found again by what it is (a citation's ref and page within its region), so the rail re-render no longer loses it. Left and Right switch variant only while focus is on the switcher, so wide tables scroll normally. Back and variant switches restore scroll by anchor (section or row) and the URL now carries `sec`, `q` and `rv`. | overlay and URL code |
| 4 | A: long always-open list; phone header dropped version and status | Only the current group is open; others open on demand; a filter (Enter opens the first match) finds any of the destinations; all 42 stay reachable (checked by `selfCheck()`). The 390 px header keeps the Results version control and the submission status chip. | A sidebar and header |
| 5 | B: off-screen strip, More under Capture, switcher covering controls, hosted chips inside Admin, rail mislabelled and far from the work | The task strip wraps on desktop and is a disclosure ("Argue tools (11)") on a phone. Only one phone sheet opens at a time. The switcher sits bottom-left, the Capture button bottom-right, and the sidebar and rail stop above the switcher. Planned chips carry a visible **Planned** badge. Submission status moved from Admin to Desk and the task renamed System. On a phone the context rail is a disclosure at the top of the work, and the header with search stays sticky. Outside Matter the rail is titled "Evidence cited in Matter & Strategy. Not specific to ..." | B shell |
| 6 | No home for newer-export, platform or operator capabilities; do not equate 42 with 55 | 12 planned case destinations, 3 platform and 3 private operator surfaces, all visibly planned; the operator block is in the catalogue only. Source-backed table in `coverage-appendix.md`. | catalogue; appendices |
| 7 | Task 3 had no path; no version-change simulation; notes silently in the export; small targets | Chronology issue tags open the issue in Matter & Strategy and a risk link opens its row in a working Risk Matrix, and back. A simulated operator publishes Results v4; the header version control and a banner let you switch version and keep page, section, search, filters and drafts. The export names its scope before and after generating and defaults to **no notes**. Touch targets are at least 24 px on desktop (28 to 32 for chips and buttons) and 30 to 40 on a phone. | Chronology; Risk Matrix; Submissions; Court Bundle |

## Objections not taken, with reasons

1. **"The arms are not blinded" (expert, medium).** Not changed. This prototype is for expert and designer review of two hypotheses, where reviewers must know which hypothesis they judge. Blinding belongs to the participant protocol in the workflow audit, which would need random X/Y labels, a facilitator script and counterbalanced order. The A/B labels here are counterbalanced across rounds on purpose, so order effects are not confounded with the label. A blind participant build would be a separate step.
2. **"Document opening and Back behave identically, so the audits' differentiators are missing" (expert, medium).** Not changed, and deliberately so. The original viewer, Back, drafts and focus handling are shared so that only the navigation model differs; otherwise a preference for A or B could come from the drawer or the palette and not from the navigation. The audits' `?doc=` drawer and Ctrl+K palette are recorded in the inventory as untested options. The contrast that remains is the intended one: A is places (persistent sidebar, in-page section rail, inline notes), B is tasks (task rows, tool strip, evidence rail, capture).

## Settled by the user after Round 1: Notes

On 15 October 2026 the user settled the open questions. Recorded as decisions, not prototype assumptions:

- **One contextual Notes feature.** Every existing record is preserved. Each note links to the case, a document and page, or an analysis section.
- **Default visibility: users assigned to the case**, within the same case-permission boundary. Notes never cross cases. Labelled "Shared with assigned case users".
- **Permissions:** users edit and delete their own notes; case editors can also manage other people's; an audit history is retained; case viewers only read and cannot create or change.
- **Exports:** shared case notes are **excluded from client packet exports by default**, included only when explicitly selected, with the scope shown before download.

What the prototype does with it: one Notes list on the Annotations view, reachable from sections, originals and quick capture; a simulated role switch (case viewer, assigned user, case editor) in the prototype bar; edit and delete with a visible, in-memory history; an export with a notes choice that defaults to none. **Not built and not claimed:** authorization, audit storage, case isolation, or the migration that maps existing document-page notes and Annotations register records into Notes. That mapping is implementation work. The source distinction is kept in the inventory: the document page's "My notes" (a CC-03 addition, keyed by ref and original fingerprint) and the `annotations_tab` register (document ref plus note) are separate stores today.

## Open items and assumptions that remain

- The Annotations view keeps its v5 id and label so the 42 stay intact; whether the unified feature keeps that name is open.
- Fee-earner and rate fields on time entry, and edit or delete of time entries, are not added: not needed for the study tasks.
- Processing stage names for the client are taken from the V2 workflow text; the real product wording is unverified. Anchors and Email silences have unspecified content.
- B's task labels (Argue, System) are firm words; the expert preferred A for experienced desktop users. Not changed; it is the hypothesis.
- Accessibility remains unverified by assistive technology: no screen reader, contrast tool, zoom or real phone keyboard was used.

## Focus for round 2

1. Re-run task 3 (chronology to issue and risk and back) and task 8 (version change) in both arms and judge whether context really survives.
2. Re-test overlays on a phone: Back, Escape, focus return and containment, especially B's rail citations and A's drawer filter.
3. Check the draft cue and chip are noticed, and that discarding is clear.
4. Check the Notes labels, role simulation and export scope read as decisions made, not as features that exist.
5. Look for a regression: sticky header height at 390 px in both arms, and the switcher against content.
