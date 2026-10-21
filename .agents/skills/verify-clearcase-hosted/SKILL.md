---
name: verify-clearcase-hosted
description: "Drive the hosted ClearCase artifact (SvelteKit on Cloudflare Workers, served by native workerd through wrangler dev --local with local D1 and R2) offline in headless Chromium and keep screenshot evidence. It builds HEAD's hosted-gate artifact, starts it with the synthetic two-client fixture, proves the instance with a live doctor, then signs in as a test identity, opens a provisioned case, downloads an original and checks its bytes, and sees a wrong-client session denied. Use it to prove a hosted user path works, before a hosted acceptance claim, or when a hosted owner (GRS-113, GRS-115, GRS-120) extends the feature map. It never contacts Cloudflare or Clerk."
---

# verify-clearcase-hosted

The hosted surface is the Worker that `bun run --bun build:hosted` builds into `.svelte-kit/cloudflare`: `/sign-in`, `/cases`, `/cases/<caseId>`, `/cases/<caseId>/originals/<assetId>` and `/health`, on `http://127.0.0.1:<PORT>`. This skill drives it the way a user does, inside a network namespace with only `lo`. Everything runs from one executable runner; never run this file as a command. `bun run --bun gate:hosted` runs the same lifecycle with more checks (`docs/development.md`, "Hosted checks").

Synthetic data only. The fixture is `tests/hosted-foundation/runtime/gate-fixture.ts` (two clients, three cases, four identities, four invented originals). The identity, store, assets and audit services are named test doubles of the `hosted-gate` profile; D1 and R2 are Miniflare's local implementations. A pass is not evidence for Clerk, Cloudflare D1 or R2, email or a deployment.

## Launch

One command runs the whole lifecycle: preflight, then in one offline namespace build, start, live doctor, drive and stop, then cleanup.

```bash
.agents/skills/verify-clearcase-hosted/bin/verify-clearcase-hosted run
CLEARCASE_BROWSER_LOCK=/abs/path/orch-bin/browser-lock .agents/skills/verify-clearcase-hosted/bin/verify-clearcase-hosted run   # the same slot, named explicitly (unset discovers it)
CLEARCASE_BROWSER_LOCK=none .agents/skills/verify-clearcase-hosted/bin/verify-clearcase-hosted run   # isolated runner or CI only: no slot
```

1. **Preflight** (`bin/verify-clearcase-hosted preflight` runs it alone): a clean tree (build:hosted stamps HEAD; start:hosted refuses anything else), the Bun of `package.json`'s `packageManager` (`1.4.2`), installed `wrangler`, `workerd`, Kit and the Cloudflare adapter, a real Node >= 22 on `PATH` (Node hosts Wrangler; `node` under `bun run --bun` is Bun and is skipped), `unshare -rn`, `ip`, `mount`, Chromium (`CLEARCASE_CHROMIUM`, else `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`), the e2e harness files, and the browser admission. Admission follows `scripts/browser-lock.mjs` (`docs/development.md`, "Browser admission"): unset discovers the workspace's `orch-bin/browser-lock` through `git rev-parse --git-common-dir`, so on the shared host (PUK) leave it unset or give the lock's absolute path and the drive takes a slot; `none` is the deliberate no-slot choice for an isolated single-runner guest or CI with no `orch-bin`, not a way past a shared host's slots; any other value (relative, empty, not executable) and any `BROWSER_LOCK`, even empty, the retired spelling, fail preflight. Missing prerequisites exit 3 with one `fix:` line each, before anything is built or started.
2. **Offline namespace**: `unshare -rn env OUTER_UID=… OUTER_GID=… tests/e2e/pilot/offline.sh bun lib/inner.mjs CONFIG` with an environment allowlist (`PATH` of the resolved tools, `HOME`, `TMPDIR`, `LANG`, `CI`, `CLEARCASE_CHROMIUM`, `CLEARCASE_BROWSER_SLOT`): no proxy, token or cloud variable of the caller reaches it. `net-offline` proves only `lo`, failing outbound TCP and DNS, and working loopback.
3. **Build**: `CLEARCASE_HOSTED_PROFILE=hosted-gate bun run --bun build:hosted` inside the namespace. The sidecar `.svelte-kit/clearcase-hosted.json` must name HEAD in full, `dirty: false`, profile `hosted-gate`, with `_app/version.json` naming HEAD too (`lib/evidence.mjs`, `buildProblem`).
4. **Start**: `PORT=43700 bun run --bun start:hosted`. It provisions the runtime sentinels and the fixture into local D1 and R2 under `.local/hosted/run-*/persist` and serves through `wrangler dev --local`. Ready means start:hosted recorded `.local/hosted/server-43700.json` for HEAD's hosted-gate artifact, after its own `/health` check on workerd.

