# Overview

The overview of a results version shows the case's counts (documents, amount due, invoices, contradiction flags, documents without text, originals verified or missing, notes), the M2 widget slots (open deadlines, unbilled time, freshness), the matter narrative in one paragraph with citations that link to the cited documents, the source date span, breakdowns by bundle, type and text status, and quick links to the main views.

## Sub-features

- `overview-counts` shows the document count from the validated register and the source's claims.
- `overview-slots` renders one card per slot declared in `src/lib/components/overview-slots.ts` (`deadlines` and `unbilled-time` owned by GRS-17, `rescan-freshness` owned by GRS-20). An unfilled slot says "Not yet available — owned by GRS-nn (CC-nn)"; a filled one shows its owner's widget; a loader that throws marks only its own slot as an error.
- `overview-narrative` renders the matter narrative with `[[REF]]` citations as links to existing documents, and unresolved ones visibly broken.
- `overview-originals` counts verified, missing, embedded and download-only originals.
- `overview-quick-links` links to Chronology and the M2 views, marking unavailable ones.

## How to get to it (user POV)

- Open `/` while a version is active (it redirects to `/v/<rv>/overview`).
- Choose `Active case` in the top bar, or `Overview` (`#nav-overview`) in the case navigation.
- Choose `Preview the candidate` on a validation report for a candidate's overview.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed: the synthetic version is active.

- **Open the overview.** Choose `#nav-overview`. Step `citation`. `main[data-ready=overview]` appears with `#active-banner`.
- **Counts.** *Covered in `preview`.* `#count-documents[data-count]` is 7; `#count-verified` counts the verified originals.
- **Widget slots.** Step `overview-slots`, on the overview `activate` lands on. Each `main section[data-slot]` has `data-slot-status` `unavailable` with text starting `Not yet available — owned by GRS-17` (or `GRS-20`), or `filled`; `error` (a loader threw) fails the step, and exactly the three declared slots must appear. When an owner fills a slot, extend this step (or add one) to assert the widget's own content for the synthetic case, and keep the unfilled-slot check for the others.
- **Follow a citation.** In "The matter, in one paragraph", choose the `OD-001` link (`.narrative a.cite`). Step `citation`. Its `href` is `/v/<rv>/doc/OD-001`, and the document page shows `main[data-ready=doc:OD-001]` with a heading starting `OD-001`.
- **Unresolved citation.** *Not yet driven.* The bare mention `OD-002` stays text (CITE_BARE_MENTION). A `[[REF]]` to a missing ref renders as `span.cite-broken`.
- **Proof.** `screens/05-activated-overview.png` (slots, counts), the slot states in `inner.json`, `screens/07-overview-narrative.png` and `screens/08-document-OD-001.png`.

## Gotchas

- The narrative is the only `{@html}` in the app. Assert on `.narrative a.cite` and `.cite-broken`, not on raw text.
- `main[data-ready=overview]` is set after mount. Wait for it before clicking, or SvelteKit's client router may not intercept the click yet.
- Slots are filled only from `src/lib/views/<category>/overview-widgets.ts` and `overview-widgets.server.ts` of the slot owner's category; a slot filled twice, an unknown slot or a foreign category fails the overview's load. The overview page itself is coordinator-owned, so never assert on a slot by its position among the cards; use `section[data-slot=<id>]`.
