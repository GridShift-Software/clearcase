# Port map: the local demo's client features on hosted Workers, styled after the partner prototype

Read-only analysis on `dev` at `1ed4b634`, 28 October 2026. Nothing run, edited or deployed. Files cited are repo-relative.

## 1. Feature inventory of the local app (`src/routes/v/[vid]/`, 42 registry views in `src/lib/components/view-registry.ts`)

Every loader reaches `app().store` (`CaseStore` over `node:sqlite`, `src/lib/local-case/app.server.ts`, `store.server.ts`) through a few seams. Grouped by seam:

- **Shell** (`+layout.server.ts`): `store.getVersion`, `a.verify` (re-hashes the read model), `viewContentOf(_shell)`; `ViewNav.svelte` renders `VIEW_GROUPS`. Overview adds `documentCounts`, `resolveRefs`, `userWork.summary`, `previousVersion` and widget slots (`overview-widgets.server.ts`).
- **Document-row views** (`documents.server.ts`: `listJson`, `documentRows`, `documentRow`, `resolveRefs`, `childDocuments`; `views/evidence/rows.server.ts`): chronology (`+page.ts` fetches `/api/v/[vid]/chronology`, filters client-side in `local-case/chronology.ts`), documents, search (`searchRowsOf`, filters over `excerpt`, no full text), hoa_diff, contracts, filings, and `doc/[ref]` (adds `store.assetForServe`, `OriginalsServer.availability` on the filesystem, notes).
- **Dataset views** (`results.server.ts`: `datasetOf`, `viewContentOf`, `viewText`, `exportFileName`; plus `resolveRefs`): analysis x7 (`analysis/data.server.ts`), people, entities, litigation x7, quantum x6 (`views/quantum/data.server.ts`), bundles x3 (also `bundles/links.server.ts` for package-file downloads and `bundles/store.server.ts` for custom bundles).
- **User-work views** (`views/registers/page.server.ts`, `user-work/registers.server.ts`, `user-work.server.ts`, `work.sqlite`): 7 registers (deadlines, timesheet, disbursements, privilege, POPIA, annotations, transcripts); writes also in info_required, payments, crossexam, heads, authorities, enforcement, bundles and notes, through `answer.server.ts` (`guarded`, `inTurn`).
- **Machine-local, not portable**: system views (rescan, backup, manual: `views/system/*.server.ts`), the originals site and pdf.js host (`originals.server.ts`, `viewer/`), import and recovery routes. `scripts/ci/hosted-imports.ts` line 8 already forbids these in the hosted graph.

## 2. Portability

- **Svelte pages port as they are.** The 3,408 lines of `+page.svelte` under `src/routes/v` and 1,576 lines in `src/lib/components` and `src/lib/views/*/*.svelte` import only components, pure `$lib/views/*` modules, `$lib/local-case/model` and `$lib/local-case/chronology`; no `.server` import (checked with `rg`). They render from `data`. Two seams need a parameter: `versionPath`/`docPath` in `src/lib/local-case/model.ts:79-80` hardcode `/v/<rv>/...` (used by `CitationLink.svelte` and 8 pages), and `OriginalOpen.svelte` takes `links` built by the loader, so the hosted loader supplies hosted hrefs (`src/lib/views/hosted/paths.ts`).
- **Loaders are the work.** About 45 `+page.server.ts` files call sync `app().store` and `app().userWork`. The hosted side already has the matching async contract: `CaseReader` in `src/lib/server/runtime/contracts.ts:31-44` has `datasetOf`, `viewContentOf`, `documentRows`, `documentRow`, `existingRefs`, `childDocuments`, `listJson`, `documentCounts`, `anyDateBasis`, `fingerprints`, `packageFile`, `seeds`; `UserWork` at lines 87-100 mirrors `user-work.server.ts` (`notesFor`, `addNote`, `listRows`, `putRow`, `seedViews`, `putSeedOverlay`, `defineTable`...), implemented over D1 in `src/lib/user-work/hosted/d1-user-work.ts` (`uw_note`, `uw_register_row`, `uw_seed_overlay`, `uw_table_row`). `memory-reader.ts` shows a `CaseReader` served from in-memory JSON. So each loader is a 10-40 line rewrite from `app().store` to `locals.store`/`locals.userWork`, and `results.server.ts`/`documents.server.ts` helpers can be made adapter-neutral by taking a `CaseReader`.
- **Actions**: local `guarded`/`registers(userWork)` versus hosted `Written<...>` with `operationId` and expected `WorkVersion`; one shared adapter in `src/lib/views/hosted/` covers the 12 views with forms.
- **Not portable without redesign**: bundle downloads from `package_file` on disk (use `CaseReader.packageFile` and R2), the fs originals site (hosted already has `deploy/client/routes/cases/[caseId]/originals/[assetId]/{+server.ts,view}`), and system views (drop; the backup view becomes "download case pack" later).