Ports: app `43700` and canary `43799` (`VERIFY_CLEARCASE_HOSTED_PORT`, `CANARY_PORT`); the gate uses `43800` and `43899`. Each run has its own network namespace, so nothing on the host can answer for it. A run takes about 10 seconds on the archlinux host (19 October 2026): 3 s build, 5 s start, 1 s drive, plus any wait for a browser slot.

## Doctor

- **Before install**: `bin/verify-clearcase-hosted preflight` (above) and `scripts/agent-tools/doctor` (`app-unshare`, `app-ip`, `app-chromium`).
- **Live**: `lib/doctor.mjs` runs in every run right after start. One `GET /health` plus `/proc`, and every check must pass:
  - `ok`, runtime `Cloudflare-Workers`, the build stamp's `revision`, `buildId`, `profile` and `dirty: false` equal the artifact this run built;
  - `gate.runId` is this run's and `gate.fixtureSha256` is the committed fixture's; `identityProvider` is `test-identity-double`;
  - the `DB`, `BUCKET` and `ASSETS` bindings are present and the D1 and R2 sentinel probes round-trip;
  - the PID is start:hosted's (`scripts/pilot/hosted.ts start`), a `wrangler dev` under it has this run's `--persist-to`, and a native `workerd` runs under that.

  `live-doctor-negative` repeats the doctor against the same server expecting another revision, build, run, fixture, process and persist directory; each must FAIL.

To check a hosted-gate server you started yourself (`CLEARCASE_HOSTED_PROFILE=hosted-gate bun run --bun build:hosted`, then `PORT=N bun run --bun start:hosted`):

```bash
.agents/skills/verify-clearcase-hosted/bin/verify-clearcase-hosted live-doctor --port N
```

Do not drive an instance whose live doctor fails; start a fresh run instead.

## Drive

`lib/drive.mjs` launches Chromium (own profile; every non-loopback host maps to the canary) and runs `lib/steps.mjs`, one step per mapped feature under [`features/`](features/README.md), in this order:

| Step | Feature | User action | Handles | Proof |
| --- | --- | --- | --- | --- |
| `sign-in` | `identity-sign-in` | open `/`, choose `client-a/a-viewer`, Sign in | `[data-auth-provider=double]`, `#test-identity`, `#sign-in` | `/cases` with `[data-auth-state=signed-in]`; `clearcase_session` HttpOnly, SameSite=Lax, invisible to `document.cookie` |
| `open-case` | `case-open` | click the case | `a[data-action=open-case][data-case-id=case-a1]` | only case A1 listed; `h1[data-case-id=case-a1]`, `[data-results-state=pending]`, originals `a1-letter` and `a1-note`, `[data-user-work-state=unavailable]` |
| `open-original` | `original-open` | click the file | `a[data-action=open-original][data-asset-id=a1-letter]` | a completed download whose size and SHA-256 are the fixture's; an in-page GET with `attachment`, `application/pdf`, `nosniff`; `Range` answers 416 |
| `wrong-client` | `access-denied` | sign in as `client-b/b-editor` in a second browser context | the same controls | `/cases` shows `[data-denial-code=wrong-client]` 401; A's original answers 401 with no bytes and no download; `b1-letter` under case A1 answers 404 to a-viewer |

`no-egress` then requires that the canary saw nothing but Chrome's own background services (`isBackground` of `tests/e2e/pilot/suite/context.mjs`) and that every browser request went to the app's loopback origin. After the drive, `stop` runs `start:hosted --stop` and requires start:hosted, Wrangler and workerd gone, the port closed and the state file removed.

## Evidence

Evidence goes to `$CLEARCASE_REPORT_DIR/hosted/<run-id>/` when `CLEARCASE_REPORT_DIR` is set, else `.local/verify-clearcase-hosted/<run-id>/`; the runner prints it. Contents:

