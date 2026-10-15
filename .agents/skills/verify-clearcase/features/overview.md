# Overview

The overview of a results version shows the case's counts (documents, amount due, invoices, contradiction flags, documents without text, originals verified or missing, notes), the widget slots (Open deadlines and Unbilled time from the registers views, Freshness from Rescan & Update), the matter narrative in one paragraph with citations that link to the cited documents, the source date span, breakdowns by bundle, type and text status, and quick links to the main views.

## Sub-features

- `overview-counts` shows the document count from the validated register and the source's claims.
- `overview-slots` renders one card per slot declared in `src/lib/components/overview-slots.ts`: `deadlines` and `unbilled-time` (filled by GRS-17's `src/lib/views/registers/overview-widgets*.ts`) and `rescan-freshness` (filled by GRS-20's `src/lib/views/system/overview-widgets*.ts`). All three are filled. A slot without a widget would say "Not yet available — owned by GRS-nn (CC-nn)"; a loader that throws marks only its own slot as an error.
- `overview-narrative` renders the matter narrative with `[[REF]]` citations as links to existing documents, and unresolved ones visibly broken.
- `overview-originals` counts originals verified in the case folder (`#count-verified` includes case mismatches), missing, inside a parent e-mail and download-only.
- `overview-quick-links` links under `Go to` to Chronology and the main views; a view still blocked by its owner would be marked, and none is.

## How to get to it (user POV)

- Open `/` (it redirects to the case list, `/cases`) and choose `Open` on an active case.
- Choose `Cases` (`#nav-cases`) in the top bar, then `Open`; or choose `Overview` (`#nav-overview`) in the case navigation of any version page.
- Choose `Preview the candidate` on a validation report for a candidate's overview.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed: the synthetic version is active.

- **Open the overview.** Choose `#nav-overview`. Step `citation`. `main[data-ready=overview]` appears with `#active-banner`.
- **Counts.** *Covered in `preview`.* `#count-documents[data-count]` is 7. `#count-verified` is not asserted.
- **Widget slots.** Step `overview-slots`, on the overview `activate` lands on. Exactly the three declared `main section[data-slot]` cards appear, each `data-slot-status=filled`: `deadlines` reads `0` ("in the deadline tracker"), `unbilled-time` reads `0.0 h` ("recorded, not yet billed") and `rescan-freshness` reads `Built on <date> · 7 documents indexed.` with a `Rescan & Update` link. `unavailable` or `error` fails the step. The Freshness card after a rescan is step `system-freshness` (see `system-rescan.md`).
- **Follow a citation.** In "The matter, in one paragraph", choose the `OD-001` link (`.narrative a.cite`). Step `citation`. Its `href` is `/v/<rv>/doc/OD-001`, and the document page shows `main[data-ready=doc:OD-001]` with a heading starting `OD-001`.
- **Unresolved citation.** *Not yet driven.* The bare mention `OD-002` stays text (CITE_BARE_MENTION). A `[[REF]]` to a missing ref renders as `span.cite-broken`.
- **Proof.** `screens/05-activated-overview.png` (slots, counts), the slot states in `inner.json`, `screens/07-overview-narrative.png` and `screens/08-document-OD-001.png`.

## Gotchas

- The narrative is the only `{@html}` in the app. Assert on `.narrative a.cite` and `.cite-broken`, not on raw text.
- `main[data-ready=overview]` is set after mount. Wait for it before clicking, or SvelteKit's client router may not intercept the click yet.
- Slots are filled only from `src/lib/views/<category>/overview-widgets.ts` and `overview-widgets.server.ts` of the slot owner's category; a slot filled twice, an unknown slot or a foreign category fails the overview's load. The overview page itself is coordinator-owned, so never assert on a slot by its position among the cards; use `section[data-slot=<id>]`.
