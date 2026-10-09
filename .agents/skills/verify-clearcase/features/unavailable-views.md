# Unavailable views and the view registry

Every version page has the case navigation of 42 entries from the generated view registry, in the v5 group order. The pilot's own views (Overview, Chronology) are available; every other entry is a real link to an explicit "not yet available" page that names its owning ticket and shows no case data. An M2 owner's route replaces that page when the view lands.

## Sub-features

- `registry-nav` lists 42 entries with `data-view` and `data-status`, marking unavailable ones.
- `unavailable-page` shows `<label> is not yet available`, its owner (`data-owner`, e.g. GRS-15) and no case data.
- `unknown-view` returns 404 for a category or view that is not in the registry.

## How to get to it (user POV)

- Choose any entry in the case navigation (`nav.views`), e.g. `Matter & Strategy` (`#nav-matter`).
- Choose an unavailable link under `Go to` on the overview.
- Open `/v/<rv>/<category>/<view>` directly.

## Driving it with verify-clearcase

Preconditions:

- A version page is open (after `viewer`, the main tab is on the OD-001 document page).

- **Open an unavailable view.** Choose `#nav-matter`. Step `unavailable-view`. `main[data-ready=view:matter]` appears, `[data-unavailable=matter]` has `data-owner=GRS-15`, and the navigation has 42 `a[data-view]` entries.
- **Unknown view.** *Not yet driven.* `GET /v/<rv>/analysis/no-such-view` through `x.c.get` returns 404.
- **Proof.** `screens/10-unavailable-matter.png`, with the owner, the entry count and the available view IDs in `inner.json`.

## Gotchas

- When an M2 ticket ships its view, its entry's `status` flips to `available` and its route replaces the unavailable page. Move that view out of this file into its own feature file with a real drive step, and update the `available` list this step records.
- The registry is generated (`scripts/pilot/generate-view-registry.ts`). Never assert on a hand-copied list of labels.
