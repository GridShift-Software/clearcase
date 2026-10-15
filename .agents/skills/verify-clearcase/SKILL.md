---
name: verify-clearcase
description: "Drive the real ClearCase local pilot (SvelteKit web UI under Bun, plus its separate originals site) offline in headless Chromium and keep screenshot evidence. It builds an exact revision in isolation, boots scripts/pilot/start.ts in a network namespace with only lo, proves the instance with a live doctor, then imports a synthetic case through the UI, validates, previews, activates, checks the overview widgets, opens the chronology, follows a citation, opens the cited PDF in the originals viewer, walks the 42-view navigation and runs the owners' feature steps (manual, rescan, backup and restore). Use it to prove a pilot change works in the real app, before an acceptance claim, or when M2 views need a user-path proof."
---

# verify-clearcase

The pilot's surface is a web UI at `http://127.0.0.1:<PORT>` (case list, import, validation report, preview and activation, overview, chronology, document detail and the 42 registry views) and a second site, `http://clearcase-originals.localhost:<PORT+1>`, that serves originals and the sandboxed pdf.js viewer. This skill drives both the way a user does. Everything runs from one executable runner; never run this file as a command.

Synthetic data only. The runner builds its case with `tests/e2e/pilot/lib/fixtures.ts` (`buildCase`, GRS-10's own converter, invented names). Never point it at case material, `RAWS/` or the hosted system.

## Launch

One command runs the whole lifecycle: preflight, isolated build, offline boot, live doctor, drive, cleanup.

```bash
.agents/skills/verify-clearcase/bin/verify-clearcase run            # builds HEAD
.agents/skills/verify-clearcase/bin/verify-clearcase run --rev REV  # builds another commit
scripts/agent-tools/verify app [--base REV]                          # the same run, with a receipt
```

Preflight requires the exact Bun of `package.json`'s `packageManager` (`1.4.2`). When the `bun` on `PATH` is another version, point `CLEARCASE_BUN` at a 1.4.2 binary and put its directory first on `PATH` as well, so the build's own `bun` calls get the same one:

```bash
CLEARCASE_BUN=/path/to/bun-1.4.2/bun PATH=/path/to/bun-1.4.2:$PATH scripts/agent-tools/verify app
```

What it does, in order:

1. **Preflight**: `bin/verify-clearcase preflight` runs this step alone. It checks the Bun running the runner against the revision's `packageManager` pin (an exact match), that `node_modules` is installed and `bun.lock` matches the revision, the harness files under `tests/e2e/pilot/`, `unshare` (and that `unshare -rn true` works), `ip`, `mount`, Chromium (`CLEARCASE_CHROMIUM`, else `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`; on a host without build 1223 set `CLEARCASE_CHROMIUM` to an installed one, such as `chromium-1243`) and the ports. It only reads local files and versions. Missing prerequisites exit 3 with one `fix:` line each, before anything is built, started or contacted.
2. **Isolated build**: `isolatedBuild` from `tests/e2e/pilot/lib/isolated-build.mjs`. It runs `git archive <rev>` into the run's scratch, reflinks the checkout's `node_modules` after checking that `bun.lock` is byte-identical, then runs `bun run --bun build` with `CLEARCASE_SOURCE_REVISION`. The stamp `build/clearcase-build.json` must name that revision with `exported: true` and `dirty: false`. The worktree's own `build/` is never used, so uncommitted edits are not part of the proof. Commit first.
3. **Offline boot**: `unshare -rn env OUTER_UID=… OUTER_GID=… tests/e2e/pilot/offline.sh bun lib/inner.mjs CONFIG` runs the server and browser in a fresh network namespace with only `lo`, with the host resolver's sockets hidden. `netproof` must show outbound TCP (IPv4 and IPv6) and DNS failing and loopback working. Then `startServer` from `tests/e2e/pilot/lib/server.mjs` boots `<scratch>/src/scripts/pilot/start.ts` under Bun with the run's ports and a fresh data directory. The server is ready when `/api/health` answers from the spawned PID.
4. Live doctor, drive, stop, cleanup: see the sections below.

Ports default to app `43600`, originals `43601` and the Chromium canary `43699`, inside 43600-43699. Override them with `VERIFY_CLEARCASE_PORT=N` (the app port; originals is N+1, the self-test fake is N+50 and its registry canary N+51) and `CANARY_PORT`. Each run gets its own network namespace, so concurrent runs never share a port or an instance, and nothing on the host can answer in place of this run's server. Other settings:

- `VERIFY_CLEARCASE_TIMEOUT_MS` limits the offline part (default 300000).
- `VERIFY_CLEARCASE_SCRATCH` sets the scratch root (default `.local/verify-clearcase-scratch`; it must be on the same filesystem as `node_modules` for the reflink).
- `--keep-scratch` keeps the build, data directory and profile for debugging. Run `cleanup` afterwards.

A run takes about 10 seconds on the archlinux host (15 October 2026): about 6 seconds of build and about 4 seconds of boot and drive. If the offline part exceeds `VERIFY_CLEARCASE_TIMEOUT_MS`, the runner SIGKILLs the namespace, reports step `offline` FAIL naming the timeout, and cleanup kills the orphaned server and Chromium by their recorded PIDs. `inner.json` is rewritten after every step (`partial: true` until the end), so a killed run still shows the last step that passed.

## Doctor

There are two doctors, and you need both.

- **Before install**: `scripts/agent-tools/doctor` has the rows `app-unshare`, `app-ip`, `app-chromium` and `app-runner`, plus the `bun` row (Bun >= the `packageManager` pin). It needs no build and no listener. Run it first on a new host or when the runner says SKIPPED.
- **Live**: `lib/live-doctor.mjs` runs inside every run, right after boot. It reads `/api/health` once and checks the following. It fails on any mismatch, so a stale server, one from another build or one on another data directory never gets driven:
  - `instance.pid` is the PID the runner spawned, and `/proc/<pid>/cmdline` runs this run's `start.ts`.
  - `instance.dataDir` is the run's disposable directory.
  - `appPort`, `originalsPort` and `originalsOrigin` are the run's.
  - `instance.build` equals this run's `clearcase-build.json` in full: `revision`, `buildId` and `builtAt`.
  - `instance.bun` equals the pin (`1.4.2`).
  - The pragmas are `main.journal_mode=wal`, `work.journal_mode=delete` and `synchronous=2` on both.
  - `storageError` and `recovery` are `null`.

  The run then repeats the doctor against the same server with a wrong data directory, build, PID and Bun, and each must FAIL (step `live-doctor-negative`).

To check an instance by hand, for example one started with `bun run --bun start` in the host namespace:

```bash
.agents/skills/verify-clearcase/bin/verify-clearcase live-doctor --url http://127.0.0.1:41101 --pid PID \
  --data-dir DIR --build-stamp build/clearcase-build.json [--start-script $PWD/scripts/pilot/start.ts]
```

It exits 0 only when every check passes. Do not drive an instance whose live doctor fails; start a fresh run instead.

## Drive

`lib/drive.mjs` holds the pilot's steps; each `features/<feature>.steps.mjs` an owner adds is appended after them, in name order (`lib/features.mjs`). Each step names its feature file under [`features/`](features/README.md) and acts through Chromium over CDP (`tests/e2e/pilot/lib/cdp.mjs`): clicks on the real controls, typed form values, and new tabs opened by real links. The selectors are the app's stable handles:

| Step | User action | Handles | Proof |
| --- | --- | --- | --- |
| `import-form` | Import results, "Already have a results package?": fill both fields, Validate package | `main[data-ready=import]`, `#caseFolder`, `#packageSource`, `#validate` | lands on `/import/<id>`, `main[data-ready=import:<id>]` |
| `validation-report` | read the report | `main[data-verdict]`, `#results-version`, `#verify-state`, `#active-state`, `#diag-summary`, `[data-code]` | verdict accept or report, the package's results version, `verified`, `not active`; `GET /` redirects to `/cases`, whose `Open` link leads back to this report |
| `preview` | Preview the candidate | `#preview`, `#candidate-banner`, `#count-documents[data-count]` | CANDIDATE PREVIEW banner; the active version is still none |
| `activate` | back to the report, tick the acknowledgement, Activate | `#candidate-banner a`, `#ack`, `#activate`, `#active-banner` | overview with the active banner; the case list's `Open` link now leads to this version's overview |
| `overview-slots` | read the overview `activate` landed on | `main section[data-slot][data-slot-status]` (`overview-slots.ts`) | exactly `deadlines`, `unbilled-time` and `rescan-freshness`, all `filled`: `0`, `0.0 h` and `Built on … · 7 documents indexed.` |
| `chronology` | Chronology in the case navigation | `#nav-chronology`, `main[data-ready=chronology]`, `#row-count[data-count]`, `[data-ref]` | every register row is listed, including OD-001 |
| `citation` | Overview, then the `OD-001` citation in "The matter, in one paragraph" | `#nav-overview`, `.narrative a.cite` | `/v/<rv>/doc/OD-001`, `main[data-ready=doc:OD-001]` |
| `viewer` | Open on the document's original | `section.original[data-presentation=viewer]`, `#open-original` (`target=_blank`, `rel=noopener noreferrer`) | new tab on the originals origin, wrapper `body[data-ready=1]`, pdf.js frame `window.__viewer.rendered >= 1` and its text layer |
| `view-registry` | Matter & Strategy in the navigation | `#nav-matter`, `main[data-ready=matter]`, `nav.views a[data-view][data-status]` | `/v/<rv>/analysis/matter`; 42 entries, all available, no `[data-unavailable]`; `GET /v/<rv>/analysis/no-such-view` is 404 |
| `every-view` | each of the 42 navigation entries in turn | `#nav-<id>`, `main[data-ready=<id>]`, `nav.views [aria-current=page]` | each view's own path, its entry current, a heading; every view's heading and time recorded |

The owners' steps from `features/*.steps.mjs` follow in name order (`system-manual`, then `system-rescan` with `system-freshness`, then `system-backup-export`, `system-restore` and `system-restore-refused`); `bin/verify-clearcase features` lists them.

Around the drive, `no-egress` requires that the canary on `CANARY_PORT` saw no connection except Chrome's own background services (Chromium maps every non-loopback host to it) and that every browser request went to the app or originals origin. A background hit is a Google service host with no Origin or Referer, the e2e suite's rule (`isBackground` in `tests/e2e/pilot/suite/context.mjs`); it is listed under `backgroundHits` and does not fail the run. `stop` requires SIGTERM to end the server gracefully with both ports closed.

## Evidence

Evidence goes to `$CLEARCASE_REPORT_DIR/skill/<run-id>/` when `CLEARCASE_REPORT_DIR` is set, else `.local/verify-clearcase/<run-id>/`. The run ID is `<UTC time>-<runner pid>`, and the runner prints the path. Contents:

- `summary.json`: every step with PASS, FAIL, SKIPPED or NOT RUN, its timing and evidence; the preflight facts (revision, Bun, tools, ports); the offline command and exit; the cleanup record.
- `inner.json`: the in-namespace steps, including the netproof result, the live doctor checks and the drive evidence (values read from the page, `refills`, canary hits, console errors).
- `screens/NN-<step>.png`: one screenshot of each state the drive reaches, the filled import form included.
- `health.json` (the `/api/health` the doctor accepted), `clearcase-build.json` (the build stamp), `server.log` (the server's stdout and stderr) and `offline.log` (the namespace transcript).

Proof standards: the steps act on user controls, never on internal setters or test endpoints. Each step captures the action and the resulting state, and checks side effects through a second view: the `/` redirect before and after activation, and the viewer's frame state, not just the wrapper. A SKIPPED or NOT RUN step is never a pass, and `verify app` exits nonzero for any of them. Evidence outlives cleanup, and the run's `evidence-kept` step checks that after the scratch is gone: every file whose step ran, and every screenshot a passing step returned, must still exist (a full pass has all five files and one screenshot per step that takes one: sixteen today).

## Cleanup

Each run cleans up after itself, pass or fail. Each process records itself in `<scratch>/pids.jsonl` when it starts: the namespace or inner process, the server and Chromium. Cleanup sends SIGTERM and then SIGKILL only to recorded PIDs whose `/proc/<pid>/cmdline` still contains the run's scratch path. It never kills by name. It then removes only that scratch: the isolated build copy, the data directory, the synthetic case and the browser profile. Evidence is never touched.

After a crash, a SIGKILL of the runner or `--keep-scratch`, run:

```bash
.agents/skills/verify-clearcase/bin/verify-clearcase cleanup            # every stranded run under the scratch root
.agents/skills/verify-clearcase/bin/verify-clearcase cleanup --run-id ID
```

It exits 1 if a recorded process survives SIGKILL.

## Helpers

All of these go through `bin/verify-clearcase`, which runs `lib/main.mjs` under `CLEARCASE_BUN` or the `bun` on `PATH`:

| Command | Purpose | Exit |
| --- | --- | --- |
| `run [--rev REV] [--keep-scratch]` | the whole lifecycle | 0 PASS, 1 FAIL, 3 SKIPPED (preflight) |
| `preflight [--rev REV]` | local checks only, prints the facts | 0 or 3 |
| `live-doctor --url … --pid … --data-dir … --build-stamp …` | check one instance | 0 or 1 |
| `cleanup [--run-id ID]` | stranded scratch and PIDs | 0 or 1 |
| `features` | the feature index found by discovery, with each feature's drive steps | 0, or 1 on a contract breach or an invalid step module |
| `self-test` | failure modes, without building | 0 or 1 |
| `--help` | usage | 0 |

`self-test` covers three failure modes:

- **Clean checkout.** The runner runs in a `git archive` copy that has no `node_modules`, and again with Chromium missing. It must exit 3 with the install command, run no bun other than itself, launch no Chromium, build nothing and open no connection. A local listener stands in for the package registry and every proxy variable, and it must see nothing.
- **Stale or wrong-build instances.** The live doctor runs against a fake `/api/health` that differs from the expected instance in exactly one way at a time: another PID, data directory, build ID, revision or `builtAt`, no stamp, another Bun, other ports, a rollback journal, `synchronous=1`, a storage error, no pragmas, a PID that does not run this run's `start.ts`, or nothing listening. Each must FAIL, and the matching answer must PASS.

- **A broken feature index.** Static cases, with nothing built or started: every committed feature file keeps the entry contract; a scratch features directory with broken files (wrong H2 order, a missing H2, no title, two paragraphs, a list for the paragraph, a Driving section without `Preconditions:`, an action bullet with no step or *not yet driven*) fails, naming each; scratch `.steps.mjs` modules are discovered and appended after the pilot's steps in name order; a reused step id, a step naming another feature and a module without a feature file are refused.

`tests/agent-tools/run.sh` runs the self-test as well. Self-test evidence goes to `<report>/selftest-<id>/self-test.json`.

## Extending

[`features/README.md`](features/README.md#extending) lists what an M2 owner proves and which shared contracts to check against: document rows (`documents.server.ts`), user work and its enumeration (`user-work.server.ts`) and the overview widget slots (`overview-slots.ts`). Your feature files and step modules are yours; `SKILL.md`, `lib/` and `bin/` are coordinator-serialized (`docs/development.md`, Adding a view). There is no hand-written index: `bin/verify-clearcase features` lists every `features/*.md` (README aside) in name order, checks each against the entry contract and checks every step module, exiting 1 on a breach, and each run records the list in its `summary.json`. M2 owners add their view in one or two places:

1. **A feature file**: `features/<category>-<feature>.md` (for example `features/analysis-matrix.md`) in the shape of [`features/README.md`](features/README.md): H1, one paragraph, then `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-clearcase` and `Gotchas`. Discovery indexes it; there is no list to edit. If you add a registry entry, its own route must land with it (see `features/view-navigation.md`).
2. **Optionally, drive steps**: `features/<category>-<feature>.steps.mjs`, beside the feature file, exporting `steps`. Each step's `feature` is that module's own feature id (the file name without `.steps.mjs`), and its `id` is unique across all steps; a module without a feature file, a step naming another feature, or a reused id fails `features` and the run before anything is built:

   ```js
   // features/evidence-documents.steps.mjs
   export const steps = [
   { id: 'documents', feature: 'evidence-documents', title: 'Documents: filter by bundle and open a row',
     async run(x) {
       await x.click('#nav-documents');
       await x.waitReady('documents');               // your page's main[data-ready], its registry id
       await x.page.waitFor(`document.querySelector('main')?.dataset.hydrated === '1'`);
       const n = await x.page.evaluate(`document.querySelectorAll('#documents-table tbody tr[data-ref]').length`);
       if (n !== 4) throw new Error(`rows ${n}`);     // the first bundle (Original) of the synthetic case
       return { rows: n, shot: await x.shot('documents') };
     } },
   ];
   ```

   Use `x.click`, `x.fill`, `x.text`, `x.waitReady`, `x.shot`, `x.openTab(sel, urlPrefix)` with `x.tab(sid)` for links that open a new tab, `x.frame(sid, /re/)` for frames, `x.c` for the HTTP second view, and `x.state` to pass values between steps. Throw to fail. Return what you observed. Steps run in order (the pilot's, then each module's in name order), so start from the state the previous step left, or navigate explicitly.

   If the synthetic case lacks data your view needs, extend it in the `synthetic-case` step of `lib/inner.mjs` through `buildCase`'s `edit`, `rows` or `originals` options. Keep it invented. Then run `bin/verify-clearcase run` and `bin/verify-clearcase self-test`, and keep `features/` in step with what the drive proves. `/maintain-verification-skill` audits the map against the app.

## Gotchas

- `/` always redirects to the case list, `/cases`, active version or not. Prove activation through the case card's `Open` link (`x.c.home()`, `x.c.activeVersion()`), not through `/`.
- Chromium builds newer than the default 1223 (1228, 1243) contact `update.googleapis.com`, `www.google.com` and `android.clients.google.com` despite the harness flags. `no-egress` records these as `backgroundHits`; any other canary hit still fails.
- Chromium's own network-time query (`clients2.google.com/time`) would hit the canary. The runner adds `NetworkTimeServiceQuerying` to the harness's `--disable-features` list. The last `--disable-features` switch wins, so the list is repeated in full.
- `#open-original` opens a new tab (`noopener`). Read it through `x.openTab`, not the main tab's session. A step that opens a tab must bring the main tab back to front afterwards (`x.b.send('Page.bringToFront', {}, x.page.sessionId)`, as `viewer` does): Chromium throttles a background tab's timers, and every later client-side navigation then takes about 1 s.
- The worktree's own `build/` and uncommitted edits are never what gets verified. The build is of a committed revision.
- `verify app` records the revision before and after the run. A commit or edit in the checkout during the run turns its receipt SKIPPED, so rerun when the checkout is quiet.
