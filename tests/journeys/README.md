# Journeys J1 to J10

Ten real-browser journeys that decide whether the app is fast and whole enough to demo. They drive a running app (the local
release candidate, a preview or staging) with Playwright and the pinned Chromium, print one JSON record per journey, and
`run-all.mjs` ends with a PASS/FAIL table with a timing for every step. They import no product module and mock no response.
Nothing case-specific is committed: every case, reference and version id comes from the environment (`.env.example` lists each
variable, with no values).

| Journey | Checks |
|---|---|
| J1 | the shell and every visible navigation entry opens its view, and the step's timer stops only once that view is ready (below) |
| J2 | Overview shows the document count, exactly the three slots (Open deadlines, Unbilled time, Freshness), each filled, visible, with its title and value in rendered, visible text and no error or failure text, and the Dates heading with its date span |
| J3 | one click on a row shows its original in the pane beside the list, timed to the pane (`one-click-row`) and on to the original drawn in it (`one-click-row-original`); one citation click opens its document; at 390 px the eight column headings are visible and do not overlap, and three rows each show their original, each tap timed through the drawn original against the same budgets (the timings are in the `phone-pane-original` step's `taps`). A PDF must draw a visible page 1 with ink on its canvas (GRS-273: the flags once stood over a blank canvas); an email or download-only state must show visible links to the same original's viewer and download, and a local-original state a link to its document page. The phone context's network and page errors count like the desktop's |
| J4 | list, document page and first PDF page for a small, a medium and the largest original: the opened page's own viewer must show a visible, drawn page-1 canvas holding ink (a page marked rendered whose canvas stays blank for a second fails), and its error state fails at once (the local isolated viewer likewise, in a visible frame) |
| J5 | the 24 analysis views: the hosted `analysis-content` wrapper around the view's `main` is visible and says `data-empty="false"`, and the view shows visible domain rows, events, narrative or calculator output, never just any text (Heads: see "Heads entries") |
| J6 | a known-reference search updates `?q=` and shows the matching document link |
| J7 | a document note saves, survives a reload and appears in the case notes list (writes) |
| J8 | a deadline saves, survives a reload and downloads as an ICS event (writes) |
| J9 | a bundle of two synthetic PDFs builds, downloads, saves and still downloads after a reload (writes; needs `pdfinfo` and `pdftotext`) |
| J10 | after an idle (`IDLE_MINUTES`, default 20) the session still navigates and saves, with no 401 or 503 (writes) |

A view is ready (`ready()` in `lib.mjs`, used by every journey that opens one) when its `main[data-ready]` and heading are visible,
nothing in it is loading (`aria-busy="true"`, a loading pane or viewer state), and it shows the content `VIEW_CONTENT` names for
it: domain rows (shown, not an empty, error, placeholder or loading row nor inside a busy region, with at least two shown cells whose text is not a loading phrase or only dashes), its narrative, its timeline events with links, an entry form with working controls, or (a
document page) its original's metadata. A visible error (`role="alert"`, `.error`, an error pane or viewer state), an
unavailable placeholder (`data-unavailable`) or a placeholder phrase fails the step at once.

**Heads entries.** Heads of argument are the lawyer's own entries, and an import supplies none, so a fresh case legitimately
shows the empty state. J5 always requires the add form's fields and its submit button to be usable. `HEADS_EXPECTED=<n>` says
how many entries the case under test holds: with `n` > 0 exactly `n` visible entries and `data-empty="false"`, with 0 the
documented empty state (one empty-state row, no entries, `data-empty="true"`). Unset, either is accepted (no rows with exactly one
empty-state row and `data-empty="true"`, or rows with `data-empty="false"`), so a case whose saved submissions were lost passes
unless `HEADS_EXPECTED` is set; the release-candidate gate sets it.

Budgets, strict `<`: page or action 2,000 ms, first PDF page 3,000 ms, sign-in 5,000 ms (`SIGN_IN_MS`), saves and downloads 2,000 ms, bundle
assembly 5,000 ms (`BUNDLE_MS`). J3's `one-click-row-original` takes the first PDF page budget when the pane shows a PDF and the
action budget otherwise. One sequential pass is not a p95 estimate.

## Run it

This is a self-contained Bun workspace (its own `package.json` and `bun.lock`, as `tests/viewer-evaluation` has; the root gate does
not run it). Install its one dependency, `playwright-core`, once: `(cd tests/journeys && bun install --frozen-lockfile)`.

Local, against a build of the checkout you are in (the app's build revision must equal `git rev-parse HEAD`):

```sh
bun run --bun build   # only if build/ is missing or stale
PORT=41195 CLEARCASE_DATA_DIR=<data dir> bun run --bun start
SMALL_REF=<ref> MEDIUM_REF=<ref> LARGE_REF=<ref> EXPECTED_DOCUMENTS=<count> CLEARCASE_DATA_DIR=<data dir> \
  BASE_URL=http://127.0.0.1:41195 MODE=local IDLE_MINUTES=2 bun tests/journeys/run-all.mjs
PORT=41195 bun run --bun start --stop
```

Hosted (staging or a preview), with a private credentials or storage-state file:

```sh
MODE=hosted BASE_URL=https://<host> CASE_ID=<case> EXPECTED_SHA=<deployed sha> \
  SMALL_REF=<ref> MEDIUM_REF=<ref> LARGE_REF=<ref> EXPECTED_DOCUMENTS=<count> CREDENTIALS_JSON=<private file> bun tests/journeys/run-all.mjs
```

`bun run journeys` replaces `bun tests/journeys/run-all.mjs` once ticket 01 adds the alias. One journey: `bun tests/journeys/J4.mjs`
with the same environment. Results go to `RESULTS_DIR` (default `.local/journeys/results`): `J<n>.json`, `summary.json`, `summary.md`.

### Probes

`probes/` holds offline checks of the journeys themselves: `probes/app.mjs` serves a synthetic hosted app on loopback, and
`bun tests/journeys/probes/run.mjs` runs J1 to J5 through their own entry points against it. On the healthy app each must pass;
on each broken scenario (an audit finding, GRS-266) it must fail at exactly the steps named, and a journey that passes broken
markup prints `FALSE PASS`. `--journeys <dir>` runs another revision's journeys against the same probes, which is how a fix
shows RED before it and GREEN after. Run it under the browser lock like the journeys.

Browsers run under the host's lock: start the command through `orch-bin/browser-lock` on the owner's machine (it exports
`CLEARCASE_BROWSER_SLOT`, which the journeys require), and set `CLEARCASE_BROWSER_LOCK=none` where no workspace lock exists
(`docs/development.md`, "Browser admission").

## Returning-device sign-in (opt-in)

Clerk's Device Trust asks for an email code whenever a password sign-in comes from a browser it has not seen, and every journey
starts a fresh browser, so a timed `sign-in` with credentials normally includes that code step (a `STORAGE_STATE` run starts
already signed in and skips it). A real user meets it once per device.
`SIGN_IN_DEVICE=returning` times the sign-in a returning user sees; unset (or `fresh`) is today's behaviour, byte for byte, and
the budgets do not change.

With `SIGN_IN_DEVICE=returning` the journey, in one browser context:

1. signs in once, untimed: the `sign-in-enrol` step, with the code step, reported as information only (no budget);
2. signs out through the app's own sign-out control and confirms `/cases` answers 401, keeping the Clerk device cookies;
3. times a second sign-in as the `sign-in` step against `SIGN_IN_MS`, unchanged.

If Clerk still asks for the code in step 3, that step runs it and the result says so. In this mode both steps carry
`deviceCodeStep: true|false`; a fresh run does not record it. Every result records `metadata.signInDevice` (`"fresh"` or `"returning"`), and `summary.md` ends with
a `Sign-in device:` line, so the two modes cannot be confused. The mode refuses without `MODE=hosted` and `CREDENTIALS_JSON`.
Space runs at least 45 s apart on a development Clerk instance, which rate-limits sign-ins.

## Refusals and skips

- `MODE=hosted` without `EXPECTED_SHA` (the build revision `/health` must report), `CASE_ID` or `BASE_URL` refuses to run, exit 2.
  A missing `SMALL_REF`, `MEDIUM_REF`, `LARGE_REF` or `EXPECTED_DOCUMENTS` refuses `run-all`; a single journey refuses when it needs one it lacks.
- `READ_ONLY=1` skips J7, J8 and J9. They are reported as `SKIPPED`, never as passed. J10 keeps the idle, navigation and
  document visit and reports its two write steps as skipped; the journey is `PARTIAL`.
- Locally the writes add synthetic notes, deadlines and bundles to the running instance. Export `CLEARCASE_DATA_DIR` to the
  directory the app was started with and a different instance is refused.
- A failed assertion stays a failure. Exit codes: 0 no failure, 1 a failure, 2 refused.

## Environment

| Variable | Meaning |
|---|---|
| `MODE`, `BASE_URL` | `local` (default) or `hosted`; the app origin (default `http://127.0.0.1:41195`) |
| `CASE_ID` | hosted only; routes become `/cases/<CASE_ID>/v/<RESULTS_VERSION>/...` |
| `RESULTS_VERSION` | unescaped; discovered from the first published Overview link when absent |
| `EXPECTED_SHA` | hosted only, required: the revision `/health` must report, checked again at the end of each journey |
| `SMALL_REF`, `MEDIUM_REF`, `LARGE_REF` | the three PDF samples of the case under test, required by J4; `SMALL_REF` also by J6, J7 and J10 |
| `SMALL_BYTES`, `MEDIUM_BYTES`, `LARGE_BYTES` | optional; J4 checks the document page shows that size |
| `SMALL_BUNDLE`, `MEDIUM_BUNDLE`, `LARGE_BUNDLE` | optional bundle (group) button name to open before filtering, where the documents list groups by bundle |
| `SEARCH_REF` | J6's known result; defaults to `SMALL_REF` |
| `EXPECTED_DOCUMENTS` | Required by J2 and `run-all`: the Overview document count of the case under test, so a partial import fails |
| `HEADS_EXPECTED` | optional, J5: the number of Heads entries the case under test holds (0: the empty state); see "Heads entries" |
| `CREDENTIALS_JSON` | private `{email,password,otp?}`; never logged. Without it (or `STORAGE_STATE`) sign-in speed is untested |
| `STORAGE_STATE` | private Playwright storage state carrying an existing Access or app session |
| `SIGN_IN_PATH` | default `/sign-in` |
| `SIGN_IN_MS` | the sign-in budget, default 5000. The shared Clerk development instance is run with 8000 (accepted interim); the release-candidate gate on a production instance uses 5000 (`docs/sprint/runbooks/09c-clerk-instance.md`) |
| `SIGN_IN_DEVICE` | `fresh` (default, unset) or `returning`; see "Returning-device sign-in". Needs `MODE=hosted` and `CREDENTIALS_JSON` |
| `IDLE_MINUTES` | J10's idle, default 20 |
| `READ_ONLY` | `1` skips the write journeys |
| `DEADLINE_DATE`, `BUNDLE_MS`, `RUN_ID` | J8's synthetic date (default `2026-11-04`), J9's bundle budget (5000), the entry-name tag |
| `RESULTS_DIR` | default `.local/journeys/results` |
| `CHROMIUM_PATH` | overrides the pinned `~/.cache/ms-playwright/chromium-1223/...` browser |
| `CLEARCASE_BROWSER_LOCK` | `none` where no workspace lock exists; otherwise start through `orch-bin/browser-lock` |
| `CLEARCASE_DATA_DIR` | the app's data directory; when set in the driver, writes to another instance are refused |

## Selector contract

Each control is found by `data-testid` first and a local fallback second, so the hosted app only has to add the hooks. Keep
`nav[aria-label="Case views"] a[data-view]`, `main[data-ready="<view-id>"]` (set only when the content is usable) and the
accessible headings, buttons and tabs.

| Slice | Hooks (fallback in brackets) |
|---|---|
| Overview | `overview-document-count` [`#count-documents`]; `[data-slot="deadlines"]`, `[data-slot="unbilled-time"]` (value `.num`) and `[data-slot="rescan-freshness"]` (value `#freshness-stamp`), each `[data-slot-status="filled"]` with its `h2` title; the Dates heading and `#date-span` |
| Chronology | `chronology-list` with `.grid-head [role="columnheader"]` headings, `chronology-document-pane` with a matching `data-ref`; in the pane `[data-viewer="pdf"][data-viewer-state="ready"] canvas[data-testid="pdf-page"][data-rendered="true"]` (error `[data-viewer-state="error"]`), `img.pane-image` or a `data-pane-state`, with `a[data-action="open-viewer"]` and `a[data-action="download-original"]` (hosted) or `a[data-action="open-document"]` (local) |
| Documents / PDF | `document-filter` [`#doc-filter`], `open-original` [`#open-original`], `original-metadata` [`#original-state`]; the opened page's `[data-viewer="pdf"][data-viewer-state="ready"] canvas[data-testid="pdf-page"][data-page-number="1"][data-rendered="true"]`, visible, only after a successful draw, error `[data-viewer-state="error"]` [a visible frame's `window.__viewer` with `rendered >= 1`, no `error`, `body[data-ready="1"]` and a visible, non-empty `[data-page="1"][data-rendered="1"] canvas`] |
| Analysis | `analysis-content[data-empty="false"]` around (hosted) or inside (local) the view's `main`, required when hosted; the per-view visible table rows, events, narrative or calculator checks apply in both cases |
| Search | `search-input` [`#sq`], `search-submit` [`#search-run`]; the finished query keeps `?q=<ref>` and shows a document link |
| Notes | `note-body` [`#note-body`], `note-add` [`#note-add`]; `case-notes-list` on `/cases/<caseId>/notes` holds document-note bodies [Overview's notes section] |
| Deadlines | `deadline-title` [`#in-title`], `deadline-date` [`#in-date`], `deadline-note` [`#in-note`], `deadline-save` [`#register-save`], `deadline-export` [`#register-export`]; the saved title in a visible row |
| Bundles | `bundle-build` [`#cb-build`], `bundle-name` [`#cbbname`], `bundle-files` [`#cbbfile`], `bundle-create` [`#cbbrun`], `bundle-download` [`#cbbdownload`], `bundle-save` [`#cbbsave`], `bundle-heading` [`#cb-bundle-h`]; accessible All bundles / Open / View bundle / Download PDF controls |

Add a `data-testid` in the ticket that owns the page, not here.