- `summary.json` (every step with PASS, FAIL, SKIPPED or NOT RUN and its timing), `inner.json` (the namespace's steps, rewritten after each, `partial: true` until the end) and `drive.json`;
- `build.json` (the sidecar stamp and `_app/version.json`), `health.json` (what the live doctor accepted), `test-hosted.json` (gate runs only);
- `screens/NN-<name>.png`: seven states, the filled sign-in forms included; `downloads/a1-letter.pdf`, the downloaded original;
- logs: `offline.log`, `build.log`, `server.log`, `drive.log`, `stop.log`, and `wrangler/` (Wrangler's own logs, copied before the run state is removed).

Proof standards: the steps act on user controls and real form posts, never on internal setters or test endpoints; each checks its result through a second view (the cookie jar, an in-page fetch, the downloaded file). A SKIPPED or NOT RUN step is never a pass. `evidence-kept` checks after cleanup that every file a run step wrote and every screenshot and download a passing step returned still exists.

## Cleanup

Each run cleans up after itself, pass or fail: `start:hosted --stop` on the run's port through start:hosted's own pid file, only when the run recorded starting that server (`start-hosted` or `hosted-server` in `<scratch>/pids.jsonl`, the pid file's process being that one or running under it, and the state file naming the same process); a run that refused because a server already held the port leaves that server, its pid file and its state file alone and lists it as `preserved`. Then SIGTERM and SIGKILL only to PIDs recorded in `<scratch>/pids.jsonl` whose command line still names the run's scratch (the namespace, the inner runner, the drive and Chromium), then the scratch (config, browser profile, downloads) is removed. The run's `.local/hosted/run-*` state is removed after its logs are copied. A port state file whose process is gone is dropped. Evidence is never touched; it never kills by name.

After a crash or `--keep-scratch`:

```bash
.agents/skills/verify-clearcase-hosted/bin/verify-clearcase-hosted cleanup [--run-id ID]
```

It exits 1 if a recorded process survives.

Every row of `<scratch>/pids.jsonl` is `{role, pid, start, runId, at}`: the process's start time (field 22 of `/proc/<pid>/stat`) and the run's name (its scratch's basename) are written with the pid, because Linux reuses pids. A retained scratch can be cleaned up long after the run: the server on the port is stopped only when the pid file's process, or the ancestor of it that matches a `start-hosted` or `hosted-server` row, is running now with the start that row recorded, and the row names this scratch. A row of the old shape (no `start`), one with another start or one for another run proves nothing: the server is left running and listed as `preserved`. SIGTERM and SIGKILL go only to a recorded pid whose command line names the scratch and, when its row has a `start`, whose start still matches.

## Helpers

All go through `bin/verify-clearcase-hosted`, which runs `lib/main.mjs` under `CLEARCASE_BUN` or the `bun` on `PATH`:

| Command | Purpose | Exit |
| --- | --- | --- |
| `run [--keep-scratch]` | the whole lifecycle | 0 PASS, 1 FAIL, 3 SKIPPED (preflight) |
| `preflight` | local checks only | 0 or 3 |
| `live-doctor --port N` | check a hosted-gate server this worktree started on port N | 0, 1, or 2 without one |
| `cleanup [--run-id ID]` | stranded scratch, PIDs and port state | 0 or 1 |
| `features` | the feature index by discovery, with each feature's step | 0, or 1 on a contract breach |
| `--help` | usage | 0 |

## Extending

[`features/README.md`](features/README.md#extending) says what an owner changes when a double gives way to a real boundary. The feature files and their steps in `lib/steps.mjs` move together; `features` and every run refuse a step without a feature file that names it, and a feature file naming a step that does not drive it. `lib/` and `bin/` are shared with `gate:hosted`; change them in their own reviewed commit.

## Gotchas

- One hosted run per worktree at a time: `build:hosted` rewrites the worktree's `.svelte-kit`. A concurrent build fails the other run's artifact check (`start:hosted` or `test:hosted` refuses the changed artifact) rather than passing it.
- An endpoint's refusal (an original's URL) renders Kit's static error page, without `[data-denial-code]`; the drive reads its status from the navigation timing entry.
- The browser slot wait happens before `drive.mjs` starts; `inner.json` records it as `slotWaitMs` on the `drive` step, apart from the drive's own 300 s deadline.
- Chromium builds newer than 1223 contact Google update hosts; `no-egress` lists them as `backgroundHits`. Any other canary hit fails the run.
