# Hosted-demo acceptance journeys — 28 October 2026
Verdict: **FAIL overall: 6 PASS, 4 FAIL**. All ten journeys executed; failed requirements remain executable assertions, with no skips or mocks.
Local app SHA: `1ed4b6342d22ceca64b4f98e6d7363117692144e`; existing build `e2094669bdd34ff2`, Bun 1.4.2, Chromium 148.0.7778.96, 1440×1000. Build identity matched at each journey's start/end. The existing build is stamped dirty; this is research evidence, not a release-gate pass.
Assets: `/home/vaper/Work/Active/MX-two/ClearCase/clearcase/.local/astra/journeys/` contains `lib.mjs`, `J1.mjs`–`J10.mjs`, `run-all.mjs`, and detailed `README.md`.
Final evidence: `journeys/results/{J1…J10}.json`, `summary.json`, `summary.md`, `J8-deadlines.ics`, `J9-bundle.pdf`; run ID `2026-10-28T06-33-33-979Z`. Paths here are relative to `.local/astra/` unless absolute.
Receipt: `.local/agent-receipts/20261028T063327.198752Z-acceptance-journeys-final/receipt.json` is FAIL: the journey command exited 1 and the shared checkout fingerprint changed during the run. HEAD and the served build stayed fixed; tracked diff remained empty, with concurrent untracked `worktrees/` present. This receipt is not a clean-checkout acceptance pass.
Isolation: the copied `journeys/data` opened successfully. Port 41193 belonged to the other agent's originals server; the user approved 41195/41196. Only the isolated copy was mutated. Our app was stopped with `PORT=41195 bun run --bun start --stop`; the other app remains untouched.

Run from the repository root (build first only if missing):
```sh
PORT=41195 CLEARCASE_DATA_DIR="$PWD/.local/astra/journeys/data" bun run --bun start
scripts/agent-tools/receipt --name acceptance-journeys -- /home/vaper/Work/Active/MX-two/ClearCase/orch-bin/browser-lock env BASE_URL=http://127.0.0.1:41195 MODE=local IDLE_MINUTES=2 bun .local/astra/journeys/run-all.mjs
PORT=41195 bun run --bun start --stop
```
For one slice replace `run-all.mjs` with `J<n>.mjs`. Always use the browser lock. Scripts print JSON with PASS/FAIL, timings and network counters; failures return nonzero. The runner continues and writes the summary table. J9 needs installed `pdfinfo` and `pdftotext`; all browser work uses repo Playwright and the prescribed Chromium path.
Method: action start → asserted visible target → two animation frames. PDF timing includes click, viewer navigation and completed first-page canvas draw. Fresh context per journey; local routing blocks external requests and disables HTTP cache, while app/disk caches are warm. One sequential pass, not a p95 estimate or hosted benchmark.
Budgets: pages <2,000 ms, first PDF page <3,000 ms, sign-in <5,000 ms. Saves/downloads use a provisional 2,000 ms interaction budget; bundle assembly uses a provisional 5,000 ms budget. No measured action exceeded its budget.

| Journey | Assertions and verdict | Final local timings, ms |
|---|---|---|
| J1 | PASS: shell and all 42 visible navigation entries open the expected view, without error/placeholder. | Shell 126; navigation 45–383. |
| J2 | PASS: Overview has 1,689 documents, filled slots and Dates. | 176. |
| J3 | FAIL: one citation click opens its matching document; split pane absent, so list/document are not simultaneously visible. | Chronology 407; citation 92. |
| J4 | PASS: list → document → rendered first original PDF page for all three baseline size bands; original sizes checked. | Small list/doc/PDF 115/102/250; medium 95/76/267; largest 95/69/2,183. |
| J5 | FAIL: 23/24 analysis views contain populated data/narrative; Heads of Argument has no populated rows. Includes Matter & Strategy, contradictions, risk, people/entities, litigation and quantum. | 76–150 across 24 views. |
| J6 | PASS: known-reference search updates the query URL and displays the matching document link. | Search page 116; result 88. |
| J7 | FAIL: document note saves and survives reload; its body is absent from case-wide notes. Local Overview exposes only counts/ref summaries. | Document 131; save 94; reload 83; list check 86. |
| J8 | PASS: deadline saves, survives reload and downloads as an ICS event with the exact synthetic title/date. | Page 102; save 101; reload 83; download 67. |
| J9 | FAIL: builds/downloads a valid 3-page PDF containing both synthetic sources, saves its list entry, then loses the assembled PDF after reload. | Page 249; build 93; download 66; save 252; list reload 206. |
| J10 | PASS locally: genuinely idle 120,001 ms, then navigate, save a note and reload; no 401/503. This does not test hosted session expiry. | Before idle 115; chronology 394; document 117; save 106; reload 84. |

