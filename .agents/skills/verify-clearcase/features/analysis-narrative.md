# Matter & Strategy and Timeline

Matter & Strategy shows the package's storyline and strategy memorandum, heading and paragraph per item in data order. Timeline is the phased write-up: a synopsis and the amount-due note from the package's view-content, documents by year, every phase with its events, the amount-due trajectory, the principal correspondents and evidence notes. Both are read-only (GRS-15).

## Sub-features

- `matter-narrative` renders `matter.storyline` and `matter.strategy` through `Narrative.svelte`; `[[REF]]` tokens link to `/v/<rv>/doc/<ref>`, a missing ref is `span.cite-broken`.
- `timeline-phases` groups events under each phase whose years include theirs (`2001`, `2002–2003`), in data order; a phase without events shows the package's empty-phase note; events outside every phase are listed under "Outside every phase".
- `timeline-links` links each event to its document by ref, the title shown once, as text (v5 escaped it twice).
- `timeline-print` prints with `#print`; print CSS hides the shell and the page actions.

## How to get to it (user POV)

- Choose `Matter & Strategy` (`#nav-matter`) or `Timeline` (`#nav-timeline`) in the case navigation.
- Open `/v/<rv>/analysis/matter` or `/v/<rv>/analysis/timeline`.
- From the timeline, `#full-chronology` opens the chronology.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed on the synthetic case. The plain synthetic case that `lib/inner.mjs` builds (`tests/case-package/fixtures/synth.ts`) already fills every analysis view with one to three rows; the analysis e2e suite extends it with `analysisData` (`tests/e2e/analysis/lib.mjs`).

- **Open.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). Choose `#nav-matter`. `main[data-ready=matter]` appears, the `h1[data-page-heading]` reads `Matter & Strategy` and has focus, the title is `Matter & Strategy · <case> · ClearCase`.
- **Follow a citation.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). In `#matter-storyline-card`, choose `a.cite` for OD-001: `main[data-ready="doc:OD-001"]`. Back returns with the heading focused.
- **Read the timeline.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). Choose `#nav-timeline`. `#phases .ph` are the phases in order; each `.ev` has `.d` (date), `.badge` (kind), `.mono` (ref) and an `a.cite` labelled `<title> ↗`.
- **Print.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). Choose `#print`. With print media emulated (`Emulation.setEmulatedMedia {media: 'print'}`), `nav.views`, `header.top` and `.page-actions` are `display: none` and every `.ev` is visible.
- **Proof.** Until a drive step exists, the proof is `tests/e2e/analysis/suite.mjs`, scenarios AN-01 to AN-04; `screens/timeline-print.pdf`.

## Gotchas

- The page heading is the navigation label `Timeline`; v5 says "Chronology & Timeline" (register IDR-163).
- Case wording (subtitle, synopsis, narrative, notes) comes only from the package's `view-content`; without it those paragraphs are absent, not replaced by other text.
- Year bars are SVG (`.bar rect`), because the app's CSP refuses inline styles. Read heights from `rect`, not `style.height`.
- The amount-due note's `source ↗` is a citation of `quantum.headline_ref`, built from the template parts.
- `main[data-ready=<view-id>]` is already in the server-rendered HTML, because the data is complete there. Wait for `main[data-hydrated]` as well before clicking a control (checkbox, Export CSV, Print / PDF), or the click may land before the page handles it.