## 3. Data delivery

Why reads are slow today: `src/lib/results/hosted/model.ts:16-38` loads every `rs_document`, `rs_asset`, `rs_seed` row and re-hashes the whole read model per isolate per version; `reader.ts:196-208` reads each dataset from R2 with `verifiedRead` (`storage/cloud/objects.ts:11-19`: whole object, sha256 every time); `assets.ts:32-56` buffers the whole original and slices the range; `required-section-render.ts:36-80` refuses publication unless every required dataset renders natively, and only chronology does; `readiness.ts:122-128` caps readiness at 200 entries and 256 KiB.

Proposal: **precompute per-version view payloads on the operator machine and serve them as immutable objects.**
- At publish (operator step, Bun, reusing `readCandidate` and `project`): write `views/<rv>/manifest.json` (sha256 per shard), `views/<rv>/view/<id>.json` (dataset plus resolved-ref set plus view text, one per dataset view), `views/<rv>/list/page-<n>.json` (chronology list rows, about 500 per page, date order), `views/<rv>/list/facets.json` (bundle, type, status and year counts), `views/<rv>/doc/<ref>.json` (the `doc/[ref]` payload: row, state, attachments, children, asset id), `views/<rv>/search/<token-prefix>.json` (inverted index over subject, filename, sender, excerpt). Store with `writeOnce`; record the manifest sha in `rs_publication`.
- Worker route: one authorization per request (identity, grant, current published version: 2-3 D1 reads, cached in `locals`), then `BUCKET.get` and stream, `ETag` = shard sha, `cache-control: private, max-age=31536000, immutable`. Integrity is checked when written, not per read; the manifest sha in D1 is the audit anchor.
- Fits the views: dataset views need exactly `datasetOf(key)` + `resolveRefs` + view text (`docs/results-package.md:5`: 35 datasets, 6.2 MB total, largest 1.8 MB). Chronology, documents and search keep client-side filtering while the list is under about 10k rows; beyond that they switch to paged shards plus `facets.json` plus the search index. 100k to 1M+ documents: `doc/<ref>` is one small object per document (fine for R2), list pages scale linearly, search shards by token prefix; the per-read whole-model hash must go. D1 keeps grants, `uw_*` notes, registers, overlays, custom bundles, deadlines and audit; pages join them to refs client-side.
- PDFs: `assets.ts` should call `bucket.get(key, { range })` and compare the stored `checksums.sha256` (R2 keeps what `writeOnce` set) instead of hashing every range; `viewer/hosted/delivery.ts` keeps the 1 KiB sniff as a ranged read.
- Delete or bypass in `src/lib/results/hosted`: `model.ts` `loadVerifiedModel` and `reader.ts` `collect`/`listJson` for client reads (keep for operator verify), `published-reads.ts` `originalAttributions` (folded into shards); replace the chronology-only rule in `required-section-render.ts` with "payload manifest present and hashed", and lift the 200/256 KiB readiness caps. Keep `versions.ts` `requirePublished`, `index.ts` wiring and the asset authority path.

## 4. Prototype mapping (`.local/partner-prototype-v0.1.html`, NAV at line 281, shell at 195-226)

