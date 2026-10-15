# View navigation and the view registry

Every version page has the case navigation of 42 entries from the generated view registry, in the v5 group order (Matter, Evidence, Case management, Analysis, Litigation strategy, Registers, System). All 42 views are available and each has its own route; a category or view that is not in the registry is a 404.

## Sub-features

- `registry-nav` lists 42 entries (`nav.views a[data-view]`, `id=nav-<view>`) with `data-status=available`, marking the current page with `aria-current=page`.
- `own-route` opens each entry's own page under `/v/<rv>/<category>/<view>` (Overview and Chronology at `/v/<rv>/overview` and `/v/<rv>/chronology`).
- `unknown-view` returns 404 for a category or view that is not in the registry.
- `unavailable-page` is dormant: the catch-all route would render `<label> is not yet available` with its owner (`[data-unavailable][data-owner]`) for a registry entry without its own route, and no entry lacks one.

## How to get to it (user POV)

- Choose any entry in the case navigation (`nav.views`), e.g. `Matter & Strategy` (`#nav-matter`).
- Choose a link under `Go to` on the overview.
- Open `/v/<rv>/<category>/<view>` directly.

## Driving it with verify-clearcase

Preconditions:

- A version page is open (after `viewer`, the main tab is back in front on the OD-001 document page).

- **Registry and an own route.** Choose `#nav-matter`. Step `view-registry`. The path is `/v/<rv>/analysis/matter` and `main[data-ready=matter]` appears; the navigation has 42 `a[data-view]` entries, none without `data-status=available`; no `[data-unavailable]` placeholder is on the page; `aria-current=page` is on `#nav-matter`.
- **Unknown view.** Step `view-registry`: `GET /v/<rv>/analysis/no-such-view` through `x.c.get` returns 404.
- **Every view opens.** Choose each `nav.views a[data-view]` in turn. Step `every-view`. Each lands on its own path with `main[data-ready=<id>]`, `aria-current=page` on its entry and a heading; the step records each view's heading and time.
- **Each view's own content.** *Not yet driven* beyond `every-view`, except where a category feature file names a step (`system-*`). See the category feature files (`analysis-*`, `bundles-*`, `evidence-*`, `litigation-*`, `quantum-*`, `registers-*`, `system-*`).
- **Unavailable page.** *Verified unreachable.* Every registry entry has its own route (`src/routes/v/[vid]/<category>/<view>/`), so `UnavailableView.svelte` never renders. It becomes reachable only if a new registry entry lands without its route.
- **Proof.** `screens/10-matter.png` and `screens/11-view-manual.png` (the last view `every-view` opens), with the entry count, the unavailable list (empty), the unknown-view status and every view's heading in `inner.json`.

## Gotchas

- The registry is generated (`scripts/pilot/generate-view-registry.ts`, owners listed in its `PASSED` set). Never assert on a hand-copied list of labels.
- A view's `main[data-ready]` is its registry id (`matter`, `documents`, `deadlines_tab`); `view:<id>` belongs to the dormant unavailable page alone. Many views set it in the server HTML and mark hydration separately with `main[data-hydrated]`; wait for that before clicking a control. Read the route's `+page.svelte` before waiting on either.
- An entry's link carries the view's remembered query (`ViewNav.svelte`), so compare paths, not full URLs.
