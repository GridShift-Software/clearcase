# Parity harness: v5 versus the app, view by view

The harness shows that the app **behaves like** the v5 sample on the same input, not only that it holds the same data. For each of the 42 v5 views it renders the v5 workspace and the app with one fixed clock, reads what each shows through the UI, normalizes both into one snapshot shape and compares them value by value. Every intended difference is on the [intentional-differences register](intentional-differences.json) or one of its per-owner [fragments](register/); a registered difference passes with a note, and only an unregistered difference fails.

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
| `--fixture-config FILE` | The local fixture locator (`.local/v5-verification.json`, the same file `verify:pilot:v5` uses). It stays local by design, since it names the case material. Its main HTML and expected-examples hashes are checked against the committed profile, and the scorecard records the fixture identity the run used (`fixture`, below). |
| `--out DIR` | Output directory, inside `.local/` or outside the repository. See [The output directory](#the-output-directory). |
| `--clock ISO`, `--timezone TZ` | The fixed clock (default `2026-10-08T09:00:00Z`) and timezone (default `UTC`) for both sides. |
| `--approved-only` | Only approved register entries cover differences. No gate passes it: `bun run --bun gate` runs `--all --strict-register`. |
| `--strict-register` | Fail when a register entry covered nothing in the views run (see [Unused entries](#unused-entries)). |
| `--no-sweeps`, `--no-exports` | Skip the interaction sweeps or the export capture (quick checks while writing an adapter). Such a run is not evidence. |
| `--keep-work` | Keep this run's working directory `DIR/.work-<pid>-XXXXXX` (the converted package, the server's data and log, the browser profile: case-bearing, local only) instead of removing it on exit. Later runs never sweep a kept directory: remove it by hand. |
| `--keep-snapshots` | Also write both sides' full snapshots per view (`views/<view>.snapshots.json`). |
| `--app-root DIR` | Use another checkout's build and modules (the mutation proof). |
| `--app-v5-html FILE` | Self-parity: the app side is the v5 adapter on another copy of the v5 HTML. |
| `--allow-stale-build` | Run on a stale build (below) anyway. The scorecard then says `evidence: false` and why, and the final status line says `NOT EVIDENCE`. There is no environment form: an exported `CLEARCASE_ALLOW_STALE_BUILD` does nothing. |

**Fresh-build evidence.** The runner records the build stamp (`build/clearcase-build.json`: the revision the build was made from and whether files were modified or untracked then), HEAD, and whether files are modified or untracked now (as the stamp counts them: a new file that was never `git add`ed counts, and only the committed `.gitignore` files may hide one). In the build inputs (`src`, `scripts`, `tests`, `static`, `docs/reference/parity`, the docs files the runners read and every root file), a file that only `.git/info/exclude` or a global ignore file hides, or that an untracked self-ignoring `.gitignore` hides, counts as untracked, so an editor swap file under `src/` makes the tree dirty. If the build is not HEAD's, is not this repository's own `build/` (an `--app-root` build never is, nor an `--app-root` tree whose `build/` links to it), or either tree is dirty, or git cannot read HEAD or the working-tree state (an unreadable index, say), or the repository is not git's top level, or tracked files are flagged assume-unchanged or skip-worktree (git runs without `GIT_*` variables, without an fsmonitor hook or the untracked cache, and lists untracked files whatever its config says), or the stamp does not parse or does not say whether its tree was dirty, it refuses with exit 2 before it goes offline, reads the locator or writes anything. A build made in a copy inside the worktree (say under `.local/`) is stamped with no revision, since git there describes the enclosing worktree. Commit, then build in the repository itself, then run. With `--allow-stale-build` it runs, and `scorecard.json` has `evidence: false`, `evidenceNote` and `freshBuild` (the reasons); `scorecard.md` says so in its second line, and the final status line says `NOT EVIDENCE`. The flag makes a run non-evidence even on a fresh build. `mutate.mjs` passes the flag to its own runs, since a mutant is by design not HEAD's build, and stamps each mutant build `mutant:<id>@<HEAD>`, so its scorecard says `evidence: false`. The same rule, in `tests/e2e/pilot/lib/fresh-build.ts`, guards `test:e2e` and `measure`.

**Committed review inputs.** A waiver counts only when the reviewed commit holds it. A clean `git status` does not show that: a committed `.gitignore` can hide a file the runner still reads (anything under `.local/`, at any depth, including `docs/reference/parity/.local/`). So every file the runner reads by name must be a committed review input (`uncommittedInputs` in `fresh-build.ts`):
- The path as given and its realpath both lie in the repository and in the input's folder (`docs/reference/parity/` for register files).
- git's index tracks both, git shows no change to either (staged or not), and neither is flagged assume-unchanged or skip-worktree.
- The bytes the runner read are HEAD's blob at the path as given. They are hashed as git hashes a blob, with no filters.

git's index is not trusted for the contents. A clean filter or a restored mtime can leave `git status` clean after an edit, and a symlink can stand in for a committed file elsewhere. A checkout that converts line endings (`core.autocrlf`) reads bytes other than HEAD's blob, so evidence runs need a checkout without conversion; this repository has no `.gitattributes`. That covers every register file the run read: the main file, the `--register FILE` and each fragment in its `register/` folder. It also covers every module the loaders find by listing a folder: app adapters, v5 specs and slot plug-ins (`scripts/parity/lib/modules.mjs`, one listing rule for all three loaders). The run checks the modules listed when it ends and every module it imported, so one that deleted itself once imported is still named. A run that reads any other file records `evidence: false`, whatever its build and exit code. Its `evidenceNote` names each file and gives why. The file may be ignored, untracked, modified or hidden from git. It may lie outside the checkout or its folder, or resolve somewhere else. Its bytes may not be HEAD's. A run is also non-evidence when it has `--register FILE` outside `docs/reference/parity/` or `--app-v5-html` (self-parity), or when it compares less than the gate: `--no-sweeps`, `--no-exports` or `PARITY_MAX_COMBOS`. `test:e2e` holds the suites it runs by file name to the same rule, and is non-evidence under its development knobs (`E2E_ONLY`, `E2E_STOP_AFTER`, `E2E_LATENCY_SIZES_MIB`, `CLEARCASE_E2E_TMP`). `CLEARCASE_E2E_TMP` moves the durability suite's files off `<worktree>/.local/tmp`, which is disk-backed on purpose. Its path alone would not show whether the new place behaves like that disk, so a run with it set is not evidence. `measure` holds its `ccNN.mjs` runner to the same rule.

**Deliberately local inputs.** Some inputs stay outside Git by design, and the record names what they were:
- The fixture locator and the case material it names. The committed profile pins the main HTML and the expected examples. The package must carry the locator's accepted `resultsVersion`; otherwise setup fails. The scorecard records both identities.
- The installed dependencies. These come from the committed `bun.lock` through `bun install --frozen-lockfile`.
- Bun and Chromium (`CLEARCASE_CHROMIUM`). `test:e2e` records both.
- Output and port settings: `--out`, `CLEARCASE_REPORT_DIR`, `CLEARCASE_E2E_OUT`, `CANARY_PORT`, `E2E_NETCHECK_PORT`.
- `PARITY_TRACE`, which only logs.

`--clock`, `--timezone`, `--view`, `--approved-only` and `--strict-register` are recorded in the scorecard.

Exit codes: **0** no unregistered difference; **1** at least one unregistered difference, a view that did not extract on either side (an app adapter that threw, an available view without one, and an available view whose adapter returns any status but `ok` included; the register never covers it), an unused register entry under `--strict-register`, or any isolation breach: a v5 network request, an app request that is not loopback, a canary hit other than a browser service, or a changed fixture tree; **2** setup error (arguments, locator, register, an `--out` overlapping the fixture or holding a symlink or hard link where the runner writes, build, conversion, import, the offline proof, or a stale build without `--allow-stale-build`). The register is checked first, before the runner re-executes offline or reads the locator, and a whole-view entry whose owner is not the view registry's owner is a register error.

A full run takes about 100 seconds on this host, most of it the chronology sweeps.

### The output directory

The runner never writes or deletes inside the read-only fixture. Before it creates, removes or writes anything:

- **Overlap.** `--out` must not overlap a read-only input in either direction. The inputs are the case folder; the v5 main HTML, the bundles-only HTML, the expected examples, the inventory, the summary and the source archive (`archive.path`), each with its folder; the locator's `fixtureRoot` when it gives one (then anything under it is refused); a reused package; and an `--app-v5-html` copy (the file only, because the mutation proof writes that copy beside its output). Paths are compared by realpath: symlinks, aliases and dangling links are followed, a dangling relative link resolved against the real folder that holds it. The check runs twice: on the raw locator, path only, before the locator's hashes are checked, and again on the loaded locator.
- **No link below the output.** Every path the runner writes below `--out` (`views/`, `views/<view>.json`, `views/<view>.snapshots.json`, the scorecards, `register-usage.json`, `v5-requests.json`, `canary-hits.json`) must resolve to itself. A symlink at or above it inside the output, dangling or not, is refused, and so is an existing file with more than one hard link. The known children are checked up front, and each write is checked again.
- Either refusal is a setup error (exit 2), and nothing in the output or the fixture changes.

Each run works in a fresh `DIR/.work-<pid>-XXXXXX` (`mkdtemp`), so an existing `DIR/.work` or any other entry is left alone. It holds the converted, case-bearing package, the server's data and the browser profile. It is removed on every exit, a setup error included, and on SIGINT, SIGTERM and SIGHUP, after which the runner exits 130, 143 or 129 (the browser and server it started are killed by their own exit handlers). `--keep-work` keeps it. SIGKILL cannot be handled, so a run killed that way leaves its working directory behind. On creation each run writes a marker, `.parity-work.json`, into its working directory: `{"tool": "clearcase-parity", "pid", "startedAt", "keep"}`, plus `pidStartTime` (field 22 of `/proc/<pid>/stat`) where it can be read. The next run in the same `--out` sweeps such leftovers after the checks above, recognising them by that marker and never by name alone. It removes an entry directly in `--out` only when it is a real directory (never a symlink) named `.work-<pid>-XXXXXX`, holding a marker that parses, names this tool, records `keep: false` and the same pid as the name, and that process is gone or has a different start time (its pid was reused). Anything else stays: a directory of your own, even one named like `.work-backup`; an unmarked or unparsable one; one kept with `--keep-work` (`keep: true`), which you remove by hand; and a live run's. The outer process that re-executes the runner under `unshare` does not forward signals: a signal sent to it alone does not reach the runner inside the namespace.

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
| `register-usage.json` | Register entry ids that covered something, the unused ones, and `files`: each entry's register file. | Ids and repository paths only. |
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
- **Overview**: `seeded_user_work`, the tiles with synthetic deadlines and timesheet rows relative to the clock. The app adapter reads the same seven tiles under v5's labels; it seeds nothing until the app has deadline and timesheet registers (GRS-17), so the two tiles those registers fill are registered as not yet implemented and the other five are compared like the unseeded tiles.

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
3. In your register fragment, `register/CC-NN.json`, delete your view's whole-view `not-yet-implemented` entry. The suite fails while a view with an adapter keeps one.
4. Run the view. Fix real differences, and propose a register entry for each intended one (below). Then run `bun run --bun test`, which includes the parity suite.
5. A v5 state the generic adapter does not reach, such as a sub-tab, a dialog or a second mode, belongs in your view's own spec module, `scripts/parity/adapters/v5/specs/<view-id>.mjs`, as a sweep with a `v5` driver. Implement the same sweep id in your app adapter.
6. A sweep that ends on the overview tiles, as v5's `register_edit` does (`overview.<v5 tile label>` = the tile's value), reads the app's tiles with `readOverviewTiles(p, ctx)` from `_shell.mjs`. It opens the overview and returns `{ '<v5 tile label>': {value, sub} }` for the seven tiles (`Documents indexed`, `Amount due (to date)`, `Invoices`, `Open deadlines`, `Unbilled time`, `Contradiction flags`, `Scanned (need OCR)`), slot plug-ins included. Use the `value`s.

### Overview slot plug-ins

The overview's widget slots stand where v5 shows the `Open deadlines` and `Unbilled time` tiles and the freshness card. The overview adapter (`overview.mjs`, CC-03's) does not change when a slot fills. Instead the slot's owner adds one module, `scripts/parity/adapters/app/slots/<slot-id>.mjs`: CC-07 adds `deadlines.mjs` and `unbilled-time.mjs`, CC-10 adds `rescan-freshness.mjs`.

