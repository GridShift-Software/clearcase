# Parity harness: v5 versus the app, view by view

The harness shows that the app **behaves like** the v5 sample on the same input, not only that it holds the same data. For each of the 42 v5 views it renders the v5 workspace and the app with one fixed clock, reads what each shows through the UI, normalizes both into one snapshot shape and compares them value by value. Every intended difference is on the [intentional-differences register](intentional-differences.json); a registered difference passes with a note, and only an unregistered difference fails.

Owner: CC-29 ([GRS-37](https://linear.app/vaper/issue/GRS-37)). M2 owners add the app side of their views; the CC-11 gate runs it over all 42.

## Run it

```sh
bun run --bun build                       # the production build the app side uses
bun run --bun parity -- --all --fixture-config .local/v5-verification.json --out .local/parity-out/run
bun run --bun parity -- --view chronology,overview --fixture-config .local/v5-verification.json --out .local/parity-out/pilot
```

| Option | Meaning |
| --- | --- |
| `--all` or `--view ID[,ID…]` | The views to compare, by v5 navigation id. |
| `--fixture-config FILE` | The local fixture locator (`.local/v5-verification.json`, the same file `verify:pilot:v5` uses). Its main HTML and expected-examples hashes are checked against the committed profile. |
| `--out DIR` | Output directory, inside `.local/` or outside the repository. |
| `--clock ISO`, `--timezone TZ` | The fixed clock (default `2026-10-08T09:00:00Z`) and timezone (default `UTC`) for both sides. |
| `--approved-only` | Only approved register entries cover differences. The CC-11 gate uses this. |
| `--strict-register` | Fail when a register entry covered nothing in the views run (see [Unused entries](#unused-entries)). |
| `--no-sweeps`, `--no-exports` | Skip the interaction sweeps or the export capture (quick checks while writing an adapter). |
| `--keep-snapshots` | Also write both sides' full snapshots per view (`views/<view>.snapshots.json`). |
| `--app-root DIR` | Use another checkout's build and modules (the mutation proof). |
| `--app-v5-html FILE` | Self-parity: the app side is the v5 adapter on another copy of the v5 HTML. |

Exit codes: **0** no unregistered difference; **1** at least one unregistered difference, a view that did not extract on either side (an app adapter that threw, or an available view without one, included; the register never covers it), an unused register entry under `--strict-register`, or any isolation breach: a v5 network request, an app request that is not loopback, a canary hit other than a browser service, or a changed fixture tree; **2** setup error (arguments, locator, register, build, conversion, import or the offline proof). The register is checked first, before the runner re-executes offline or reads the locator, and a whole-view entry whose owner is not the view registry's owner is a register error.

A full run takes about 100 seconds on this host, most of it the chronology sweeps.

### What runs, and how it is isolated

- The runner re-executes itself under `unshare -rn` through `tests/e2e/pilot/offline.sh` and proves that only loopback exists before it starts anything. There is no online fallback.
- One headless Chromium runs, sandboxed, with a temporary profile. Every non-loopback host name maps to a local canary. The browser's own background services (network time, push messaging, phishing lists) are switched off; a canary hit from a Google browser-service endpoint is counted apart as browser background traffic, and any other hit fails the run.
- **v5**: the main HTML from the fixture tree, opened read-only as a `file:` URL. `Date` is frozen at the clock and the timezone is overridden. localStorage is cleared and seeded on every load. Only the page's own UI code runs; no archive processing or build script. Every request that is not `file:`, `data:`, `blob:` or `about:` is recorded with its view in `v5-requests.json`, and any network one fails the run. Requests by Chromium's built-in PDF viewer (`chrome-extension:`) to show a local PDF that a view embeds are browser-internal and counted apart.
- **App**: the v5 main HTML is converted with GRS-10's converter. The production build is started under Bun with `CLEARCASE_FIXED_NOW` set to the clock (the pilot's `now()` seam) and `TZ` set. The package is imported and activated through the app's own forms. Every request the app page makes that is not to `127.0.0.1` or a `*.localhost` host, `data:`, `blob:` or `about:` is counted, and any one fails the run.
- The fixture tree's stamp is taken before and after the run; any change fails it.

### Outputs

| File | Content | Commit? |
| --- | --- | --- |
| `scorecard.json`, `scorecard.md` | Counts only: see [Scorecard](#scorecard). | Counts may be quoted in reports. |
| `views/<view>.json` | Every unregistered and registered difference with its path and both values. | **Never**: case values. |
| `views/<view>.snapshots.json` | Both snapshots (with `--keep-snapshots`). | **Never**. |
| `register-usage.json` | Register entry ids that covered something, and the unused ones. | Ids only. |
| `v5-requests.json`, `canary-hits.json` | Isolation evidence. | Local. |

## The snapshot

Both adapters of a view return the same shape (`scripts/parity/lib/compare.mjs` has the full comment):

```
{ view, side, status: 'ok' | 'not-implemented' | 'error',
  title, texts: {id: s}, kpis: {id: {label, value, sub}}, counts: {id: s},
  tables: {id: {columns: [{id, label}], key, rows: [{colId: s}]}}, lists: {id: [s]},
  controls: {inventoryId: n}, sweeps: {id: {combo: s}}, exports: {id: {name, columns, rows} | {name, text}},
  focus: {step: s} }
```

It is flattened into paths, and each path is one compared value:

- `title`, `text.<id>`, `kpi.<id>.label|value|sub` and `count.<id>`.
- `table.<id>.columns` and `table.<id>.col.<col>` (labels). `table.<id>.rows` is the row count. `table.<id>.order` is the key sequence, and a diff of it reports the first divergence. `table.<id>.row.<key>.<col>` is one cell.
- `list.<id>.count` and `list.<id>.item.<i>`. A `<select>`'s options are `list.select.<first option>`.
- `control.<kind>:<label>` holds a multiplicity. Labels lose sort arrows, and digit runs become `#`. A control in a table row is `control.row:<kind>:<column>`.
- `sweep.<id>.<combo>`, `export.<id>.name|columns|rows|row.<i>.<col>|text` and `focus.<step>`.

A path on one side only is a difference against `<absent>`. Ids are slugs of the **v5** wording, so an app adapter maps its own elements onto the v5 ids.

### Normalization

Normalization (`scripts/parity/lib/normalize.mjs`, tested in `tests/parity/normalize.test.ts`) removes presentation noise only:

- White space: NFC, every Unicode space as a plain space, runs collapsed and the ends trimmed.
- Digit grouping (`1,689` = `1 689` = `1689`) and the v5 money shape (`R 1 234.50` = `R1,234.50`). Shown precision is kept.
- `D Mon YYYY` dates become ISO. Ambiguous numeric dates are not guessed.
- Sort stability: views keep v5's stable sort, so orders compare exactly. `canonicalTies` exists for a view that does not define the order of ties, and its use must be registered.

A changed word or marker is **never** normalized away: `—` against `undated` is a difference, and its register entry says why.

### What the v5 adapter extracts

`scripts/parity/adapters/v5/` covers all 42 views:

- **Generic, per view**: a clean load, `go(view)`, then the extractor over `#main`. It pages through every pager with its Next button and records the pager wording and total. It presses every export, download or print control and parses what it produced. It clicks the view's sidebar entry and records where focus lands.
- **Register edit**, for every view with an Add control: two entries are added with the view's own form, each field filled with synthetic values by input type. Then the first shown row is deleted, and the overview tiles are read.
- **Chronology**:
  - The Title / subject cell stacks up to four parts: the title, the sender tag, the excerpt (ending in `…`) and the `also in:` tag. The adapter splits them into the `title_subject`, `sender`, `excerpt` and `also_in` columns, so each is compared. A part is the excerpt when it is the first to end in `…`, the also-in tag when it starts with `also in: `, and otherwise a sender part. Empty cells are compared too: a column the app lacks differs on every row, empty or not.
  - `filter_sort_ui`: about 100 filter and sort combinations through the controls, reading every row's ref on every page.
  - `filter_sort_engine`: the parity trial's 22,500-combination grid, run at library level with v5's own `chronFiltered`.
- **Overview**: `seeded_user_work`, the tiles with synthetic deadlines and timesheet rows relative to the clock.

Combination keys are index-coded (`b2.t0.s1.q0.ref.desc`) over the sorted options of the converted package, so no case value appears in a key. Exports are compared by content: CSV and ICS as rows; JSON with its keys sorted; DOCX and PDF as text; TXT and print captures as normalized text.

## Add an app adapter (M2 owners)

1. Build, then run your view with its v5 snapshot kept:
   `bun run --bun parity -- --view <id> --fixture-config .local/v5-verification.json --out .local/parity-out/<id> --keep-snapshots`.
   Read the `v5` side of `views/<id>.snapshots.json` for its ids and sweeps. Keep that file local.
2. Create `scripts/parity/adapters/app/<id>.mjs`:

   ```js
   import { fromRaw, remap } from '../../lib/snapshot.mjs';
   import { navFocus, open } from './_shell.mjs';
   export default {
   	view: '<id>',
   	async extract(p, ctx) {
   		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: '<id>' });
   		await open(p, ctx, ctx.registry['<id>'].route, '<id>'); // waits for data-ready="<id>" and complete grids
   		const s = remap(fromRaw('<id>', 'app', await p.extract('#main')), { 'kpi.<app id>': '<v5 id>' });
   		s.focus.after_nav = nav.focus;
   		s.texts['shell.crumb'] = nav.crumb;
   		return s;
   	},
   	sweeps: { /* one function per v5 sweep id, returning { combo: value } in the v5 encoding */ },
   };
   ```

   - Read the page as a user sees it: routes, the rendered DOM and real clicks (`p.click`, `p.type`, `p.select`), never the database or page data. Your view must set `data-ready="<id>"` on its root, as the pilot's views do.
   - `remap` cannot drop an id. App content without a v5 counterpart stays in the snapshot and shows as app-only.
   - Watch for framework comment nodes (Svelte writes `<!--[-1]-->` markers): the shared extractor ignores them, and custom cell readers must too.
   - `chronology.mjs` shows a hand-built table, an export capture and both sweep kinds.
3. In the register, delete your view's whole-view `not-yet-implemented` entry. The suite fails while a view with an adapter keeps one.
4. Run the view. Fix real differences, and propose a register entry for each intended one (below). Then run `bun run --bun test`, which includes the parity suite.
5. A v5 state the generic adapter does not reach, such as a sub-tab, a dialog or a second mode, belongs in `scripts/parity/adapters/v5/specs.mjs` as a sweep with a `v5` driver. Implement the same sweep id in your app adapter.

When the registry marks a view `available` and no app adapter exists, the run reports an error for that view, and the error is unregistered.

## Register an intended difference

Each entry in `intentional-differences.json` follows `intentional-differences.schema.json`:

| Field | Rule |
| --- | --- |
| `id` | `IDR-<n>`, unique. |
| `view` | A v5 navigation id. |
| `field` | A glob, or a list of globs, over snapshot paths: `*` matches any run of characters and `?` one character. A field of exactly `*` means the whole view is absent and covers only that view-level difference (kind `view-not-implemented`), never a value and never an extraction error. |
| `when` | Optional: `{ "v5": …, "app": … }`, each an exact normalized value, `"<absent>"` or `{ "re": "…" }`. Use it to pin the difference: for example `{ "v5": "nav-link", "app": "heading" }` registers BA-14 focus but not focus lost to the body. A side left out of `when` matches any value. An entry with no `when` covers every difference at the paths its field matches, whatever the two values: a changed value, a value on one side only (`<absent>`) and an order difference alike. The first entry in register order that covers a difference is the one reported. |
| `type` | `improvement`; `defect-fix` (with `source` `S-…`); `data-correction-deferred-to-pipeline`; `not-yet-implemented` (with `owner` `GRS-…`; for a whole view, the owner in the generated view registry, `src/lib/components/view-registry.ts`, which every run checks); or `known-gap`. |
| `source` | The `S-…` source defect, `BA-…` finding or `GRS-…` ticket behind it. |
| `reason`, `productVisible` | Why. `true` puts it on the list of product-visible changes for the user. |
| `author`, `approvedBy`, `approvedOn` | The author proposes the entry with `approvedBy: null`. The coordinator approves by filling both fields. The approver is never the author: the two are compared after NFKC normalization and case folding, with zero-width characters and all spaces, non-breaking ones included, removed. |

- **No case values.** A field names structure and a `when` names UI wording or markers. The validator refuses digit runs of four or more and `@`. Refer to a row by a glob (`table.table_1.row.*.date`), never by its ref.
- **Make entries narrow.** An entry without `when` covers any value of its field, so a later regression in that field would pass unnoticed. Prefer `when`, and keep the field list short.
- **Approval.** Commit proposed entries with the adapter. The coordinator reviews them, sets `approvedBy` and `approvedOn`, and lists the `productVisible` improvements for the user. Proposed entries cover differences in an ordinary run and count under *pending approval*. With `--approved-only` (the gate) they do not.

### Unused entries

An improvement that reverts to v5 behaviour makes the app match v5, so no difference is left to fail. Instead, its register entry covers nothing. Every run lists such entries in `register-usage.json` and counts them in the scorecard. `--strict-register` fails on them. The CC-11 gate should use it together with `--approved-only`.

## Scorecard

`scorecard.json` holds counts only: no path, no value and no case name. `tests/parity/compare.test.ts` checks this.

- `result`, `exit`, `command`, `revision`, `build` (id, revision, root), `clock`, `timezone` and `seconds`.
- `register`: entries, approved, used and unused, and whether `--approved-only` and `--strict-register` were on.
- `isolation`: the offline proof, v5 network and browser-internal request counts, app non-loopback requests, canary hits and whether the fixture tree is unchanged.
- `total`:
  - views, then `viewsExtractedV5`, `viewsComparedApp`, `viewsNotImplemented`, `viewsExtractError` (either side did not extract) and `viewsFailed`;
  - `v5Values`, `appValues`, `compared` and `matched`;
  - `registered` counts by type, `pendingApproval` and `unregistered`.
- `views.<id>`: the same counts per view, its time, and a status. The status is `PASS`, `PASS-with-notes` (only registered differences), `NOT-YET-IMPLEMENTED` or `FAIL`.

## Mutation proof

`tests/parity/mutations.test.ts` plants a synthetic regression in each category and requires an unregistered difference at the expected path, with the register's legitimate entries in force. The categories are filter/sort, calculation, register CRUD, export, navigation/focus and rendered text.

On the real sample, `bun scripts/parity/mutate.mjs --fixture-config .local/v5-verification.json --out .local/parity-mutants` does the same against scratch copies:

- It archives `HEAD`, makes exactly one text replacement, reflinks `node_modules`, builds, and runs `parity --app-root` on the affected views.
- The pilot has no register yet, so register CRUD runs v5 against a scratch copy of the v5 HTML with a planted delete defect. An unmutated copy is the self-parity control and must show no difference.

Results stay in `--out/mutation-proof.json` (local).

## Limits

- The generic v5 adapter reads each view's first state. Sub-tabs, dialogs and modes need a sweep in `specs.mjs`; the view's owner adds it.
- The engine sweep compares the libraries, not the UI. The UI sweep is the behavioural evidence, and the engine sweep adds breadth.
- An entry without `when` masks any later change in its field (see [Make entries narrow](#register-an-intended-difference)).