| Prototype | Local view | Cost |
| --- | --- | --- |
| Sidebar: brand, numbered grouped nav, footer | `ViewNav.svelte`; 24 NAV ids match registry ids (overview, timeline, chronology, risk_matrix_tab, vdm_matrix_tab, matter, search, contracts_tab, filings_tab, heads_tab, transcriptions_tab, documents, contradictions_tab, discovery_tab, court_bundle_tab, caselines_tab, popia_tab, deadlines_tab, timesheet_tab, annotations_tab, backup_tab, hoa_diff_tab, privilege_tab, info_required_tab) | Restyle; regroup by a static map |
| Prototype-only tabs: organogram, anchor, legal/court filings, emails, whatsapp, billing, audit, outlook | none | `UnavailableView.svelte` placeholder, cheap |
| Topbar: crumb, global search (Ctrl K), freshness pill (published vN, date, count), surface switch | none; search goes to `evidence/search`; freshness from `rs_publication` | New, small |
| Overview KPI cards, deadlines next 60 days, quick links | `overview/+page.svelte`, `OverviewSlots.svelte` slots | Restyle |
| "What changed since you last opened" | `previousVersion` exists, no diff view | New, later |
| Chronology split view with right-hand viewer pane (`chronViewer`) | chronology `DataGrid` + `doc/[ref]` + hosted viewer route | New pane (iframe of `originals/[assetId]/view`); row to document link exists (`docPath`, `OriginalOpen`) |
| Viewer modal (download original, open in tab, add to bundle) | `doc/[ref]` + `OriginalOpen.svelte` | Restyle; modal later |
| Bundle tray, add to bundle, assemble | `court_bundle_tab` custom bundles (`bundles/store.server.ts`, `bundles/builder.ts`) | Tray is new UI; assembly out of scope |
| All Documents, Deadlines (countdown pills), Court Bundle | `evidence/documents`, `registers/deadlines_tab` (`registers/logic.ts` countdown), `bundles/court_bundle_tab` | Restyle; `.ics` export small new |
| Operations Console, Client Portal, Design system | `OperatorWorkbench.svelte`, `client/intake`, brand-tokens lane | Exists; tokens only |

## 5. Plan (engineer-days for one strong agent builder; [P] = parallel on disjoint paths)

0. Shapes (0.5): write the shard types in `src/lib/views/payloads.ts` by reading the 45 loaders' return shapes; decide the hosted route prefix `cases/[caseId]/v/[rv]/<category>/<view>` and parameterize `versionPath`/`docPath`.
1. Payload builder (2) [P with 2, 3]: `scripts/publish/build-view-payloads.ts` from `readCandidate` + `project`; run on the v5 sample; `writeOnce` to R2 at publish; manifest sha in D1; gate rule change in `required-section-render.ts` and `readiness.ts`.
2. Hosted shell and read path (2) [P]: `src/lib/views/hosted/payloads.server.ts` (authorize once, fetch shard, cache headers); new `+layout.server.ts`/`+layout.svelte` under `deploy/client/routes/cases/[caseId]/v/[rv]/` with `ViewNav`; generic loader for dataset views.
3. PDF range delivery (1) [P]: `assets.ts` ranged `get` with stored checksum; `delivery.ts` probe; Astra check that a 50 MB PDF opens in under 2 s.
4. Read-only dataset views (4): copy the 24 analysis, litigation, quantum, people and entities pages; payload loaders; overview on shards plus `uw_*` summary.
5. Document-row views (3): paged chronology with facets, documents, search over the index, `doc/[ref]` from `doc/<ref>` shard plus originals link plus notes; split pane.
6. User-work views (3) [P with 4, 5 once 2 lands]: 7 registers, notes, info_required overlays, payments, litigation adds on `D1UserWork`; the `guarded`/`Written` adapter; deadlines `.ics`.
7. Bundles (2): discovery, court, CaseLines from shards; custom bundles in `uw_register_row`; package-file downloads from R2; tray deferred.
8. Prototype restyle (2) [P from day 1]: tokens from the brand-tokens lane, sidebar, topbar with freshness and search, cards and pills per `.orchestration/demo/prod-inspo.md`; placeholders for prototype-only tabs.
9. Scale and journey check (1): synthetic 100k-document package through the builder; shard sizes and page timings on a sandbox Worker; Astra runs the full client journey.

Total about 20.5 engineer-days. With three builders on disjoint paths (A: 1, 9; B: 2, 4, 5, 7; C: 3, 6, 8) the critical path is 0, 2, 4, 5, 7, 9: about 11 days.

Map notes: the hosted `CaseReader`/`UserWork` contracts are the port seam; the local loaders bypass them. `required-section-render.ts` is why only chronology is published, not a missing view. `view-content` prose reaches the local views through `viewContentOf`; shards must carry it or the hosted views fall back to neutral names.
