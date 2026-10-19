# Viewer evaluation harness (GRS-97)

A self-contained Bun workspace that compares the shortlisted viewer components inside one protected shell under real Chromium, using synthetic fixtures only. It is not a root workspace member and has its own `package.json` and `bun.lock`; the root gate does not run it. The frozen results and the contract built from them are in [docs/acceptance/viewers/](../../docs/acceptance/viewers/).

## Run

From this directory, with Bun 1.4.2:

```sh
bun install --frozen-lockfile      # SheetJS CE comes from cdn.sheetjs.com; bun.lock pins its sha512
bun fixtures/generate.mjs          # 75 synthetic files into <worktree>/.local/viewer-evaluation/fixtures (13 s)
bun harness/build.mjs              # bundle the readers, copy pdf.js assets, measure library gzip sizes
../../../../orch-bin/browser-lock unshare -rn env OUTER_UID="$(id -u)" OUTER_GID="$(id -g)" ../e2e/pilot/offline.sh bun harness/run.mjs
```

The last line takes a browser slot through the workspace's `orch-bin/browser-lock` (the path assumes a worktree under `worktrees/`) and runs every family at three viewports inside the repository's loopback-only network namespace (`tests/e2e/pilot/offline.sh`); without the wrapper the browser context still aborts and records page egress, but Chrome's own background services can reach the network. `run.mjs` takes `--only pdf,sheet,...`, `--viewport desktop-1440x900` and `--skip-large`. It writes `results.json` (every check with its verdict, assertion and observation, the Git revision and the harness tree id), `results.md`, `progress.log`, `sizes.json` and screenshots, all under `<worktree>/.local/viewer-evaluation/`, which Git ignores. Screenshots are cited by path and never committed.

The generators call ImageMagick 7, FFmpeg, LibreOffice and qpdf. Conversions run inside `unshare -rn` (no network). The browser is Playwright's installed Chrome for Testing, driven by `playwright-core`; Firefox and WebKit are not installed on this host.

## Layout

| Path | What it is |
| --- | --- |
| `fixtures/generate.mjs`, `fixtures/lib/` | Generators: a PDF writer, a raw ZIP writer (hostile variants), a DOCX writer, SheetJS workbooks patched at ZIP level, Gmail- and Outlook-shaped EML, an Outlook-shaped MSG writer over `cfb`, and media/image/office conversions |
| `harness/import.mjs` | Candidate import: content sniffing, hashes, child graphs (attachments, nested messages, archive members) and holds |
| `harness/server.mjs`, `harness/shell/` | The trusted origin and the broker shell (session cookie, hash check, nonce-bound port hand-off) |
| `harness/renderers/` | One opaque-origin reader per family, plus three test-only containment probes (`probenav`, `probeclaim`, `attacker`) |
| `harness/shared/formats.mjs` | Sniffing, ZIP listing with bounded extraction, CRC-32, A1 parsing (used by import and readers) |
| `harness/checks/` | The per-family checks, containment probes and readiness candidates |

## Rules

Synthetic bytes only. External URLs in fixtures point at `canary.invalid`, and the browser context aborts and records every request that leaves the harness origin. Never point the harness at case material or send a fixture to an external viewer or conversion service.
