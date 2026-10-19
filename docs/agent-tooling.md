# Agent tooling

Implementation and review agents run the project's planning checks and verification capabilities through `scripts/agent-tools/`. Every entry point works from a fresh non-interactive shell in any worktree and needs no GUI or shell profile. Every check writes a receipt; [Receipts](#receipts) lists exactly which commands do. GRS-104 updates the tooling originally delivered by CC-27 (GRS-35). It implements no application behavior.

## Quick start

```sh
scripts/agent-tools/doctor                      # preflight with a receipt; nonzero on any missing dependency
scripts/agent-tools/check-plan                  # planning checker + pstack check-plan.mjs
scripts/agent-tools/check-plan --linear-relations PATH   # also compare a Linear readback
bash tests/agent-tools/run.sh                   # tooling self-tests
scripts/agent-tools/verify app                  # build HEAD in isolation and drive the app offline (verify-clearcase)
```

Run them from the worktree root, or by absolute path from anywhere. `receipt` is the exception: it runs its command in the current directory, which must lie in the checkout whose revision it records (see [Revision identity](#revision-identity)). The caller's shell does not matter; fish, zsh, bash and `env -i` all work because each entry point is an executable script.

## Sources and versions

T3 Code's canonical `t3-pstack` plugin owns pstack. Do not reinstall `backnotprop/pstack` into global skill directories. The tools only read installed plugins and independent leaf skills; they install nothing and change no global settings.

Discovery uses `T3_PSTACK_ROOT` when set, otherwise the newest version directory under `~/.claude/plugins/cache/t3-pstack/t3-pstack/`, ordered by semantic version (including numeric prereleases). An empty or broken override fails. A present but broken plugin fails without trying an older version or legacy skills. A newer cache directory that has no matching install record (an orphan) also fails; the tools never silently choose the registered older install. `HOME` must be an absolute path (a trailing slash is ignored): the plugin cache, the registry and `~/.agents/skills` are located from it, and an empty or relative `HOME` fails with a message naming it instead of resolving them against the working directory. Supported plugin versions are `>= 2.0.0-rc.5` and `< 3.0.0`; a new major requires review of the tool contract.

The selected root must contain `.claude-plugin/plugin.json` naming `t3-pstack`. Its version must match the directory and the matching `installPath` record in `~/.claude/plugins/installed_plugins.json`. The record must have an exact `gitCommitSha`. Doctor records version, SHA, root and selection in its receipt's `pstack` field. It fingerprints the install registry, manifest and required skill files, then reads those inputs again after the checks. This is installed provenance, not a claim that the cache is a Git checkout or that every plugin file was compared with upstream.

On 17 October 2026, the Claude install was `2.0.0-rc.5` at `bfd36b17e7ab74a7bedb2b40ae7af05a1c1284c9`. The Codex cache also contained `2.0.0-rc.7` and the same checker bytes, but no corresponding Claude install record. Pointing `T3_PSTACK_ROOT` there requires matching install metadata; the tools never invent a version or SHA. T3 manages plugin updates outside these tools.

"Absent" means two things at once: the cache holds no version directory, and `installed_plugins.json` either does not exist or has no `t3-pstack@t3-pstack` install record. Any record means the plugin is registered, so a missing or empty cache is a FAIL (receipt included), never a legacy PASS. A registry that exists but cannot be read, or is not a JSON object with a `plugins` object, leaves absence unproven and also fails. Only when the plugin is absent do the tools accept legacy pstack in `--skills-dir DIR`, `CLEARCASE_SKILLS_DIR`, or `~/.agents/skills`. Doctor names `legacy fallback`, with version and SHA unavailable. An existing install registry is fingerprinted in legacy mode too, so mid-run changes fail the receipt. A registry absent before discovery is not an input; creation after that look is outside this two-look fingerprint contract. The bootstrap link cannot mask a newer plugin. Required files are `poteto-mode/SKILL.md`, its `playbooks/orchestrate.md`, `playbooks/multi-phase-plan.md` and `scripts/check-plan.mjs`, plus `SKILL.md` for `create-verification-skill`, `maintain-verification-skill`, `setup-pstack` and `swarm`. Presence does not authorize using a skill forbidden by workspace instructions.

`skills.lock.json` retains only the three independent Matt Pocock leaf skills (`ask-matt`, `codebase-design`, `domain-modeling`), their provenance and content pins. These continue to come from `--skills-dir`, `CLEARCASE_SKILLS_DIR`, or `~/.agents/skills`, independently of pstack discovery. Their hashes still cover sorted relative paths and file bytes, symlink targets, and exclude `node_modules`, `__pycache__` and `.DS_Store`.

The 53 upstream pstack content pins, mirror provenance, Git-object comparison and pstack relock branches are retired. `verify pstack` validates the installed source and required files with a receipt. `verify pstack-upstream [--checkout DIR]` and the internal `compare-upstream` entry point stay callable only so that an old script gets a clear failure: both exit 1 with a message pointing to `verify pstack`, `verify pstack-upstream` writes a FAIL receipt under that name, and `--checkout` is accepted but never used. Neither can PASS, so no receipt named `pstack-upstream` is mistaken for upstream-content evidence. The independent leaf skills still need content pins because a plugin install record does not own them.

The leaf skills `to-spec`, `to-tickets` and `implement-spec` are not installed or claimed here. Doctor reports their presence as INFO only.

Runtimes remain bash >= 4.4, Python >= 3.10, Node >= 18, git and Bun >= the `packageManager` pin. Node runs the dependency-free plan checker; it is not evidence of the app running under Bun. Local build and app verification use Bun. Hosted artifacts are built with Bun and run under workerd; Wrangler is hosted by Node, as ADR 0008 records. A local pilot check does not prove the hosted boundary.

## Bootstrap, upgrade and removal

Start a fresh shell with the installed T3 plugin and leaf skills available, then run:

```sh
scripts/agent-tools/doctor
scripts/agent-tools/bootstrap
scripts/agent-tools/verify pstack
```

Use `--base REF` (or `CLEARCASE_BASE_REF`) when neither `origin/dev` nor `dev` is available. The accepted base must resolve locally; an archive initialized as a new repository needs its own explicit base. Bun can be selected with `CLEARCASE_BUN`, and Chromium with `CLEARCASE_CHROMIUM`; no shell profile is required.

Plain `bootstrap` runs doctor, then creates only ignored local state: `.local/agent-tools/skills` points to the selected pstack skills directory and `bootstrap.json` records its identity. Repeated calls report `unchanged`. A conflicting existing link fails and asks for `bootstrap --remove` before replacing it. The link is kept only for compatibility; nothing in these tools reads it, and it names a version-specific plugin path, so a plugin update makes the next plain `bootstrap` FAIL with the conflict message until `bootstrap --remove` clears it. A later change may drop the link. Discovery always checks the plugin cache again. Removing bootstrap deletes only its local link and state; receipts and installed skills stay.

`bootstrap --relock` rehashes the existing independent leaf pins. Review their source changes first, then review and commit the lock change. `--relock --checkout` and `--allow-drop` are refused with a retirement message; a plugin update is never translated into new upstream skill pins. Tools never update the plugin, install packages globally, or edit model settings.

### Bun

The app builds and runs with Bun, so the doctor fails unless `bun --version` prints a version at least the app's minimum. The minimum is `package.json`'s `packageManager` field, `bun@MAJOR.MINOR.PATCH` with an optional `+hash` suffix, and the doctor's receipt fingerprints `package.json`. A `package.json` that cannot be read, is not JSON, or pins no `bun@` version fails the doctor. `MIN_BUN` (1.4.2, in `scripts/agent-tools/agent_tools.py`) applies only to a checkout without `package.json`, such as the tests' fixtures.

The doctor uses `CLEARCASE_BUN` when it is set, otherwise the `bun` on PATH. It fails, with a fix, when no bun is found, when the version is older than the minimum, and when `bun --version` does not print exactly one version. That means it fails when `--version` exits nonzero, writes anything to stderr, even with exit 0, or prints on stdout anything other than one line holding a version such as `1.4.2`. White space around that line is ignored; a second line is not. Versions compare as numbers, and a prerelease such as `1.4.2-canary.1` counts as older than `1.4.2`. The row names the bun it checked and where the minimum came from, and the receipt lists that bun's path and its whole stdout as the version.

`verify app` and its live doctor need the pinned version exactly, not a newer one. When the host's `bun` is newer than the pin, install the pinned release next to it and select it for the run. `~/.bun` and the user's default `bun` stay as they are:

```sh
(
  v=1.4.2 d=~/.local/share/bun-versions/1.4.2
  t=$(mktemp -d) || exit 1
  trap 'rm -rf "$t"' EXIT
  curl -fsSL -o "$t/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$v/bun-linux-x64.zip" &&
  curl -fsSL -o "$t/checksums" "https://github.com/oven-sh/bun/releases/download/bun-v$v/SHASUMS256.txt" &&
  grep ' bun-linux-x64.zip$' "$t/checksums" | sed "s|bun-linux-x64.zip|$t/bun.zip|" | sha256sum -c - &&
  unzip -q "$t/bun.zip" -d "$t" &&
  mkdir -p "$d" &&
  install -m755 "$t/bun-linux-x64/bun" "$d/bun" &&
  ln -sf bun "$d/bunx"
) && {
  export CLEARCASE_BUN=~/.local/share/bun-versions/1.4.2/bun
  export PATH=~/.local/share/bun-versions/1.4.2:$PATH
}
```

To move the pin, run `bun upgrade --stable` (`pacman -Syu bun` for the distribution package) and record the `bun --version` it installs. Then change `packageManager` (and `MIN_BUN` with it) in a reviewed commit into `dev`. The tools never upgrade Bun or change the pin themselves.

## Entry points

| Command | Runs | Exit codes |
| --- | --- | --- |
| `scripts/agent-tools/doctor` | OS and bash, Python, git and repository, the revision receipts record (head, base and merge base), Node, Bun at the app's minimum version, planning scripts, skill bundle discovery, required skill files, independent leaf content pins, writable receipt directory. Before any install or build, the app/browser prerequisites of `verify app`: `unshare` (and that `unshare -rn` works), `ip`, Chromium and the verify-clearcase runner (see [App verification](#app-verification)). Reports the selected plugin or legacy source and optional tools (gh, tmux). Writes one receipt with the report. | 0 all required checks pass, 1 a check failed, 2 unsupported OS, old bash or no python3 (no receipt, because Python never starts) |
| `scripts/agent-tools/check-plan [--linear-relations PATH] [--require-linear-relations] [--plan PATH]` | `plan-graph` and `plan-format`, plus `linear-relations` when a readback is given (or `CLEARCASE_LINEAR_READBACK` is set). One receipt per step. | 0 every step passed, otherwise the first failing step's code. A missing required comparison exits 3 unless an earlier required step already failed. Required `plan-format` prerequisites fail with exit 1. |
| `scripts/agent-tools/verify list` | Lists the capabilities; all are available. Writes no receipt. | 0 |
| `scripts/agent-tools/verify CAPABILITY [--readback PATH] [--plan PATH] [--checkout DIR]` | One capability with a receipt. | The wrapped command's own exit code, or 3 when skipped |
| `scripts/agent-tools/receipt --name NAME [--tool T]... [--input FILE]... -- CMD ARGS...` | Any command with a receipt. A missing `--tool`, `--input`, command or revision is SKIPPED and is not run, and so is one whose version, fingerprint or state cannot be read (see [Evidence failures](#evidence-failures)). | The command's own exit code, or 3 when skipped |
| `scripts/agent-tools/bootstrap [--relock \| --remove]` | See above. Plain `bootstrap` runs the doctor, which writes the doctor's receipt. A refused conflicting link, `--relock` and `--remove` write none. | 0 or 1 |
| `python3 scripts/planning/generate.py --compare-linear EXPORT` | Diffs generated briefs against the descriptions in a full Linear export. Writes no receipt unless wrapped in `receipt`. | 0 all match, 1 drift |

All commands accept `--skills-dir`, `--receipts`, `--base REF` and `--root DIR`. `--root` checks a different planning tree, which must be the top of a Git checkout; the tests use it for fixtures. `doctor` and `bootstrap` ignore `--root` and check the checkout that holds the tools. `--base` names the revision that receipts compare against; see [Revision identity](#revision-identity).

Capabilities and the commands they wrap, unchanged:

| Capability | Command | State |
| --- | --- | --- |
| `plan-graph` | `python3 scripts/planning/check.py --require-linear-ids` | available |
| `linear-relations` | `python3 scripts/planning/check.py --require-linear-ids --linear-relations READBACK` | available. A readback is a file the coordinator exports from Linear; this command never fetches live data. |
| `plan-format` | `node <plugin root>/skills/poteto-mode/scripts/check-plan.mjs docs/delivery-plan.md` | available |
| `pstack` | Selected source identity and required files | available; FAIL exit 1 for a missing/broken plugin without a valid legacy fallback, unsupported/mismatched version, missing exact install SHA, or missing required file. |
| `pstack-upstream` | Retired | always FAIL (exit 1) with a migration message to `verify pstack`; `--checkout` is accepted and unused. No upstream comparison exists. |
| `app` | `.agents/skills/verify-clearcase/bin/verify-clearcase run` | available. The whole lifecycle of the project verification skill with one receipt; see [App verification](#app-verification). PASS only when every step passed; exit 1 on a failed step, 3 (SKIPPED) when a prerequisite is missing or the runner is not executable. |

pstack's `create-verification-skill` generated `.agents/skills/verify-clearcase/` (GRS-12); `maintain-verification-skill` keeps its feature map honest. The doctor checks that both skill files are present.

### App verification

`scripts/agent-tools/verify app [--base REV]` runs the executable runner `.agents/skills/verify-clearcase/bin/verify-clearcase run`, never `SKILL.md`. `--base` is the receipt's base, as for every capability; the runner builds `HEAD`. Its receipt fingerprints the runner, `lib/*.mjs`, `package.json` and `bun.lock`, and lists `bun`. One run, in order, each step required:

1. Preflight: the Bun running the runner equals the revision's `packageManager` pin, `node_modules` is installed and `bun.lock` matches the revision, the harness under `tests/e2e/pilot/`, `unshare -rn`, `ip`, `mount`, Chromium and the ports. A missing prerequisite exits 3 with a `fix:` line before anything is built, started or contacted.
2. A fresh production build of the revision in the run's scratch (`isolatedBuild`: `git archive`, reflinked `node_modules` after a byte-identical `bun.lock` check, `bun run --bun build`). Its stamp must name the revision.
3. `scripts/pilot/start.ts` of that copy under Bun inside `tests/e2e/pilot/offline.sh` (only `lo`; outbound TCP and DNS proven to fail).
4. A live doctor: `/api/health` must report the spawned PID (running that `start.ts`), the run's data directory, app and originals ports, this run's build stamp in full, Bun 1.4.2, `journal_mode` wal/delete, `synchronous` 2 and no storage error or recovery. A stale or wrong-build instance fails it.
5. Chromium drives a synthetic case through the UI: import, validation report, preview, activation with acknowledgement, overview widget slots, chronology, a citation from the overview narrative to its document, and the cited PDF in the originals-site viewer (wrapper `body[data-ready=1]`, pdf.js frame rendered). No request may leave the app and originals origins.
6. Cleanup kills only the PIDs the run recorded and removes only its scratch; the evidence must still exist afterwards.

Evidence goes to `$CLEARCASE_REPORT_DIR/skill/<run-id>/` when set, else `.local/verify-clearcase/<run-id>/`: `summary.json`, `inner.json`, `health.json`, `clearcase-build.json`, `server.log`, `offline.log` and `screens/*.png`. Ports default to 43600 (app), 43601 (originals) and 43699 (`CANARY_PORT`); `VERIFY_CLEARCASE_PORT` and `CANARY_PORT` override them. Chromium is `CLEARCASE_CHROMIUM`, else `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`, which `scripts/ci/install-chrome.sh` installs: Chrome for Testing 148.0.7778.96, checked by SHA-256, the same build CI uses. Other Playwright builds in that cache are not used unless `CLEARCASE_CHROMIUM` names one. A run takes about 7 seconds on `puk`. The skill's `SKILL.md` documents the subcommands (`preflight`, `live-doctor`, `cleanup`, `self-test`) and how M2 owners extend the drive.

Only committed code is verified: the build is of `HEAD`, not the working tree. A commit or any edit in the checkout while it runs (untracked files are fingerprinted too) turns the receipt FAIL, exit 1 if the runner succeeded, otherwise preserving its failure code (see [Revision identity](#revision-identity)).

## Supported environments

| OS | Shell running the tools | Status |
| --- | --- | --- |
| CachyOS (`puk`) | `/bin/bash` 5.x; any caller shell, including fish and `env -i` | Supported and tested |
| Arch Linux (`archlinux`) | `/bin/bash` 5.x; any caller shell | Supported, same packages. Its bun must also meet the minimum; run the doctor. |
| Other Linux with `/bin/bash` >= 4.4 | any caller shell | Expected to work; run the doctor |
| macOS, BSD, Windows without WSL | n/a | Unsupported. The tools exit 2 with an "unsupported OS" message. |

The entry points use `#!/bin/bash` rather than `#!/usr/bin/env bash`. With an empty or wrong PATH, `env` cannot find bash and prints only a bare "No such file or directory". `/bin/bash` still starts, so the tools can print an actionable message, for example `FAIL python3 not found (PATH=/nonexistent)` with the fix. `CLEARCASE_PYTHON`, `CLEARCASE_NODE` and `CLEARCASE_BUN` override discovery. No other tool has an override; git always comes from PATH.

## Failure behavior

- Wrapped commands keep their stdout, stderr and exit code. Output streams live and is also saved to the receipt. If the console stops accepting output, for example a closed pipe, the capture continues and the command is not stalled.
- A missing tool, input, command or revision produces result SKIPPED and exit 3 for generic `receipt`, graph and app preflight. Required `plan-format` and pstack identity checks produce FAIL and exit 1 instead. git is a required tool of every receipt. The command does not run. SKIPPED never counts as PASS.
- Evidence that cannot be collected is never PASS either; see [Evidence failures](#evidence-failures).
- `check-plan` runs every step, even after a failure, so one run shows all diagnostics. The canonical checker runs unchanged against `docs/delivery-plan.md` by default. The current generated plan produces 27 findings (18 mid-sentence colons, a missing verification rule, two missing program markers, five sections lacking PR sub-blocks and a missing prototype appendix). The step stays FAIL. Some checker requirements conflict with workspace policy; the coordinator must resolve the plan/checker contract explicitly. Do not weaken the checker or rewrite the plan to authorize forbidden schedules or swarms. Its summary line names each step's result and anything not run.
- Without `--linear-relations`, `check-plan` says `NOT RUN: linear-relations`. Local ID checks do not prove agreement with the live Linear graph. Use `--require-linear-relations` where the comparison is mandatory.
- The doctor's app rows (`app-unshare`, `app-ip`, `app-chromium`, `app-runner`) are required checks. They need no install, build or listener, so a clean checkout passes them; `verify app` then stops at the runner's preflight, exit 3, until `bun install --frozen-lockfile` has run.

## Receipts

`doctor`, `check-plan` (one receipt per step), `verify CAPABILITY` and `receipt` each write a receipt, and so does the doctor run inside a plain `bootstrap`. `verify list`, `bootstrap --relock`, `bootstrap --remove` and a `bootstrap` that refuses a conflicting link write none; wrap them in `scripts/agent-tools/receipt` when you need a record, as `docs/acceptance/CC-27/rerun.sh` does for `bootstrap`. An entry point that exits 2 before Python starts (unsupported OS, bash older than 4.4, no python3) writes no receipt, and neither does one that cannot create or write its receipt directory (see [Evidence failures](#evidence-failures)).

Each receipt is a directory `<receipts>/<UTC timestamp>-<name>/` with `receipt.json`, `stdout.txt` and `stderr.txt`. The receipt directory is `--receipts DIR`, else `CLEARCASE_RECEIPTS_DIR`, else `.local/agent-receipts/` in the checkout (ignored by Git). Workers point it at `.orchestration/reports/<planning-key>/` in the `dev` clone for machine-local evidence. Committed receipts go under `docs/acceptance/<planning-key>/` and must not contain case material.

`receipt.json` (schema `clearcase-agent-receipt/1`) records:

- `name`, `result` (PASS, FAIL or SKIPPED), `exitCode`, and `reason`: why it is not PASS when the receipt can say. That is a skip, evidence that could not be collected, or the doctor's FAIL rows. It is null for PASS and for a command's own failure; captured stderr keeps the command's diagnostics.
- `command`, the exact argv, and `cwd`.
- `tools`, git first and then the command's own tools, each with path and the first line of its `--version` output. For bun it is all of its stdout, which the doctor requires to be one version line (see [Bun](#bun)).
- `inputs`, for example the checker scripts, the plan, the readback, or the lock and any `package.json` the doctor checks. Each row has the `path`, the `sha256` of its bytes, and the `size`, `mtimeNs`, `device` and `inode` of the file they were read from, all read before the command runs. After the command exits, every input is read again, and a difference is never PASS (see [Evidence failures](#evidence-failures)).
- `revision`, resolved before the command runs and again after it exits, or for the doctor before and after its checks: `root`, `branch`, `head`, `baseRef` (as requested, or the default that resolved), `base`, `mergeBase`, `dirty`, and `diffSha256` when dirty. The receipt records the first resolution. Every key is present. `head`, `base` and `mergeBase` are null only in SKIPPED or FAIL receipts, and so are `dirty` and `diffSha256` when Git could not report the working tree. `diffSha256` is null when the checkout is clean, and `branch` is `HEAD` when it is detached.
- `dirty` is true when `git status --porcelain`, `git diff HEAD` or the untracked files that are not ignored show anything, so configuration such as `status.showUntrackedFiles=no` cannot hide a change. `diffSha256` hashes the raw `git diff --binary HEAD` output, run with `--no-ext-diff --no-textconv` so a configured diff driver or textconv filter cannot hide a change, and then each untracked file's name with its bytes, a symlink's target or, for a nested repository, all of its files, names hashed as bytes. Ignored files, per `.gitignore`, `.git/info/exclude` and `core.excludesFile`, are not part of it. Git's own change detection is otherwise trusted, for example `core.fileMode`, `core.fsmonitor` and line-ending conversion, and this repository has no submodules.
- `pstack`, on doctor and pstack/format checks, records the selected source kind, root, version and install SHA.
- `spend` separates actual, source, target and unenforced cap (see [Spend readout](#spend-readout)).
- `environment`, with OS, kernel, machine, host, bash, caller shell, Python and PATH.
- `startedAt`, `finishedAt` and `durationSeconds`.
- `artifacts`, the paths of the receipt, stdout and stderr.

Paths under `$HOME` are written as `~` so receipts carry no machine-specific home directory. That display form is lossy (under `HOME=/inner`, `/x/inner/f` and a literal `/x~/f` both read `/x~/f`), so the tools never open, expand or compare it. Each stored value they read back has an exact twin beside it, named with `Exact`, in which `HOME` is written `\h` and each backslash doubled: `argvExact`, `cwdExact` and `pathExact` in `execution`, `pathExact` and `realpathExact` in each input row, `rootExact` and `toplevelExact` in `revision`, `artifactsExact`, the approval row's `reviewExact`, `findingsExact`, `checksExact` and `guardExact`, a test-guard receipt's `guard.testsExact`, and a dispatch row's `failureExact` and `diagnosisExact`. A receipt or ledger row without its twin predates it and is refused with "predates the exact ... record"; rerun the step that wrote it. A relative `HOME` is not a home directory and is not replaced, and a `HOME` of `/implementation` or `/review`, which would rewrite a stored unit, makes the ledger commands refuse.

### Revision identity

Before a receipt-producing command runs anything, it resolves the revision it will record. It uses the checkout that holds the tools, or `--root DIR`. Inherited `GIT_*` variables such as `GIT_DIR` are ignored. A PASS receipt therefore always names `head`, `base` and `mergeBase` as full commit IDs, and a working-tree state that Git reported.

| Situation | Result |
| --- | --- |
| git is not on PATH | SKIPPED, exit 3: `required tool not found: git`. |
| The directory is not a Git checkout, `--root` is below a checkout's top, or the checkout has no commit. This includes `receipt` run from a copy of the tools outside any checkout. | SKIPPED, exit 3: `no head revision: ...`. The receipt records the attempt; the command does not run. |
| `receipt` is run from a directory outside that checkout, or inside a different repository nested in it | SKIPPED, exit 3. Run it inside the checkout, or pass `--root DIR` naming the checkout the command runs in. |
| `--base REF`, or `CLEARCASE_BASE_REF` when `--base` is absent, does not resolve to a commit. An empty value counts as given, so `--base "$UNSET"` cannot fall back. | SKIPPED, exit 3, naming the ref. An explicit base never falls back to a default. It is a missing required input, like a missing `--input` file. |
| No explicit base, and neither `origin/dev` nor `dev` exists | SKIPPED, exit 3: `no base revision`. Pass `--base REF`. |
| The base shares no history with HEAD | SKIPPED, exit 3. |
| HEAD, or the default `origin/dev`, names an object that is not a commit Git can read, for example a deleted or corrupt object | SKIPPED, exit 3, naming the ref and the object. A broken `origin/dev` does not fall back to `dev`; only a default that does not exist does. |
| A Git query fails or prints something that is not a commit ID: `rev-parse` for the top level, HEAD, branch or base, `status`, `diff`, `ls-files` or `merge-base`. A corrupt index, a missing object or an unreadable tracked file causes this. `status`, `diff` and `ls-files` also count as failed when they write anything to stderr, because Git exits 0 with only a warning for a directory it cannot open. | SKIPPED, exit 3: `working tree state unknown: ...`, `branch unknown: ...` or `no merge base: ...`, with the Git command, its exit code and its stderr. |
| An untracked file that Git lists cannot be read, or disappears before it is read | SKIPPED, exit 3, naming the file and the error. |
| A tracked file is marked assume-unchanged or skip-worktree, so `git status` and `git diff` do not check it | SKIPPED, exit 3, with the count and an example; clear the marks with `git update-index --no-assume-unchanged` or `--no-skip-worktree`. |
| Otherwise | The command runs. `base` is the base commit and `mergeBase` is `git merge-base HEAD base`. |

Git runs with `LC_ALL=C`, so its messages in reasons are in English. The doctor resolves the same revision for its own checkout and `--base`, but still runs all its other checks. It reports any problem from the table as a FAIL `git`, `repository` or `revision` row and exits 1, so its receipt says FAIL. A ticket whose branch was cut from another ticket's head passes that head as `--base REF`, or sets `CLEARCASE_BASE_REF` once for the session.

### Evidence failures

A receipt's evidence is its revision, each tool's path and version, each input's sha256, the captured stdout and stderr and the receipt file itself. A failure to collect any of it never gives PASS. The reason names what failed: the command with its exit code and an excerpt of its stderr, or the file with the operating system's error.

| What cannot be collected | Result |
| --- | --- |
| The revision (see the table above) | SKIPPED, exit 3. The command does not run. |
| A tool's version: `--version` exits nonzero, prints nothing, cannot start or takes more than 30 seconds. For bun also any output on stderr. | SKIPPED, exit 3: `tool version unknown: ...`. The command does not run. |
| An input's identity: the file cannot be read, is not a regular file, or changes while it is read (its size or modification time changes, or the bytes read differ from its size) | SKIPPED, exit 3: `input not fingerprinted: ...`. The command does not run. |
| The receipt directory cannot be created | No receipt. Exit 3 with a message naming the directory; the command does not run. |
| The command cannot start, for example a file without execute permission | SKIPPED, exit 3: `the command did not start: ...`. |
| The output cannot be captured whole, for example a full disk. Or, after the command exits, a capture file's descriptor has no link left, its path is gone or names another file, its size differs from the bytes written to it, or it holds other bytes: the sha256 of the bytes as they were written must equal that of the bytes read back through the descriptor. | The command's exit code and FAIL if it failed. If it exited 0: FAIL, exit 1. The reason says `output not captured whole: ...`, for example `stdout.txt: removed during the run` or `stdout.txt: holds other bytes than were written`, and gives the command's exit code. |
| After the command exits, an input is gone or cannot be read whole, or its sha256, size, modification time, device or inode differs from the identity recorded before the run | The command's exit code and FAIL if it failed. If it exited 0: FAIL, exit 1. The reason says `input changed during the run: ...` and names each field that differs, for example `inode 1302892 -> 1302893`. |
| After the command exits, the revision cannot be resolved, or its head, base, merge base, `dirty` or `diffSha256` differs from the one recorded, for example after an edit to a tracked file or a commit | As for inputs. The reason says `the revision cannot be read after the run: ...` or `the checkout changed during the run: ...` with the fields that differ. |
| The receipt cannot be written after the command ran | No receipt. The command's exit code if it failed, otherwise exit 3, with a message on stderr. |

Required pstack and plan-format checks convert missing prerequisites to FAIL, exit 1, with a receipt when the receipt directory is writable. A stale input, changed revision or damaged capture is FAIL for every wrapper, including generic `receipt`; a successful command cannot turn stale evidence green.

The doctor reports the same failures for its own evidence as FAIL rows, `git`, `python3`, `node`, `bun`, `revision`, `skill-pin` or `receipt-input`, and exits 1. Its receipt's reason lists every FAIL row. It reads its inputs, including the lock, any `package.json` and selected plugin files, again after its checks, and a difference is a FAIL `receipt-input` row. It runs no command, but it resolves the revision again after its checks, as the other entry points do after the command exits. A revision that cannot be read then, or whose head, base, merge base, `dirty` or `diffSha256` differs from the first resolution, is a FAIL `revision` row after the checks, `the revision cannot be read after the run: ...` or `the checkout changed during the run: ...`. So a tracked file edited or an index broken during the doctor's checks gives FAIL, not PASS, unless the change is undone before the second look (see [What receipts prove](#what-receipts-prove)). The receipt records the first resolution. It also fails when it is not launched through `scripts/agent-tools/doctor`, because the bash that runs the entry points is then unknown, and when a planning script, the lock or a pinned skill's file or directory cannot be read, or a pinned skill holds something that is not a file, directory or symlink. If it cannot write its receipt, it exits 1 with `doctor: FAIL. Receipt not written`.

No Git query has a time limit; a Git command that hangs blocks the entry point, which then writes no PASS receipt.

## What receipts prove

A receipt is evidence for an honest rerun, not a signature. It says which command ran at which revision, with which tools and inputs, on which host, and what the command printed and returned. Reviewers rerun the checks at the exact revision instead of trusting a receipt alone. This is the threat model the receipts are designed against.

**In scope: a receipt never says PASS.** Each of these gives SKIPPED or FAIL, or a FAIL row for the doctor and a nonzero exit for `rerun.sh`, with a reason that names what failed. [Revision identity](#revision-identity) and [Evidence failures](#evidence-failures) give every case.

- Missing or misbehaving tools: git, python3, node, bun or a `--tool` that is absent, or whose version probe fails, prints nothing, cannot start or hangs, and a bun that prints anything other than one version line or writes to stderr.
- Misconfiguration: no base, or an unresolvable or empty one; a `--root` that is not a checkout's top; Git configuration that could hide a change, such as external diff drivers, textconv filters, `status.showUntrackedFiles` and assume-unchanged or skip-worktree marks; an inherited `GIT_DIR`; a `package.json` that pins no Bun.
- I/O and permission failures: files, directories or Git objects that cannot be read, a receipt directory that cannot be created or written, output that cannot be captured whole, and in `rerun.sh` any transcript, summary, audit or other output it cannot write.
- Unreadable, special or changing inputs: an input that is not a regular file, changes while it is read, or is gone, replaced or changed by the time the command exits, detected as described below.
- Git state that cannot be read: a Git query that fails or warns, before or after the command or the doctor's checks, for example over a corrupt index or a missing object.
- Concurrent edits by ordinary tooling: an editor, formatter or build that rewrites an input, edits a tracked file or commits while a check runs.
- Lost or truncated artifacts: a capture file that is removed, moved or replaced or does not hold the bytes written to it, and in `rerun.sh` a receipt, transcript or summary row that is missing, empty, duplicated or names another head.

**Detected where cheap, not prevented.** A party with write access to the checkout, the inputs or the receipt directory can deliberately race the wrapper, replacing an input or unlinking a capture while a check runs. The mitigation is to look twice. Each input's sha256, size, modification time, device and inode are recorded before the command runs and read again after it exits. The revision is resolved again after the run, and by the doctor after its checks. Before PASS, each capture descriptor must still have a link and the size written, its path must name the same file, and the bytes read back through it must have the sha256 taken of the bytes as they were written, so a rewrite in place to other bytes of the same size is seen. `rerun.sh` ends with an audit of every inventoried step's summary row, transcript and receipts and of each receipt's files. Any difference is never PASS. Two risks remain. A change that is undone between the two looks goes unseen, for example an input swapped and swapped back while the checker reads it. So does tampering with the receipt directory after a receipt or the audit is written.

**Out of scope.** A malicious local user, a compromised Git, Python, Node, Bun or OS binary, and kernel-level tampering. The tools trust the binaries they run, and what Git reports when it exits 0 without warnings. Receipts are evidence for honest reruns, not signatures; reviewers rerun at the exact revision.

## Escalation records

`scripts/agent-tools/escalate` writes a local receipt only. It contacts neither Linear nor any launcher. The coordinator first creates a separate linked Linear escalation issue, then records the bounded request from a clean exact revision:

```sh
scripts/agent-tools/escalate --issue GRS-999 \
  --issue-url https://linear.app/vaper/issue/GRS-999/bounded-question \
  --source-issue GRS-104 --sha FULL_HEAD_SHA \
  --question "Which boundary rejects this stale receipt?" --model gpt-6-astra
```

`--issue`, its matching `https://linear.app/.../issue/ID` URL, a distinct `--source-issue`, an exact clean HEAD SHA, a question of 1-1000 characters and one model are required. Allowed rare models are `claude-fable-5-1` and `gpt-6-astra`, at xhigh with `attemptLimit: 1`. Missing or invalid fields refuse to write a record. A PASS here means the request was recorded, not approved or dispatched. The URL is validated locally, not verified against live Linear.

After the coordinator's attempt, rerun with the same request fields plus `--phase outcome --task-id ID --findings TEXT --outcome TEXT --checks TEXT`. Those four fields are mandatory for an outcome record. Receipts retain source issue, escalation issue, SHA, question and model. This is a record only: not dispatch authorization, not a retry counter and not a deadline watchdog. `attemptLimit: 1` is a constant written into the record; nothing here stops a second request for the same issue, or an outcome recorded with no request. The tool does not link an outcome receipt to its request receipt, and an outcome must name the current clean HEAD, so after any commit made during the escalation it no longer carries the request's SHA. The coordinator enforces issue/stage attempts and keeps the linkage and the actual task evidence.

Workspace rules still own role choices, the single written-finding fix and fresh recheck, rare linked escalation, short reports and one-page briefs, and browser locking. They forbid swarm/panel fanout, preserve external wave review, serial merges, and user-only changes to `main`. No setting here widens those permissions. The fix-diff guard and approval ledger below are callable locally and by CI/push approval callers. This repository carries the CI step that runs the guard (`.github/workflows/ci.yml`, `test guard`) and the repository half of the push hook (`scripts/agent-tools/pre-push`); the hook in `orch-bin` that calls it belongs to the coordinator and is not installed here. Live model-catalogue agreement and deadline/stall enforcement remain separate acceptance boundaries.

## Spend readout

Every receipt prints `actual`, `target` and `cap` separately. Without provider billing evidence, actual is `unavailable` (`actualUsd: null`), never zero. Supply `--actual-usd NUMBER --actual-source SOURCE` together to record reported provider spend, and `--target-usd NUMBER` for a reporting-only target. Values must be finite and nonnegative; zero with a source is actual zero. The source identifies a provider export or billing record; these tools do not fetch or independently certify billing.

```sh
scripts/agent-tools/receipt --name diff-check --target-usd 6 \
  --actual-usd 0.42 --actual-source provider-usage-export -- git diff --check
```

Targets do not pause, cancel or escalate work. `capUsd` is always null and `capEnforced` false because this tool has no spend controller. It makes no T3 API cap claim. The provider's actual cost can remain unavailable even when a target is known.

## Tests

`bash tests/agent-tools/run.sh` needs bash, coreutils, git, Python, Node, the canonical plugin, the three leaf skills, the doctor prerequisites and a non-root user. The checkout needs `origin/dev` or `dev`; the suite deliberately unsets an inherited base for default-base tests. Run it through `receipt` for a record.

Existing synthetic graph, revision, captured-output, permissions, Bun, app preflight and audit fault tests remain. The valid/invalid plan fixtures include the canonical program markers; the real generated delivery plan remains unchanged and is expected to fail the required format step. The CC-27 rerun script is historical; its inventory was updated for the retired upstream checks (exit 1 where it expected 0 or 3: `checkout_expect`, `readback_expect`, `v2-check-plan`, `v5-pstack-upstream-no-checkout`, `v6-plan-format-without-node`, `v6-required-readback-missing`, `v6-plan-format-without-git`, `v6-plan-format-bad-base`) and the suite now runs the committed script itself, not a rewritten copy, with its eight evidence-corruption assertions. That script is not today's acceptance driver.

The plugin section of the suite is self-contained. `tests/agent-tools/make_plugin.py` builds throwaway HOME directories whose skill and playbook files are generated text, and whose `check-plan.mjs` is the committed, byte-for-byte copy in `tests/agent-tools/fixtures/pstack/` (with the MIT license and provenance of plugin `2.0.0-rc.5`; the suite checks its sha256). The section never reads or copies from the real HOME and strips `T3_PSTACK_ROOT`, `CLEARCASE_SKILLS_DIR` and `CLEARCASE_CHROMIUM`. The copy is real checker code, not a stand-in, so the valid and invalid plan tests prove the canonical checker's own verdict through discovery, and a permissive checker could not hide a broken path. The real-plan step stays an honest FAIL on the format backlog, and a synthetic valid plan is the check-plan PASS control, so the composite PASS path is tested without the backlog. Expectations that moved from SKIPPED (3) to FAIL (1) are stricter, and the two relock refusals (an unreadable installed file; a refused relock leaves the lock unchanged) are restored for the leaf relock. What went with the retired `pstack-upstream`, `--checkout` and `--allow-drop` section is tested as the retirement itself. Other tests earlier in the suite (the real-plan checker, the doctor in this environment, the leaf-skill copies) still depend on the host's installed plugin and leaf skills. They prove semantic newest-version selection, explicit-root precedence, identity recording, required files, missing plugin and checker failures, version/manifest/registry mismatch, unsupported major version, invalid SHA, fallback only on absence, registered plugins with a missing or empty cache or an unreadable, malformed or wrong-shaped registry (all FAIL), the retired `pstack-upstream`/`compare-upstream` failures, empty and relative HOME, a HOME with a trailing slash, a single discovery per receipt, and changed plugin provenance during a run. Leaf-pin tests still reject unreadable directories, FIFOs, missing skills and drift. Generic command failures retain their exit codes and captured diagnostics; stale evidence now explicitly FAILs.

Escalation tests prove missing linkage, source, exact/clean SHA or bounded question cannot write; complete request/outcome records retain the task fields without dispatch. Spend tests distinguish unavailable and zero, require an actual source, reject invalid numbers and prove overspend targets do not stop commands. These are tooling behavior tests, not evidence of a real escalation, live Linear agreement, provider billing, hosted deployment or deadline enforcement.

The suite exits nonzero on any unexpected behavior. `check-plan` can independently remain FAIL for the real plan even when every tooling behavior test passes.

## Fix-diff test protection

`scripts/agent-tools/test-guard --fix-base REVIEWED_SHA --findings PATH` runs the guard,
and so does `verify test-guard` with the same arguments. `receipt --name CHECK --fix-base REVIEWED_SHA
--findings PATH -- COMMAND...` runs the guard before the command inside the same receipt;
a refusal prevents the command. All three produce a required PASS/FAIL receipt at clean HEAD.
The base must be an ancestor.

CI runs it from the repository. A fix round commits its findings as a manifest,
`docs/acceptance/fix-rounds/<ISSUE>-<round>.json`: the findings JSON below plus `"schema": "clearcase-fix-round/1"`,
the canonical `unit`, `fixBase` (the reviewed commit's full SHA) and `reviewFindingsSha256` (the content hash of the
review's findings file). The reviewer's findings file, the one `review-record` retains, carries
`"protectedTests": [{"file", "name"}]` (a list; empty only when the review names no test) and the manifest's `tests`
must equal it. The fix worker commits the manifest first, with the red tests. `scripts/agent-tools/fix-round-guard
--base REF [--root DIR]` lists the manifests added or changed between the merge base with REF and HEAD, and runs
the guard at HEAD for each one, with one `test-guard` receipt per manifest. A deleted manifest, a malformed one, or a
`fixBase` that is not a full SHA of an ancestor fails (exit 1).

A branch with no new or changed manifest exits 0, prints `nothing to protect` and writes a `fix-round-guard`
receipt whose `guard.nothingToProtect` is true: the receipt says no guard ran, and approval never accepts it as a guard
receipt. That exit is refused, with exit 1, when the pull request is a fix round: `--require-manifest` (CI passes it
for a pull request labelled `fix-round`, which the coordinator applies when it dispatches the fix), or `--ledger DIR
--branch feature/<id>-<slug>` when the coordinator's ledger records a `fix` dispatch for that branch's unit. With
`--ledger`, the ledger and not the manifest names what the guard compares against: a manifest whose `fixBase` is not
the commit of the review the ledger recorded before the unit's first `fix` dispatch, or whose `reviewFindingsSha256`
names other findings, refuses, and so does a `fix` dispatch with no review recorded before it. CI has no copy of the
ledger, so there the manifest's `fixBase` is used, and the binding at `approve` is what ties it to the review.

The CI job's `test guard` step runs on pull requests only. It adds a detached worktree at the pull request's head
(GitHub tests the merge commit, which would include the base branch's later changes) and a second one at the base
branch (`origin/<base>`), and runs the base branch's `fix-round-guard` with `--root <head worktree>` and
`--base origin/<the PR's base branch>`. The base copy carries the guard and the Python tools, so a pull request cannot
weaken the check that judges it; the installed `node_modules` (TypeScript) are linked in from the checkout, so a pull
request that changes `bun.lock` also changes the parser, and that shows in its diff. When the base branch has no guard
yet, the pull request that adds it runs its own copy and the step says so. The runner has no Node, so the step sets
`CLEARCASE_NODE` to Bun and the receipt's `node` row records Bun's version. The step runs even when `check` or `test`
failed. A manifest stays in the tree, so a wave PR into `dev` runs every manifest its tickets added, at the wave head:
a later ticket in the same wave that changes a protected file needs a reviewed `assertionCountReasons` entry in that
manifest, for a free test only. CI has no copy of the ledger, so it cannot tell on its own that a pull request is a
fix round; the `fix-round` label, and the binding at `approve` below, are the two controls.

Findings JSON has `tests: [{"file": "tests/example.test.ts", "name": "rejects stale evidence"}]`.
The list must be nonempty. Paths are relative to the repository; literal names must be unique
and active in both revisions. JS/TS syntax is parsed by the project's TypeScript dependency,
without executing the tests. Deletion, rename, skip/todo/only and inactive parent groups fail.
Protection is deliberately conservative: every executable token of the top-level statement containing a named test must stay
unchanged (including its enclosing suite/control flow), so assertion changes (including strengthening) and callback rewrites also fail.
Comments and whitespace may change. The protected closure, resolved from both Git snapshots, is test code only:

- the named test files and the test code they import: files whose path has a test-support directory (`tests`,
  `test`, `__tests__`, `e2e`, `support`, `fixtures`, `__fixtures__`, `__mocks__`, `__snapshots__`, `test-utils`,
  `test-helpers`) or a `.test.`/`.spec.` name, followed transitively through literal import/export/require (including
  JS-to-TS resolution, JSON and repository tsconfig paths). A change to any token of such a helper or fixture module
  refuses, with no exception: a recorded reason does not excuse a loosened matcher, a flipped constant or a
  control-flow change there.
- the runner configuration (`vitest`, `vite`, `jest` and `playwright` config, workspace and setup files, `bunfig.toml`),
  every local module a configuration imports (resolved like any import, so an extensionless `./vitest.shared` or a
  `.js` specifier that lands on a `.ts` file is followed, transitively), every file a configuration names by a path
  expression (a literal, a literal without its extension, `join`/`resolve` or a template literal starting from
  `__dirname`, `import.meta.dirname` or `process.cwd()`, `new URL(..., import.meta.url)`, `fileURLToPath` or
  `require.resolve` of one), and the `package.json` scripts `test*`/`pretest*`/`posttest*`. All of it is compared as
  text. Every `setupFiles`, `setupFilesAfterEnv`, `globalSetup` and `globalTeardown` entry, and every `preload` entry
  in `bunfig.toml`, must bind through those forms to a tracked file, or name a package the root `package.json`
  declares; any other entry (a variable, a call, a spread, a shorthand property, an ignored or missing file, a
  `preload` that is not a string or a list of strings) fails closed. An `exclude` edit in the configuration or in a module
  it imports, a new setup file or a changed test script refuses; an unresolved local configuration import fails closed. For a
  `package.json` only the fields that steer module resolution (`name`, `type`, `main`, `module`, `browser`, `imports`,
  `exports`) are compared otherwise, so a dependency or version edit passes.
- fixtures: every file in a fixture directory (`fixtures`, `__fixtures__`, `__mocks__`, `__snapshots__`) under a
  protected test's top-level directory, and every file a protected test or helper reads by literal path
  (`readFileSync('p')`, `readFile`, `Bun.file`, `join(__dirname, 'p')`, `new URL('p', import.meta.url)`), must keep its
  Git blob. A new fixture may be added. A read by a computed path (a variable, a loop) is not bound and does not fail
  closed, since real tests read fixtures that way; the fixture directories are protected whole instead.
- resolver inputs read from Git (tsconfig, tracked extended configurations). Missing or unsupported extended
  configurations fail closed, with one exemption: SvelteKit's generated `.svelte-kit/tsconfig.json`, which Git ignores,
  so neither snapshot has it; the `$lib` alias it carries is built into the guard. Nonliteral or unresolved local imports refuse; symlink and submodule dependencies fail
  closed without being followed; external packages are bound by the lockfile, not traversed; private RAWS/.local
  imports refuse without being read.

The module under test is not in the closure. Application code (`src/`, `scripts/` and any path outside the
test-support directories above) is neither followed nor compared, so a fix that changes the module its named test
imports passes. A test helper that lives outside these directories is not protected unless a named test file or a
configuration reaches it by a literal path that lands in them; keep helpers under a test-support directory.

A protected test file keeps every top-level statement as reviewed except its free tests: top-level `test`, `it` and
`describe` calls that hold no named test. Tests in a file run in order and a `describe` body runs while tests are
collected, so the guard bounds both what a free test may contain and where it may change:

- nothing changes up to the file's last named test. A free test may be added, changed or dropped only after it, so no
  new code runs before a named test.
- a free test that is added or changed is an allowlist, not a list of forbidden calls: the runner's own
  `test`/`it`/`describe` (or `.skip`/`.todo`) with a literal name, a callback without parameters and at most a numeric
  timeout; a `describe` body holds only such registrations. A test body holds `expect(...)` or `expect.soft(...)`, then
  `.not`/`.resolves`/`.rejects`, then one `.toXxx(...)` matcher; the asymmetric `expect` members (`any`, `anything`,
  `arrayContaining`, `objectContaining`, `stringContaining`, `stringMatching`, `closeTo`) and `expect.assertions`/
  `hasAssertions`; plain calls into the module under test (an import binding, a file declaration, a local, or an
  unbound name that is not a runtime global); and a short list of pure builtins (`Object.keys`, `JSON.parse`, `Math.*`,
  `new Map()`, `String(...)`, ...). `const`/`let`, `if`, `for...of`, `try` and arrow callbacks are allowed. Everything
  else refuses: `vi`, `vitest`, `jest`, `chai`, hooks and other framework names whatever they are bound to (Vitest
  hoists `vi.mock` by name), any other use of `expect` (`expect.extend`, passing `expect` on), `globalThis`, `process`,
  `require`, `Reflect`, `Proxy`, `Function`, any other global, `constructor`/`prototype`/`__proto__`, assignment and
  update, `delete`, dynamic `import()`, `this`, `import.meta`, computed member access, getters, classes, `.only`,
  `.concurrent`, `.each` and computed test names.
- a new import needs the reason and must bind names (a side-effect import refuses even with one). Imports evaluate
  before the named tests, so it may name only a module the reviewed test already loads (one the reviewed file
  imports, or a helper or setup file in the protected closure), or a tracked module under test that is unchanged since
  the fix base and that, followed through its imports (type-only ones excepted), does nothing at import time and never
  reaches the test framework. Doing nothing at import time means every top-level statement is a declaration (import,
  export, function, class, enum, variable, type, `export default`) and no call, `new`, tagged template, JSX element,
  `await`, assignment, update, `delete`, decorator or class static block appears outside a function body; a property
  read is not counted. A package the reviewed file does not import refuses, since its import-time effects cannot be
  inspected; Node and Bun builtins pass. A new import of a test file refuses.

A changed free test, a new import or a dropped free test needs a nonempty `assertionCountReasons[file]` entry; the
reason excuses nothing outside the bounds above. Touched JS/TS test files cannot lose assertion calls
(`expect`/`assert`) unless the findings include that entry for the file; it never allows changes to a named test.

The module under test may change freely, but code the named tests load must not change what an assertion proves.
Every changed module outside the protected closure and the runner configuration is checked, wherever it lives: the
module under test, and any file in a test-support directory, since application code can load one (`src/support/`,
`src/fixtures/`, a helper under `tests/`) into the named test's process. Test files (`.test.`/`.spec.` names) are not:
the runner collects each as an entry of its own and isolates it, and their assertion counts are checked above. That
holds only while test files are isolated: when a runner file's code (comments aside) or a test script turns isolation
off (`isolate: false`, `--no-isolate`, a single fork or thread), a test script runs `bun test` as a command, or a
named test imports `bun:test`, any changed test file outside the closure fails closed. Such a changed module (a JS/TS file, or a Svelte component's script) refuses
when it:

- imports, re-exports, requires or loads `vitest`, `jest`, `chai`, `bun:test` or a `@vitest`/`@jest` package, or passes
  one of those names to any call (a require made by `createRequire`, `import.meta.resolve`);
- uses an unbound `expect`, `vi`, `vitest`, `jest` or `chai`, or reads `import.meta.vitest`;
- names the matcher registry through `Symbol.for('...jest...')`, or calls `Symbol.for` with a computed name;
- uses the global object (`globalThis`, `global`, `window`, `self`, a property chain of them, or a variable
  initialised to one) with a computed key (anything but a literal or `Symbol.for(literal)`), by a runner name
  (`expect`, `vi`, `test`, the hooks, or any name containing `vitest`, `jest` or `chai`), as a call argument, in a
  spread, or in a destructuring by such a key, such a name or a rest element;
- newly loads (through an import its fix-base version does not have) a test file, or support code that does any of
  the above, followed through the support files it imports; an unresolved local import there fails closed.

A local function named `expect`, and literal reads of the global object (`globalThis.performance`, or
`const g = globalThis as {...}` then `g.__clearcase`), are fine. A changed module may load an unchanged module under
test freely, since application code is trusted as reviewed.

Computed names (GRS-148 decision): the guard refuses the computed routes listed above rather than leave them to the
reviewer. It reads code statically, so the re-check reviewer still owns what it cannot see: code generation (`eval`,
`Function`, a constructor chain), the global object reached at run time without being named in the syntax above (the
return value of a function, a non-literal dynamic `import()` or `require`, an `import.meta.glob` pattern newly matching
existing support code), and a fix that special-cases a test's input.

Unsupported named syntax or changed Python/shell test sources fail closed, and so does a protected file importing a
module the resolver cannot bind, a `.svelte` component included; this draft does not claim semantic understanding of
arbitrary test frameworks.

## Exact-revision approval ledger

`approve --unit ISSUE/STAGE --sha FULL_SHA --review REVIEW.json --findings FINDINGS.json
--check-receipt PATH [--check-receipt PATH ...] --approved-by COORDINATOR` appends a ledger row
inside its receipt's `approval` field. A row becomes `approved` only at clean exact HEAD with
a PASS fresh review and every declared deterministic check PASS at that SHA and checkout.
A refusal is receipted as FAIL with `approval.state: refuse`, never an approved row.

The review JSON contract is `schema: clearcase-review/1`, `sha`, `verdict: PASS`, distinct
`reviewer` and `implementer`, `fresh: true`, offset-aware `reviewedAt`, `findingsSha256`,
`unresolvedFindings` and a nonempty unique `requiredChecks` list of `{name, execution, inputs}` requirements. The findings JSON holds
`sha`, offset-aware `updatedAt`, and the identical `unresolvedFindings` list. Each unresolved
finding has `id` and `severity`; only `low`/`P2` permits approval. High/P0, medium/P1 and unknown
levels block it. Findings newer than the review (timestamp or file modification time), changed
hashes, dirty trees and missing/stale/failed/duplicate check receipts all refuse approval.
Receipts and their captured stdout/stderr join the review and findings as fingerprinted inputs.

Before approving a push, a caller runs `approval-check --unit ISSUE/STAGE --sha FULL_SHA
--approval-receipt PATH`. It requires the same clean checkout/revision, verifies the approved
row and rereads every input fingerprint and capture. This is an append-only local receipt
ledger, not a signature or a proof that reviewer identity/freshness was independently verified.
Its required-check contract comes from the reviewer. The coordinator's push hook is meant to invoke the reader
through `scripts/agent-tools/pre-push` (see [Ledger store and push hook](#ledger-store-and-push-hook)); this repository
does not install that hook, and no remote push, reviewer launch or external approval is performed here.

### The guard binding

Once the store's log holds a recorded `fix` dispatch for a unit, `approve` and `approval-check` need a PASS
`test-guard` receipt (`approve ... --guard-receipt PATH`) at the approved HEAD. The binding is read from the ledger,
not from the worker's files: the review that prompted the fix is the unit's latest `review-record` before that
`fix` event, and the receipt must show (1) a `fixBase` equal to that review's recorded SHA, (2) a manifest whose
`reviewFindingsSha256` equals the content hash of that review's recorded findings and whose `unit` is the unit, and
(3) a manifest `tests` list equal to the recorded findings' `protectedTests`. A worker-written manifest with a later
`fixBase`, another findings hash or a shorter `tests` list refuses. When the recorded review lists no `protectedTests`
field the approval refuses; an empty list records `guard.nothingToProtect` and needs no receipt. The row keeps the
binding and the receipt joins the fingerprinted inputs, so editing the receipt afterwards refuses at readback.
A unit with no recorded `fix` dispatch approves as before.

## Model-sheet verification

`verify models --model-sheet PATH --catalog PATH` reads a candidate or current sheet without
writing settings. Without `--model-sheet` it reads `$XDG_CONFIG_HOME/t3-pstack/models.md`,
or `~/.config/t3-pstack/models.md`. Supply a fresh `orchestrator_capabilities` result as JSON
with `providers` and an offset-aware ISO `capturedAt` ending in `Z` or `±HH:MM` (offset-free timestamps refuse before age calculation); the snapshot must be at most one hour old
(future clock tolerance five minutes). The tool makes no network request or model launch.

The selected canonical plugin's unmodified `setup-pstack/scripts/t3-sheet.mjs` validates role,
provider, model and option availability, including implicit tier defaults. ClearCase additionally
rejects effort `max`, UltraCode and inherited/auto targets. Missing sheets, catalogue models or
validator prerequisites produce a required FAIL receipt. The sheet, catalogue, canonical
validator and defaults are fingerprinted alongside plugin provenance. A fresh local snapshot
is caller-supplied evidence, not an independently authenticated catalogue or dispatch approval.

## Local dispatch bookkeeping

`dispatch --unit GRS-104/implementation --phase initial --task-id ID --deadline ISO_TIMESTAMP`
reserves a local attempt in the receipt store. Units use the original issue and the fixed
`implementation` or `review` stage; changing a task ID, checkout or revision does not reset it within that store.
The initial deadline must be future, within 90 minutes for implementation or 30 for review,
and cannot be changed by a restart. Every later attempt (`fix`, `recheck`, `escalation`, `infra-retry`) gets its own
deadline when it is dispatched: `--deadline` if given, else the same limit from now, and either way in the future
and within the limit. A fix dispatched three hours after the initial attempt is accepted. The receipt's
`attemptDeadline` is this attempt's, `deadlines` maps each recorded phase to its deadline and `deadline` keeps the
unit's initial one. Use the same `--receipts` store for every attempt.

Phases `fix`, `recheck`, `escalation` and `infra-retry` each permit one record. Recheck requires
a fix, escalation requires a recheck, and exhausting fix/recheck/escalation stops the unit.
Counts and deadline are copied into every receipt's `dispatch` field; refusals have
`outcome: refuse`, a reason and nonzero exit. A stable `--failure` requires `--diagnosis`;
repeating the same failure and diagnosis refuses the next attempt. A dispatch whose own deadline is already past
or beyond the limit is refused. Nothing here stops a task that overruns its deadline: that is the coordinator's job.
A kernel file lock covers reading history and appending the receipt,
so simultaneous callers cannot reserve the same remaining attempt. Corrupt history refuses.

`--phase cancel --cancel-outcome confirmed|failed --reason TEXT` records an external cancellation
outcome, retains counts/deadline/task identity and stops later attempts. Failed cancellation
is a FAIL receipt with `outcome: cancellation-failed`; confirmed is `cancelled`. This command
never launches, kills, polls or contacts a task. `dispatchPerformed` and cancellation's
`performedByTool` are false. It is bookkeeping, not a scheduler, watchdog, real cancellation
proof or escalation authorization; the separate linked-escalation contract still applies.
Stall assessment, checkpoint grace, bounded-long-test declarations and live launcher integration
remain unimplemented. Removing/changing the receipt store would discard this local history.

### Guard repository identity

The receipt revision collector supplies the guard's expected toplevel realpath, HEAD and
resolved fix base. Every guard Git query (including object-existence checks) strips all
`GIT_*` overrides, as the collector does. A mismatch refuses before running the command.
The receipt revision includes `toplevel` and `head` as its repository identity.

### Required check execution provenance

A reviewer binds each requirement to the receipt `execution` object and `inputs` list.
Execution records exact argv, shell-quoted command line, an argv digest, cwd, the resolved
executing binary and byte fingerprint, and PATH-resolved bun/python3/bash fingerprints.
`--tool bun` discovery cannot substitute for the binary that actually executes bare `bun`.
Input arguments naming files join explicit `--input` files automatically. Reviewers must
list further external/transitive data inputs explicitly; repository files are bound by SHA.
No requirement can be satisfied by `--name` alone or by an older names-only review.

Children drop all GIT_* and PYTHON* overrides, interpreter startup hooks (BASH_ENV/ENV,
SHELLOPTS/BASHOPTS, NODE_OPTIONS/BUN_OPTIONS), and LD_PRELOAD/LD_LIBRARY_PATH. Execution
records PATH and TMPDIR plus hashes of every other retained environment value, including
all CLEARCASE_* variables; secret values are never copied. PWD/OLDPWD/SHLVL/_ are excluded
from the snapshot. Inputs, resolved binary identities and the environment are checked before
and after execution, against the review requirement at approval, and again at approval-check.
Approval retains every supplied check input transitively; stale external inputs refuse both
boundaries. Changed PATH shims, runtime bytes, TMPDIR and behavior overrides require a new
review and check. Receipts still trust the OS and reviewed binaries; they are not signatures.

### Recorded review and attempt history

The trusted reviewer/coordinator first calls `review-record --unit ISSUE/STAGE --review PATH
--findings PATH` in the same receipt store. It retains both original byte streams in read-only
content-addressed blobs and appends their hashes and original severities to `events.jsonl`.
Approval uses the latest recorded snapshot for the original unit and checks the supplied copies
against it. A newer recorded review invalidates earlier approvals and review snapshots at
both approve and approval-check; an older empty/low review cannot be resurrected. Rewriting
both worker copies cannot downgrade a finding; later review records retain original severity
for each finding ID. A fresh review can mark a finding resolved by removing it from the
unresolved list, while its original severity remains in history. Review-record is a trusted
caller boundary; it does not authenticate a human or launch a reviewer.

Review and dispatch events are append-only, sequence-numbered, and chained by SHA256 with
a separate stored tip. Every attempt receipt must match its event, including counts. Budgets
are derived from accepted phase events, rather than copied worker counts. Edited/deleted
receipts, altered chains, truncated history, mismatched stored counts and unindexed legacy
attempt receipts refuse. Dispatch reservation and receipt append retain the unit lock.
A crash between log append, tip update and receipt write fails closed; no automatic reset.
The coordinator must own and retain the store across workers. Hash chains detect ordinary
edits; full replacement of the store, its tip and blobs by the same privileged local writer
cannot be authenticated by a local unsigned ledger and remains outside this boundary.

### Canonical unit keys

All review-record, approve, approval-check and dispatch callers use uppercase Linear keys
with a positive decimal issue number without leading zeroes and lowercase stage. Identity
normalisation is case-insensitive (`grs-0104` maps to `GRS-104`), but noncanonical spellings
are refused with the canonical key rather than creating aliases or a new budget/deadline.
Only `GRS-104/implementation` or `GRS-104/review` forms are stored for this issue.

Input fingerprints retain the supplied absolute path plus its resolved realpath, so retargeting
an external input symlink refuses at approval and readback. Review registration serialises
original-severity retention under the event append lock, including concurrent registrations.

### Ledger store and push hook

`review-record`, `approve`, `approval-check`, `dispatch` and `pre-push` keep their events, blobs, locks and receipts
in one ledger store: `--ledger DIR`, else `CLEARCASE_LEDGER_DIR`, else the receipt store. A `--ledger` or
`CLEARCASE_LEDGER_DIR` value must be an absolute path (a relative one resolves against each caller's working
directory and splits the store, so it refuses). The store must resolve to a
path outside the checkout the command checks (`--root`, or the checkout holding the tools); inside it, the command
refuses before it reads or writes anything, with exit 1 and no receipt. The default `.local/agent-receipts/` is
inside the checkout, so these commands need an explicit store. The coordinator keeps one store outside every
checkout, for example `${XDG_STATE_HOME:-~/.local/state}/clearcase/ledger`, passes it to every call and runs the
tools from its own `dev` clone with `--root <worktree>`. Check receipts from `receipt` may stay in the worker's
receipt store; `approve` names them with `--check-receipt`.

A PASS `approve` appends an `approval` event to the log, holding the approval receipt's path (stored as written,
not shortened to `~`, so a reader under another HOME or a sibling home directory opens the same file), its
`approval` row and its `inputs`, and the receipt records the event's hash as `approvalEvent`. `approval-check` refuses an approval
receipt whose event is missing from the log or differs from it, so an edited, copied or forged receipt, or a log
rewritten without the event, is not a ledger row. A refused approval appends nothing.

`scripts/agent-tools/pre-push [--ledger DIR] [--root DIR] [REMOTE [URL]]` reads Git's pre-push lines on stdin. For each
pushed `refs/heads/feature/<linear-id>-<slug>` it takes the issue's `<ISSUE>/implementation` unit, finds the latest
approval event for that unit at the pushed commit and runs `approval-check` on it, which writes a receipt in the
store. A missing row, another issue's row, a noncanonical key such as `grs-0104`, a branch with no Linear key, or a
checkout whose clean HEAD is not the pushed commit prints `pre-push: BLOCKED` and exits 1. Other refs and deletions
pass; the hook keeps its own rules for them. The hook (in `orch-bin`, outside this repository) calls the script
from the coordinator's `dev` clone, never from the pushing checkout, whose copy of the tools the worker can edit:

```bash
refs=$(cat)   # the hook's stdin, read once; its own loop then reads "$refs"
CLEARCASE_LEDGER_DIR=$LEDGER "$DEV_CLONE/scripts/agent-tools/pre-push" --root "$(git rev-parse --show-toplevel)" \
  "$@" <<<"$refs" || status=1
```

This repository installs no hook and changes no `orch-bin` file. Until the coordinator adds the call, the leak-scan
file under `.orchestration/push-approved/` remains the only push gate.

**The ledger is a record, not a proof.** Every agent runs as the same Unix user, so any of them can mint an `approved`
row with self-written JSON: write a review, a findings file and a check receipt, call `review-record`, then `approve
--approved-by anyone`, and `pre-push` passes. Nothing in the store authenticates who wrote a review or who approved.
The controls that hold without a signed store are the guard binding above (the guard result is bound to the reviewed
commit and to the findings the ledger recorded, not to files the worker wrote), the base branch's guard in CI, and the external wave review. Until a signed store
exists, treat an approved row as the coordinator's note to itself.

What the store does not protect against: every agent runs as the same Unix user, so any process can rewrite the log,
its tip and its blobs together, and the hash chain then verifies. Outside the checkout, the store is out of reach of
`git clean`, worktree removal and edits confined to the worker's tree, and the chain detects partial edits, truncation
and a receipt that differs from its event. It is not signed, not on another machine and not backed up; deleting the
store discards the attempt history and every approval, and later pushes then block. A crash between the log append,
the tip update and the receipt write fails closed and needs the coordinator to repair the store by hand.
