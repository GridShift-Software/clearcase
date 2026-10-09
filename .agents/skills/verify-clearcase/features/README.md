# ClearCase pilot verification map

This directory is the maintained source for verifying the user-facing behavior of the ClearCase local pilot. Read this index before driving the app, then follow the matching feature file. The runner `bin/verify-clearcase run` drives every bullet marked with a step ID. Bullets marked *not yet driven* name the user path and the proof that a new step must use; add the step in `lib/drive.mjs` before claiming the bullet as verified.

## Baseline preconditions

- `scripts/agent-tools/doctor` passes, including `bun`, `app-unshare`, `app-ip`, `app-chromium` and `app-runner`.
- The checkout has `node_modules` installed with `bun install --frozen-lockfile`, and the revision under test is committed.
- Each run builds that revision in isolation and boots it inside its own offline network namespace: app `http://127.0.0.1:43600`, originals `http://clearcase-originals.localhost:43601`, with a fresh data directory under the run's scratch.
- The live doctor passes for the run's PID, data directory, ports, build stamp and Bun pin before any drive step.
- The case is synthetic: `buildCase` from `tests/e2e/pilot/lib/fixtures.ts` with 7 register rows (OD-001 to OD-004, EM-0001, EM-0002 and SD-001). OD-001 is a one-page PDF reading `Synthetic agreement OD-001`, and the matter narrative is "The agreement [[OD-001]] began the relationship; see also OD-002."
- Never drive an instance this run did not start, and never use case material.

## Driving conventions

- Steps run in order on one instance; each one starts from the state the previous step left.
- Use the app's stable handles: element IDs, `main[data-ready]`, `data-*` attributes and link text. Avoid layout, coordinates and tab order.
- Act through user controls in Chromium (`x.click`, `x.fill`, links). The HTTP client `x.c` is only for a read-only second view of a side effect.
- Wait for `main[data-ready=<page>]`, which most pages set after mount, never for a fixed time. The import page is the exception (see `import-validation.md`).

## Proof and skip reporting

- Capture the action and the resulting state. Each step writes `screens/NN-<step>.png` and returns the values it read.
- A mutation (activation) is proven by a second view: the `/` redirect before and after.
- The originals viewer is proven inside its sandboxed frame (`window.__viewer.rendered`, text layer), not just by the wrapper.
- Any egress attempt (canary hit, request to another origin) fails the run.
- A step that cannot run is NOT RUN and fails the run. Do not report a bullet as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-clearcase` starts with `Preconditions:` and uses labeled bullets that pair each user action with its drive step (or *not yet driven*), the handles and the observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

## Features

- [Import and validation report](./import-validation.md): the Import results form, validation, the report's verdict and diagnostics.
- [Preview and activation](./preview-activation.md): read-only candidate preview, acknowledgement of new warnings, activation and rollback.
- [Overview](./overview.md): case counts, the matter narrative with citations, quick links.
- [Chronology](./chronology.md): the register list with filters, sorting and CSV export.
- [Document detail and originals viewer](./document-originals.md): one document's fields, its original on the isolated originals site, the pdf.js viewer, notes.
- [Unavailable views and the view registry](./unavailable-views.md): the 42-entry navigation and the explicit not-yet-available pages of views owned by later tickets.

## Extending

An M2 owner who lands a view, widget or user-work table adds its proof here in the same change. The coordinator reserves `features/<your-feature>.md` for you; `SKILL.md`, `lib/` and `bin/` are coordinator-serialized (see `docs/development.md`, Adding a view), so propose drive steps to the coordinator or in your ticket's brief.

1. **Feature file.** Copy the shape above: H1, one paragraph, the four H2s. List every user entry point, pair each user action with its drive step or *not yet driven*, and name the stable handles your page exposes (`main[data-ready=view:<id>]` or your own, element IDs, `data-*`). Add it to the index above.
2. **Registry entry.** Your view stops being unavailable when the coordinator adds it to `AVAILABLE` and regenerates `src/lib/components/view-registry.ts`. Then move it out of [unavailable-views.md](./unavailable-views.md) and update the `available` list the `unavailable-view` step records.
3. **Drive step.** Append a step to `lib/drive.mjs` (the shape is in `SKILL.md`, Extending). Act through the UI; use `x.c` only for a read-only second view.
4. **Contracts to assert through.** Prove behavior on what the user sees, but check it against the shared contracts so a proof does not depend on internals:
   - Document rows: `documentRows(store, rv)` and `activeDocumentRows(app(), caseId)` in `src/lib/local-case/documents.server.ts`. A view listing documents shows the same rows and count as the chronology (7 for the synthetic case; `/api/v/<rv>/chronology` is the HTTP second view).
   - User work: `app().userWork` in `src/lib/local-case/user-work.server.ts`. It provides:
     - the register API, `putRow`/`listRows`/`deleteRow`;
     - notes and seed overlays;
     - `tables` and `defineTable`, which needs `scope: 'case' | 'store'`;
     - the defined-table row API, `putTableRow`/`deleteTableRow`/`listTableRows`;
     - `exportAll`, `importAll` and `registerStores`.

     A step that creates user work proves it persists across a reload and, where your ticket requires it, across a re-import of the same case. Rows are keyed by stable ids, never by position.
   - Overview widget slots: `src/lib/components/overview-slots.ts`. Filling `deadlines`, `unbilled-time` (GRS-17) or `rescan-freshness` (GRS-20) flips `section[data-slot=<id>]` to `data-slot-status=filled`; extend the `overview-slots` step to assert your widget's content (see [overview.md](./overview.md)).
   - Citations and originals: link documents with `CitationLink`/`docPath` and open originals with `OriginalOpen`; drive a new-tab original with `x.openTab` and the viewer checks of [document-originals.md](./document-originals.md).
5. **Synthetic data only.** If the case lacks data your view needs, extend the `synthetic-case` step in `lib/inner.mjs` through `buildCase`'s `edit`, `rows` or `originals` options, with invented values.
6. **Prove it.** Run `bin/verify-clearcase run` (or `scripts/agent-tools/verify app`) and `bin/verify-clearcase self-test`; both must pass, and the evidence directory must hold your step's screenshot.