```js
export default {
	/** The overview is open and the slot is filled: read it, without navigating, as v5's tile reads. */
	async read(p, ctx) { return { value: '…', sub: '…' }; },
	/** Enter the rows this slot needs from `rows` = seededUserWork(ctx.clock), through the owner's own UI. */
	async seed(p, ctx, rows) {},
	/** Remove every row seed entered, and check the register is empty again. */
	async cleanup(p, ctx) {},
};
```

- `readOverviewSnapshot` and `readOverviewTiles` call `read` only for a slot whose `data-slot-status` is `filled`. A tile slot's result becomes `kpi.open_deadlines` or `kpi.unbilled_time` as `{value, sub}`. The freshness slot's becomes `text.freshness.1`, plus `text.freshness.2` when `sub` is not empty. After each `read` the page must still be the overview (`read` must not navigate). A filled slot without a plug-in is an error. An unfilled slot is read as before: its wording as the value and an empty caption.
- The overview's `seeded_user_work` sweep, when plug-ins exist, reads the tiles, calls every plug-in's `seed` in slot order, reads the tiles, then calls every `cleanup` in reverse order, each in its own try and also when the read fails, rethrows the first error, and reads the tiles again: they must equal the first reading, or the sweep fails. With no plug-in nothing is seeded and its output is unchanged.
- The app keeps user work for the whole run while v5 starts each sweep with empty storage, so `cleanup` must leave nothing behind.
- A file name that is not a declared slot (`OVERVIEW_SLOTS`), or a module without the three functions, is an error. Files starting with `_` are skipped. Named exports work too.
- When your slot fills, delete its `not-yet-implemented` entries from your fragment: IDR-050 and IDR-067 (CC-07), IDR-051 and IDR-068 (CC-10).
- `tests/parity/slot-plugins.test.ts` covers the tiles, the sweep and the loader with a fake plug-in.