PDF sizes: 9,260 / 197,497 / 258,590,305 bytes, using the baseline's smallest/median/largest mapped PDF refs. J9 downloaded 4,206 bytes. No case content is quoted here.
Network: 1,843 browser responses; **zero 4xx, 5xx, 401, 503, failed requests or uncaught page errors**. API health probes are checked separately. No hosted sign-in, staging run, 20-minute hosted idle, mobile run or release p95 claim was tested.

Environment: `BASE_URL` (default local 41195), `MODE=local|hosted`, `RESULTS_VERSION` (unescaped; otherwise discovered), `CASE_ID` (hosted), `EXPECTED_SHA` (required hosted `/health` build revision), `RESULTS_DIR` (default `journeys/results`), `IDLE_MINUTES` (default 20), `READ_ONLY=1` (refuses write journeys).
Authentication: optional `CREDENTIALS_JSON` points to private JSON `{email,password,otp?}`; credentials are never logged. `SIGN_IN_PATH` defaults to `/sign-in`; optional `STORAGE_STATE` supplies an existing Access/app session. Without credentials, sign-in latency is explicitly untested. Unsupported MFA requires private session preparation.
Fixture options: `EXPECTED_DOCUMENTS=1689`, `SMALL_REF`, `MEDIUM_REF`, `LARGE_REF`, `SEARCH_REF`, `DEADLINE_DATE=2026-11-04`, `BUNDLE_MS=5000`, optional standalone `RUN_ID`. Reference overrides disable baseline byte-size checks; validate replacement samples separately. J9 generates synthetic PDFs locally.

Hosted selector contract (add `data-testid` hooks below; exact fallback mapping is in `journeys/README.md`):
- Preserve `nav[aria-label="Case views"] a[data-view]`, view-ready `main[data-ready="<view-id>"]`, accessible headings/buttons/tabs and real document-result links. Set readiness only when content is usable.
- Overview: `overview-document-count`; retain populated `[data-slot][data-slot-status="filled"]` and the Dates heading.
- Chronology: `chronology-list`, `chronology-document-pane` with matching `data-ref`, displayed side by side after one citation click. These hooks/features are absent locally.
- Documents/PDF: `document-filter`, `open-original`, `original-metadata`; `pdf-page[data-page-number="1"][data-rendered="true"]` only after successful draw. Local fallback observes `window.__viewer.rendered` and a nonzero canvas.
- Analysis: `analysis-content[data-empty="false"]` around actual visible data/narrative, never a shell or placeholder; replaces local table/narrative-specific fallbacks.
- Search: `search-input`, `search-submit`; completed query retains `?q=<reference>` and the matching document link.
- Notes: `note-body`, `note-add`, `case-notes-list` containing document-note bodies at `/cases/<caseId>/notes`.
- Deadlines: `deadline-title`, `deadline-date`, `deadline-note`, `deadline-save`, `deadline-export`; retain the exact saved title in its visible row.
- Bundles: `bundle-build`, `bundle-name`, `bundle-files`, `bundle-create`, `bundle-download`, `bundle-save`, `bundle-heading`; retain accessible All bundles / row Open / View bundle / Download PDF controls and the saved name.

Staging: publish the same v5 version and all originals, provision an editor plus Access authentication, implement the route/hook contract, and set `MODE=hosted BASE_URL=https://<staging-or-preview> CASE_ID=... RESULTS_VERSION=... EXPECTED_SHA=...` with private credentials/storage state. The route builder changes `/v/<rv>/...` to `/cases/<caseId>/v/<rv>/...`; no script rewrite is needed. Switching compatible hosted targets then changes BASE_URL and the deployed SHA.
Before release, run with `IDLE_MINUTES=20`, verify sign-in with a fresh app session, and repeat timed runs from the South African demo network to establish p95. Hosted auth/selectors are designed but not proven here. Product code, commits and deployments were unchanged; synthetic notes, deadlines and bundle entries remain only in the isolated copy.
