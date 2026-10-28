# Journeys J1 to J10

Ten real-browser journeys that decide whether the app is fast and whole enough to demo. They drive a running app (the local
release candidate, a preview or staging) with Playwright and the pinned Chromium, print one JSON record per journey, and
`run-all.mjs` ends with a PASS/FAIL table with a timing for every step. They import no product module and mock no response.
Nothing case-specific is committed: every case, reference and version id comes from the environment (`.env.example` lists each
variable, with no values).

| Journey | Checks |
|---|---|
| J1 | the shell and every visible navigation entry opens its view without an error or placeholder |
| J2 | Overview shows the document count, filled slots and the Dates heading |
| J3 | one citation click opens its document; the list and the document are side by side |
| J4 | list, document page and first PDF page for a small, a medium and the largest original |
| J5 | the 24 analysis views hold populated data or narrative |
| J6 | a known-reference search updates `?q=` and shows the matching document link |
| J7 | a document note saves, survives a reload and appears in the case notes list (writes) |
| J8 | a deadline saves, survives a reload and downloads as an ICS event (writes) |
| J9 | a bundle of two synthetic PDFs builds, downloads, saves and still downloads after a reload (writes; needs `pdfinfo` and `pdftotext`) |
| J10 | after an idle (`IDLE_MINUTES`, default 20) the session still navigates and saves, with no 401 or 503 (writes) |

Budgets, strict `<`: page or action 2,000 ms, first PDF page 3,000 ms, sign-in 5,000 ms, saves and downloads 2,000 ms, bundle
assembly 5,000 ms (`BUNDLE_MS`). One sequential pass is not a p95 estimate.

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

Browsers run under the host's lock: start the command through `orch-bin/browser-lock` on the owner's machine (it exports
`CLEARCASE_BROWSER_SLOT`, which the journeys require), and set `CLEARCASE_BROWSER_LOCK=none` where no workspace lock exists
(`docs/development.md`, "Browser admission").

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
| `CREDENTIALS_JSON` | private `{email,password,otp?}`; never logged. Without it (or `STORAGE_STATE`) sign-in speed is untested |
| `STORAGE_STATE` | private Playwright storage state carrying an existing Access or app session |
| `SIGN_IN_PATH` | default `/sign-in` |
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
| Overview | `overview-document-count` [`#count-documents`]; `[data-slot][data-slot-status="filled"]`; the Dates heading |
| Chronology | `chronology-list`, `chronology-document-pane` with a matching `data-ref`, side by side after one citation click |
| Documents / PDF | `document-filter` [`#doc-filter`], `open-original` [`#open-original`], `original-metadata` [`#original-state`]; `pdf-page[data-page-number="1"][data-rendered="true"]` only after a successful draw [`window.__viewer.rendered` and a non-empty canvas] |
| Analysis | `analysis-content[data-empty="false"]` around visible data or narrative, never a shell or placeholder [per-view table, narrative or calculator checks] |
| Search | `search-input` [`#sq`], `search-submit` [`#search-run`]; the finished query keeps `?q=<ref>` and shows a document link |
| Notes | `note-body` [`#note-body`], `note-add` [`#note-add`]; `case-notes-list` on `/cases/<caseId>/notes` holds document-note bodies [Overview's notes section] |
| Deadlines | `deadline-title` [`#in-title`], `deadline-date` [`#in-date`], `deadline-note` [`#in-note`], `deadline-save` [`#register-save`], `deadline-export` [`#register-export`]; the saved title in a visible row |
| Bundles | `bundle-build` [`#cb-build`], `bundle-name` [`#cbbname`], `bundle-files` [`#cbbfile`], `bundle-create` [`#cbbrun`], `bundle-download` [`#cbbdownload`], `bundle-save` [`#cbbsave`], `bundle-heading` [`#cb-bundle-h`]; accessible All bundles / Open / View bundle / Download PDF controls |

Add a `data-testid` in the ticket that owns the page, not here.