### Per-view v5 specs

`specs.mjs` keeps the overview and chronology specs. Every other view's spec is a module of its own, `specs/<view-id>.mjs`, whose default export has the shape of one `SPECS` entry: `{ key?, postRaw?, storage?, sweeps? }`, each sweep `{ id, v5 }` with `v5` an async driver returning `{ comboKey: value }`. `loadSpecs()` finds the modules by dynamic import over the folder, in file-name order, so no owner edits `specs.mjs`. A module may import helpers such as `registerSweep` from `../specs.mjs` or `../../../lib/*.mjs`, and files starting with `_` are skipped, so shared helpers can live there. A file name that is not a v5 navigation id, a view whose spec stays in `specs.mjs`, an unknown key or a sweep without a `v5` function is an error; the v5 adapter then fails every view, so the run fails. `tests/parity/specs.test.ts` covers discovery.

When the registry marks a view `available`, or its owner route (`src/routes/v/[vid]/<category>/<view-id>/+page.svelte`) exists in the app tree, and no app adapter exists, or its adapter returns any status but `ok` (`not-implemented` included), the run reports an extraction error for that view, and the error is unregistered: its whole-view `*` entry does not cover it. The route check is `implementedViews` from `tests/e2e/pilot/lib/implemented.mjs`, the pilot's own; the registry status flips only after the owner's gate.

## Register an intended difference

The register is `intentional-differences.json` plus one fragment per M2 owner in `register/` (see [Fragments](#fragments)). Each entry follows `intentional-differences.schema.json`:

| Field | Rule |
| --- | --- |
| `id` | `IDR-<n>`, unique across the main file and every fragment. A fragment's new ids lie in its owner's range. |
| `view` | A v5 navigation id. |
| `field` | A glob, or a list of globs, over snapshot paths: `*` matches any run of characters and `?` one character. A field of exactly `*` means the whole view is absent and covers only that view-level difference (kind `view-not-implemented`), never a value and never an extraction error. It must be exactly the string `*`: any other field that would match the path `*` (`?`, `**`, `*?`, `["*"]`, …) is refused by the validator, and no other field covers a whole view. An empty list, `[]`, is a source-defect disposition: see [Dispositions](#source-defect-dispositions). |
| `when` | Optional: `{ "v5": …, "app": … }`, each an exact normalized value, `"<absent>"` or `{ "re": "…" }`. Use it to pin the difference: for example `{ "v5": "nav-link", "app": "heading" }` registers BA-14 focus but not focus lost to the body. `relation` names a condition between the two values that no pin can state (`app-is-v5-without-ellipsis`: the app value is v5's minus its trailing `…`, normalized again because the ellipsis kept white space before it and stopped the number and date rules, so a short excerpt is waived only against its own text). A side left out of `when` matches any value. An entry with no `when` covers every difference at the paths its field matches, whatever the two values: a changed value, a value on one side only (`<absent>`) and an order difference alike. The first entry in register order that covers a difference is the one reported. |
| `type` | `improvement`; `defect-fix` (with `source` `S-…`); `data-correction-deferred-to-pipeline`; `not-yet-implemented` (with `owner` `GRS-…`; for a whole view, the owner in the generated view registry, `src/lib/components/view-registry.ts`, which every run checks); or `known-gap`. |
| `source` | The `S-…` source defect, `BA-…` finding or `GRS-…` ticket behind it. |
| `reason`, `productVisible` | Why. `true` puts it on the list of product-visible changes for the user. |
| `author`, `approvedBy`, `approvedOn` | The author proposes the entry with `approvedBy: null`. For an entry with `productVisible: false` the coordinator approves by filling both fields; for any other entry (a missing or non-boolean `productVisible` counts as visible) only the user does, in a PR or on GitHub, and the workspace pre-push hook refuses an agent's push that approves one. The approver is never the author: the two are compared after NFKC normalization and case folding, with zero-width characters and all spaces, non-breaking ones included, removed. |

- **No case values.** A field names structure and a `when` names UI wording or markers. The validator refuses digit runs of four or more and `@`. Refer to a row by a glob (`table.table_1.row.*.date`), never by its ref.
- **Make entries narrow.** An entry without `when` covers any value of its field, so a later regression in that field would pass unnoticed. Prefer `when`, and keep the field list short.
- **Approval.** Commit proposed entries with the adapter. The coordinator reviews them, sets `approvedBy` and `approvedOn` on the entries that are not product-visible, and lists the `productVisible` improvements for the user, who approves them. Proposed entries cover differences in an ordinary run and count under *pending approval*. With `--approved-only` they do not; the gate does not pass it. Approval pages for the user are under [`approvals/`](approvals/).

### Fragments

Parallel M2 owners do not edit the main file. Owner CC-NN keeps its entries in `register/CC-NN.json`, which has the main file's shape and schema (`"$schema": "../intentional-differences.schema.json"`). The runner loads the main file first, then the fragments by file name, as one register; `--register FILE` reads `FILE` and the fragments in `FILE`'s folder's `register/`. Every rule above applies to every file, and the validator adds these:

- A fragment is named after an M2 owner, `CC-04.json` to `CC-10.json`; any other `.json` in `register/` is an error.
- A new id lies in its owner's range: CC-04 `IDR-100`–`IDR-149` and `500`–`509` (a second range, added in GRS-183 when the first ran out; IDR-100, 106, 116, 124 and 134 in the first are retired), CC-05 `150`–`199`, CC-06 `200`–`249` and `450`–`474` (a second range, added in GRS-173; IDR-236 in the first is retired, not reused), CC-07 `250`–`299`, CC-08 `300`–`349`, CC-09 `350`–`399`, CC-10 `400`–`449`. A fragment also keeps the legacy ids moved into it from the main file (`LEGACY` in `scripts/parity/lib/register.mjs`). The main file may use no owner's range. The validator rejects every id in `RETIRED`, including IDR-236 and the Q5 retirements; the disposition generator uses the same set and allocates through an owner's ranges in order.
- A whole-view entry (field `*`) in a fragment is for one of its owner's views in the view registry, and, as everywhere, a `not-yet-implemented` one names that view's Linear owner.
- A fragment's problems are reported with its file name. `register-usage.json` gives each entry's file under `files`.

The main file keeps the pilot views' entries (overview and chronology) that no M2 ticket owns. Each owner's whole-view `not-yet-implemented` entries moved into its fragment with their ids, and so did the overview slot entries: IDR-050 and IDR-067 (GRS-17) into `CC-07.json`, IDR-051 and IDR-068 (GRS-20) into `CC-10.json`. A fragment entry is for one of its owner's views or names its owner as `owner`. A fragment holds any subset of its owner's moved ids plus new ids in its range. The slot entries are present exactly while their slots are unfilled: once the tree fills `deadlines` or `unbilled-time`, IDR-050 and IDR-067 must be gone (and IDR-051 and IDR-068 once it fills `rescan-freshness`); register what still differs under new ids. `tests/parity/fragments.test.ts` covers loading and the rules.

### Source-defect dispositions

Every v5 source defect in `docs/reference/defects.md` and `docs/reference/view-checklist.md` has an entry that names it (`scripts/verify/dispositions.mjs` checks this). Many defects show no difference on any compared path. Some are fixed where parity does not look, some are reproduced, and some are in the imported data. Such a defect gets a disposition, an entry with `"field": []`, which covers no difference and is never unused. A disposition has an `S-…` `source`, no `when`, and the type `defect-fix`, `known-gap` or `data-correction-deferred-to-pipeline`. Its reason says what ClearCase does, with the evidence and the covering entry where parity sees the change. A disposition is `defect-fix` only when no part of the defect remains. A defect ClearCase fixes in part, or reproduces, is `known-gap` with an `owner` (the Linear issue whose app change would close it). An entry that covers a difference (a non-empty `field`) types that difference, so it can be a `defect-fix` for the value the app corrects while the disposition of the same defect is `data-correction-deferred-to-pipeline`, because the imported source stays wrong (S-meta-counts: IDR-049 and IDR-074).

`scripts/verify/register-dispositions.mjs` writes them (GRS-67): change its table, rerun it, and commit the register. A rerun keeps the `approvedBy` and `approvedOn` the user set. `--check` also fails when a listed defect has no entry naming it, a disposition names a defect that is no longer listed, or an evidence pattern is empty.

### Unused entries

An improvement that reverts to v5 behaviour makes the app match v5, so no difference is left to fail. Instead, its register entry covers nothing. Every run lists such entries in `register-usage.json` and counts them in the scorecard. `--strict-register` fails on them, and `bun run --bun gate` passes it (with `--all`, not `--approved-only`).

## Scorecard

`scorecard.json` holds counts only: no path, no value and no case name. `tests/parity/compare.test.ts` checks this.

- `result`, `exit`, `command`, `revision`, `build` (id, revision, root), `clock`, `timezone` and `seconds`.
- `evidence` and `freshBuild`. `evidence` is false unless all of these hold:
  - the build is a fresh build of clean HEAD;
  - every register file and listed module the run read is committed;
  - the register is the repository's;
  - the app side is the app;
  - the run compared everything the gate compares.

  `freshBuild` holds the build revision and dirtiness, HEAD, whether tracked files are modified, the reasons, and whether `--allow-stale-build` was given. When the run is not evidence, `evidenceNote` gives the reasons.
- `fixture`, the fixture identity the verdict is about:
  - `acceptedResultsVersion`: the identity the package must carry. This is GRS-38's view-content identity when the converter emits view-content.
  - `baseResultsVersion`: GRS-10's identity.
  - `diagnosticsSha256`.
  - `packageResultsVersion`: the converted or reused package's own identity, and `packageReused`.
  - `sha256`: the hashes of the main HTML, the expected examples, the inventory, the v5 summary and the archive.
  - `profile`: the committed profile that pins the main HTML and the expected examples.

  `scorecard.md` repeats the package and accepted identities and the pinned hashes in its `Fixture:` line.
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
- Before it creates, removes (`<out>/<id>` is recreated for each mutant) or writes anything, it checks `--out` like the runner: no overlap with an input the locator names, and no symlink or hard link at `<out>/<id>`, `<out>/<id>/src`, `<out>/<id>/v5-copy.html` or `mutation-proof.json`. `--out` must also lie inside `.local/` with symlinks resolved. A refusal exits 2.

Results stay in `--out/mutation-proof.json` (local).

## Limits

- The output checks compare realpaths. A bind mount of the fixture elsewhere is not visible to realpath and is not detected, and a symlink swapped in between a check and the write that follows it (a race) is not guarded.

- The generic v5 adapter reads each view's first state. Sub-tabs, dialogs and modes need a sweep in `specs/<view-id>.mjs`; the view's owner adds it.
- The engine sweep compares the libraries, not the UI. The UI sweep is the behavioural evidence, and the engine sweep adds breadth.
- An entry without `when` masks any later change in its field (see [Make entries narrow](#register-an-intended-difference)).
