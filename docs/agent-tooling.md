# Agent tooling

Implementation and review agents run the project's planning checks and verification capabilities through `scripts/agent-tools/`. Every entry point works from a fresh non-interactive shell in any worktree and needs no GUI or shell profile. Every check writes a receipt; [Receipts](#receipts) lists exactly which commands do. CC-27 ([GRS-35](https://linear.app/vaper/issue/GRS-35/set-up-pstack-and-verification-skills-for-agent-cli-access)) owns this tooling. It implements no application behavior.

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

| Component | Source | Version or revision | Access and license |
| --- | --- | --- | --- |
| pstack skill bundle: `poteto-mode` and 52 companion skills | [`backnotprop/pstack`](https://github.com/backnotprop/pstack), designated by the user on 2026-10-08. It is a harness-neutral mirror of [`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack). Installed in `~/.agents/skills/` with the [skills CLI](#install-and-update-the-global-skills); agent skill directories such as `~/.claude/skills/` hold symlinks into it. | 0.15.23, revision `1f0f9c3bac03c4297f6fc8f7644fa412eda57085` (2026-10-13), which mirrors `cursor/plugins/pstack@837067b` (short ID as the mirror records it; upstream-branch commit `c3ed187a`, merged on `main` in `1f0f9c3bac03`). Pinned per skill by content hash in `scripts/agent-tools/skills.lock.json`. | MIT, Copyright (c) 2026 Lauren Tan. Public; no credentials. |
| `poteto-mode/scripts/check-plan.mjs` | Same bundle. | Pinned with `poteto-mode`. Dependency-free Node ESM. | Same. |
| Matt Pocock skills (`ask-matt`, `domain-modeling`, `codebase-design`) | [`mattpocock/skills`](https://github.com/mattpocock/skills), paths `skills/engineering/NAME`, as `~/.agents/.skill-lock.json` records. Installed in `~/.agents/skills/` with the skills CLI. | Revision `49dd158d1076134a641b33efb035946536778336` (2026-10-09). Pinned by content hash in the same lock; `provenance.matt-pocock` holds the reproduce command. | MIT, Copyright (c) 2026 Matt Pocock. Public; no credentials. |
| `scripts/planning/check.py`, `generate.py` | This repository. | Git revision. | Repository. |
| Bun, the app toolchain | The user's choice of 2026-10-08 (`AGENTS.md`, App toolchain). On `puk` it comes from the official installer at <https://bun.sh>, in `~/.bun/bin`, and `bun` and `bunx` are linked into `~/.local/bin`. Arch Linux packages it as `bun` in `extra`. | Stable 1.4.2, the minimum the doctor accepts; see [Bun](#bun). Upgrade with `bun upgrade --stable` (`pacman -Syu bun` for the package). The pin moves only with a reviewed commit. | MIT for Bun's own code; bundled components keep their licenses. Public; no credentials. |
| Runtimes | System packages. | bash >= 4.4, Python >= 3.10, Node.js >= 18, git, and Bun as above. Tested with bash 5.3, Python 3.14, Node 26.10, git 2.56 and Bun 1.4.2 on CachyOS. | Distribution packages. |

How the pstack pin was established:

- At the pinned revision, `.cursor-plugin/plugin.json` names `pstack` 0.15.23 by Lauren Tan under the MIT license, and `LICENSE` is the MIT license. `MIRROR.md` explains the mirror: branch `upstream` holds Cursor's files verbatim, and `main` is `upstream` plus the mirror's harness-neutral edits.
- All 53 skills in the revision's `skills/` are installed in `~/.agents/skills/` on `archlinux` and byte-identical. On 2026-10-15 the maintenance worker updated them with the skills CLI and compared them with `diff -rq` against a fresh clone. `1f0f9c3bac03` was `main` HEAD.
- Before that update, every installed skill matched the Git tree hash the skills CLI had recorded for it, so the update overwrote no local edit. Every pstack skill on `archlinux` then matched 0.15.9.
- Every upstream skill at that revision is installed and pinned. The relock added `in-your-own-words` and `ketchup`, new since 0.15.15.
- `tdd` belongs to pstack, not to the Matt Pocock skills.
- The previous pins were 0.15.15, revision `3a604672c46cd8187d2b19980eae0a34f9f91138`, set on `puk` on 2026-10-09 (record: `.orchestration/reports/CC-27/pstack-provenance-20261009.txt`), and before it 0.15.9, revision `124f622bcaeac490e7e9dac6af83f3ef9611d554`. `puk` keeps 0.15.15 until someone updates it the same way, and its doctor fails on the pin until then.

The lock's `provenance.pstack` block records the same facts. Its reproduce command prints nothing when the install matches:

```sh
git clone https://github.com/backnotprop/pstack.git p && git -C p worktree add ../p1f0 1f0f9c3 && for d in p1f0/skills/*/; do n=$(basename $d); [ -e ~/.agents/skills/$n ] && diff -rq $d ~/.agents/skills/$n; done
```

`scripts/agent-tools/verify pstack-upstream --checkout DIR` makes the same comparison from the pinned revision's Git objects in any clone that contains it, so files in the clone's working tree do not count. Like the pin, and unlike the reproduce command, it skips `node_modules`, `__pycache__` and `.DS_Store`. It also checks the lock and writes a receipt. Install pstack only from this source; do not install a package merely because it is named pstack.

The leaf skills `to-spec`, `to-tickets` and `implement-spec` are absent. The doctor reports them as INFO, and nothing here installs or claims them.

pstack's `orch` and `watch-pr` scripts also run on bun, and this project does not use them. The doctor requires Bun for the app, not for them.

## Bootstrap, upgrade and removal

Prerequisites are bash, git, python3 and node on a standard PATH such as `/usr/local/bin:/usr/bin:/bin`, Bun at the app's minimum version on PATH or named by `CLEARCASE_BUN`, and the skill bundle in `~/.agents/skills`. The checkout needs `origin/dev` or `dev` for the default receipt base; otherwise pass `--base REF` (see [Revision identity](#revision-identity)). On a new Arch-family host:

```sh
sudo pacman -S --needed bash git python nodejs bun
npx -y skills@1.7.2 add backnotprop/pstack -g -y -a AGENTS -s '*'   # AGENTS: the agents you use, e.g. claude-code codex
npx -y skills@1.7.2 add mattpocock/skills -g -y -a AGENTS -s ask-matt domain-modeling codebase-design
scripts/ci/install-chrome.sh   # the Chromium that CI and verify app use
scripts/agent-tools/bootstrap
```

On `puk`, `~/.local/bin/bun` lies outside that standard PATH, so a shell started with only `/usr/local/bin:/usr/bin:/bin` needs `CLEARCASE_BUN=~/.local/bin/bun`. `docs/acceptance/CC-27/rerun.sh` sets it that way.

`bootstrap` runs the doctor, then creates ignored local state only, `.local/agent-tools/skills` (a symlink to the resolved bundle) and `.local/agent-tools/bootstrap.json`. Rerunning it reports `unchanged`. If the link already points somewhere else it refuses with exit 1 instead of creating a second installation. It writes no global files and no tracked files. Bootstrap is optional; without it the tools find `~/.agents/skills` directly.

To use a bundle elsewhere, pass `--skills-dir DIR` to any command or set `CLEARCASE_SKILLS_DIR`. An explicit directory is used as given, with no fallback.

The doctor fails and names each pinned skill whose installed content differs from the pin, so a bundle change cannot pass unnoticed. To move pstack to a new upstream revision:

1. Clone the upstream at that revision: `git clone https://github.com/backnotprop/pstack.git .local/pstack-upstream && git -C .local/pstack-upstream checkout --detach REV`. `.local/` is ignored.
2. Install the revision's skills on the host with the skills CLI, as [Install and update the global skills](#install-and-update-the-global-skills) describes. The CLI installs upstream `main` HEAD, so clone the same revision in step 1. The tools never write to `~/.agents/skills`.
3. Compare the install with `diff -rq`, as in the reproduce command above. It must print nothing.
4. Run `scripts/agent-tools/bootstrap --relock --checkout .local/pstack-upstream`. It reads the skills at the checkout's HEAD from Git objects. It refuses a path without a Git HEAD that carries `.cursor-plugin/plugin.json`, a checkout none of whose skills is installed, and an install that differs from HEAD. It also refuses to remove a pstack pin that the checkout does not install unless you pass `--allow-drop`. Otherwise it pins every installed skill of the checkout as group `pstack` and rehashes the other pins. It prints the revision, the skills it added, moved to `pstack` or removed, the upstream skills that are not installed, and whether HEAD differs from `provenance.pstack.revision`.
5. Edit `provenance.pstack` in `skills.lock.json` (revision, its date and subject, version, license, `mirrorOf`, `notInstalled`, `checkedAt` and `checks`) and the table above. Provenance is never written automatically.
6. Run `scripts/agent-tools/verify pstack-upstream --checkout .local/pstack-upstream` and `scripts/agent-tools/doctor`. Both must pass. Commit the lock and this document through a reviewed pull request into `dev`.

For a skill outside pstack, such as the Matt Pocock skills, compare the installed change with its upstream, update its block under `provenance`, and run `bootstrap --relock` without `--checkout`. That rehashes the existing pins and changes no membership. A pin change is a reviewed repository change, never an automatic one.

### Install and update the global skills

The skills CLI ([`vercel-labs/skills`](https://github.com/vercel-labs/skills), npm package `skills`) owns `~/.agents/skills`. It records each skill's source repository, path and Git tree hash in `~/.agents/.skill-lock.json`, and it links the skills into the skill directory of each agent the user selected. Skills it did not install, such as the user's own symlinks, are not in that file, and it leaves them alone. Version 1.7.2 was used on 2026-10-15.

1. Back up `~/.agents` and the agent skill directories that link into it, for example with `tar -cf` of `~/.agents` and every directory that `find ~ -maxdepth 4 -type l -lname '*/.agents/skills/*'` finds.
2. Check that no installed skill was edited by hand. For each entry in `~/.agents/.skill-lock.json`, the Git tree hash of the installed directory must equal `skillFolderHash`. The update overwrites a skill without checking.
3. Update every recorded skill: `DO_NOT_TRACK=1 DISABLE_TELEMETRY=1 npx -y skills@1.7.2 update -g -y`. It updates in place, keeps the user's agent links, and does not reinstall skills the user deleted.
4. Add what `update` cannot: skills new upstream, and skills that upstream renamed. `update` fails, with exit 1, on a lock entry whose recorded name no longer exists upstream; 0.15.15 renamed `Poteto Mode` and `Make Bot UI` to `poteto-mode` and `make-bot-ui`. Run `npx -y skills@1.7.2 add backnotprop/pstack -g -y -a AGENTS -s NAME...`, where AGENTS is `lastSelectedAgents` from the lock file. Without `-a`, `add` links the skills into every agent the CLI knows.
5. After `add` has recorded a renamed skill under its new name, delete the old entry from `~/.agents/.skill-lock.json`. Do not run `skills remove` on the old name, because it removes the directory that both names share.
6. Compare the result with the upstream clone (`diff -rq`), then relock as above.

The T3 Code plugin `t3-pstack` (a pstack variant from [`chhoumann/t3-pstack`](https://github.com/chhoumann/t3-pstack), cached under `~/.codex/plugins/cache/t3-pstack/`) is a separate distribution that T3 Code installs and updates. The project does not pin it, and the doctor does not check it.

To remove, run `scripts/agent-tools/bootstrap --remove`. It deletes only `.local/agent-tools/`. Receipts in `.local/agent-receipts/` and the global skills stay.

### Bun

The app builds and runs with Bun, so the doctor fails unless `bun --version` prints a version at least the app's minimum. The minimum is `package.json`'s `packageManager` field, `bun@MAJOR.MINOR.PATCH` with an optional `+hash` suffix, and the doctor's receipt fingerprints `package.json`. A `package.json` that cannot be read, is not JSON, or pins no `bun@` version fails the doctor. `MIN_BUN` (1.4.2, in `scripts/agent-tools/agent_tools.py`) applies only to a checkout without `package.json`, such as the tests' fixtures.

The doctor uses `CLEARCASE_BUN` when it is set, otherwise the `bun` on PATH. It fails, with a fix, when no bun is found, when the version is older than the minimum, and when `bun --version` does not print exactly one version. That means it fails when `--version` exits nonzero, writes anything to stderr, even with exit 0, or prints on stdout anything other than one line holding a version such as `1.4.2`. White space around that line is ignored; a second line is not. Versions compare as numbers, and a prerelease such as `1.4.2-canary.1` counts as older than `1.4.2`. The row names the bun it checked and where the minimum came from, and the receipt lists that bun's path and its whole stdout as the version.

To move the pin, run `bun upgrade --stable` (`pacman -Syu bun` for the distribution package) and record the `bun --version` it installs. Then change `packageManager` (and `MIN_BUN` with it) in a reviewed commit into `dev`. The tools never upgrade Bun or change the pin themselves.

## Entry points

| Command | Runs | Exit codes |
| --- | --- | --- |
| `scripts/agent-tools/doctor` | OS and bash, Python, git and repository, the revision receipts record (head, base and merge base), Node, Bun at the app's minimum version, planning scripts, skill bundle discovery, required skill files, the content pin, writable receipt directory. Before any install or build, the app/browser prerequisites of `verify app`: `unshare` (and that `unshare -rn` works), `ip`, Chromium and the verify-clearcase runner (see [App verification](#app-verification)). Reports the pinned pstack source and optional tools (gh, tmux). Writes one receipt with the report. | 0 all required checks pass, 1 a check failed, 2 unsupported OS, old bash or no python3 (no receipt, because Python never starts) |
| `scripts/agent-tools/check-plan [--linear-relations PATH] [--require-linear-relations] [--plan PATH]` | `plan-graph` and `plan-format`, plus `linear-relations` when a readback is given (or `CLEARCASE_LINEAR_READBACK` is set). One receipt per step. | 0 every step passed, otherwise the first failing step's code. A required comparison without a readback exits 3. |
| `scripts/agent-tools/verify list` | Lists the capabilities; all are available. Writes no receipt. | 0 |
| `scripts/agent-tools/verify CAPABILITY [--readback PATH] [--plan PATH] [--checkout DIR]` | One capability with a receipt. | The wrapped command's own exit code, or 3 when skipped |
| `scripts/agent-tools/receipt --name NAME [--tool T]... [--input FILE]... -- CMD ARGS...` | Any command with a receipt. A missing `--tool`, `--input`, command or revision is SKIPPED and is not run, and so is one whose version, fingerprint or state cannot be read (see [Evidence failures](#evidence-failures)). | The command's own exit code, or 3 when skipped |
| `scripts/agent-tools/bootstrap [--relock [--checkout DIR [--allow-drop]] \| --remove]` | See above. Plain `bootstrap` runs the doctor, which writes the doctor's receipt. A refused conflicting link, `--relock` and `--remove` write none. | 0 or 1 |
| `python3 scripts/planning/generate.py --compare-linear EXPORT` | Diffs generated briefs against the descriptions in a full Linear export. Writes no receipt unless wrapped in `receipt`. | 0 all match, 1 drift |

All commands accept `--skills-dir`, `--receipts`, `--base REF` and `--root DIR`. `--root` checks a different planning tree, which must be the top of a Git checkout; the tests use it for fixtures. `doctor` and `bootstrap` ignore `--root` and check the checkout that holds the tools. `--base` names the revision that receipts compare against; see [Revision identity](#revision-identity).

Capabilities and the commands they wrap, unchanged:

| Capability | Command | State |
| --- | --- | --- |
| `plan-graph` | `python3 scripts/planning/check.py --require-linear-ids` | available |
| `linear-relations` | `python3 scripts/planning/check.py --require-linear-ids --linear-relations READBACK` | available. A readback is a file the coordinator exports from Linear; this command never fetches live data. |
| `plan-format` | `node ~/.agents/skills/poteto-mode/scripts/check-plan.mjs docs/delivery-plan.md` | available |
| `pstack-upstream` | `python3 scripts/agent-tools/agent_tools.py compare-upstream --checkout DIR` | available with `--checkout DIR`, a clone that contains the pinned revision, which must be recorded as a full commit ID. It reads that commit's Git objects, not the working tree, and ignores replace refs. It checks its `plugin.json` version and license against `provenance.pstack`. It requires every installed skill of the revision to be pinned as `pstack` and no other skill to be. `notInstalled` must list exactly the upstream skills that are not installed. Each pinned skill must match the revision file for file and match its pinned hash; as in the pin, `node_modules`, `__pycache__` and `.DS_Store` are excluded on both sides. SKIPPED, exit 3, without `--checkout` or when DIR does not exist. FAIL when DIR lacks the pinned revision. |
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

Evidence goes to `$CLEARCASE_REPORT_DIR/skill/<run-id>/` when set, else `.local/verify-clearcase/<run-id>/`: `summary.json`, `inner.json`, `health.json`, `clearcase-build.json`, `server.log`, `offline.log` and `screens/*.png`. Ports default to 43600 (app), 43601 (originals) and 43699 (`CANARY_PORT`); `VERIFY_CLEARCASE_PORT` and `CANARY_PORT` override them. Chromium is `CLEARCASE_CHROMIUM`, else `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`. A run takes about 7 seconds on `puk`. The skill's `SKILL.md` documents the subcommands (`preflight`, `live-doctor`, `cleanup`, `self-test`) and how M2 owners extend the drive.

Only committed code is verified: the build is of `HEAD`, not the working tree. A commit or any edit in the checkout while it runs (untracked files are fingerprinted too) turns the receipt SKIPPED, or FAIL if the runner failed (see [Revision identity](#revision-identity)).

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
- A missing tool, input, command or revision produces result SKIPPED and exit 3. git is a required tool of every receipt. The command does not run. SKIPPED never counts as PASS.
- Evidence that cannot be collected is never PASS either; see [Evidence failures](#evidence-failures).
- `check-plan` runs every step, even after a failure, so one run shows all diagnostics. Its summary line names each step's result and anything not run.
- Without `--linear-relations`, `check-plan` says `NOT RUN: linear-relations`. Local ID checks do not prove agreement with the live Linear graph. Use `--require-linear-relations` where the comparison is mandatory.
- The doctor's app rows (`app-unshare`, `app-ip`, `app-chromium`, `app-runner`) are required checks. They need no install, build or listener, so a clean checkout passes them; `verify app` then stops at the runner's preflight, exit 3, until `bun install --frozen-lockfile` has run.

## Receipts

`doctor`, `check-plan` (one receipt per step), `verify CAPABILITY` and `receipt` each write a receipt, and so does the doctor run inside a plain `bootstrap`. `verify list`, `bootstrap --relock`, `bootstrap --remove` and a `bootstrap` that refuses a conflicting link write none; wrap them in `scripts/agent-tools/receipt` when you need a record, as `docs/acceptance/CC-27/rerun.sh` does for `bootstrap`. An entry point that exits 2 before Python starts (unsupported OS, bash older than 4.4, no python3) writes no receipt, and neither does one that cannot create or write its receipt directory (see [Evidence failures](#evidence-failures)).

Each receipt is a directory `<receipts>/<UTC timestamp>-<name>/` with `receipt.json`, `stdout.txt` and `stderr.txt`. The receipt directory is `--receipts DIR`, else `CLEARCASE_RECEIPTS_DIR`, else `.local/agent-receipts/` in the checkout (ignored by Git). Workers point it at `.orchestration/reports/<planning-key>/` in the `dev` clone for machine-local evidence. Committed receipts go under `docs/acceptance/<planning-key>/` and must not contain case material.

`receipt.json` (schema `clearcase-agent-receipt/1`) records:

- `name`, `result` (PASS, FAIL or SKIPPED), `exitCode`, and `reason`: why it is not PASS when the receipt can say. That is a skip, evidence that could not be collected, or the doctor's FAIL rows. It is null for PASS and for a command's own failure.
- `command`, the exact argv, and `cwd`.
- `tools`, git first and then the command's own tools, each with path and the first line of its `--version` output. For bun it is all of its stdout, which the doctor requires to be one version line (see [Bun](#bun)).
- `inputs`, for example the checker scripts, the plan, the readback, or the lock and any `package.json` the doctor checks. Each row has the `path`, the `sha256` of its bytes, and the `size`, `mtimeNs`, `device` and `inode` of the file they were read from, all read before the command runs. After the command exits, every input is read again, and a difference is never PASS (see [Evidence failures](#evidence-failures)).
- `revision`, resolved before the command runs and again after it exits, or for the doctor before and after its checks: `root`, `branch`, `head`, `baseRef` (as requested, or the default that resolved), `base`, `mergeBase`, `dirty`, and `diffSha256` when dirty. The receipt records the first resolution. Every key is present. `head`, `base` and `mergeBase` are null only in SKIPPED or FAIL receipts, and so are `dirty` and `diffSha256` when Git could not report the working tree. `diffSha256` is null when the checkout is clean, and `branch` is `HEAD` when it is detached.
- `dirty` is true when `git status --porcelain`, `git diff HEAD` or the untracked files that are not ignored show anything, so configuration such as `status.showUntrackedFiles=no` cannot hide a change. `diffSha256` hashes the raw `git diff --binary HEAD` output, run with `--no-ext-diff --no-textconv` so a configured diff driver or textconv filter cannot hide a change, and then each untracked file's name with its bytes, a symlink's target or, for a nested repository, all of its files, names hashed as bytes. Ignored files, per `.gitignore`, `.git/info/exclude` and `core.excludesFile`, are not part of it. Git's own change detection is otherwise trusted, for example `core.fileMode`, `core.fsmonitor` and line-ending conversion, and this repository has no submodules.
- `environment`, with OS, kernel, machine, host, bash, caller shell, Python and PATH.
- `startedAt`, `finishedAt` and `durationSeconds`.
- `artifacts`, the paths of the receipt, stdout and stderr.

Paths under `$HOME` are written as `~` so receipts carry no machine-specific home directory.

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
| The output cannot be captured whole, for example a full disk. Or, after the command exits, a capture file's descriptor has no link left, its path is gone or names another file, its size differs from the bytes written to it, or it holds other bytes: the sha256 of the bytes as they were written must equal that of the bytes read back through the descriptor. | The command's exit code and FAIL if it failed. If it exited 0: SKIPPED, exit 3. The reason says `output not captured whole: ...`, for example `stdout.txt: removed during the run` or `stdout.txt: holds other bytes than were written`, and gives the command's exit code. |
| After the command exits, an input is gone or cannot be read whole, or its sha256, size, modification time, device or inode differs from the identity recorded before the run | The command's exit code and FAIL if it failed. If it exited 0: SKIPPED, exit 3. The reason says `input changed during the run: ...` and names each field that differs, for example `inode 1302892 -> 1302893`. |
| After the command exits, the revision cannot be resolved, or its head, base, merge base, `dirty` or `diffSha256` differs from the one recorded, for example after an edit to a tracked file or a commit | As for inputs. The reason says `the revision cannot be read after the run: ...` or `the checkout changed during the run: ...` with the fields that differ. |
| The receipt cannot be written after the command ran | No receipt. The command's exit code if it failed, otherwise exit 3, with a message on stderr. |

The doctor reports the same failures for its own evidence as FAIL rows, `git`, `python3`, `node`, `bun`, `revision`, `skill-pin` or `receipt-input`, and exits 1. Its receipt's reason lists every FAIL row. It reads its inputs, the lock and any `package.json`, again after its checks, and a difference is a FAIL `receipt-input` row. It runs no command, but it resolves the revision again after its checks, as the other entry points do after the command exits. A revision that cannot be read then, or whose head, base, merge base, `dirty` or `diffSha256` differs from the first resolution, is a FAIL `revision` row after the checks, `the revision cannot be read after the run: ...` or `the checkout changed during the run: ...`. So a tracked file edited or an index broken during the doctor's checks gives FAIL, not PASS, unless the change is undone before the second look (see [What receipts prove](#what-receipts-prove)). The receipt records the first resolution. It also fails when it is not launched through `scripts/agent-tools/doctor`, because the bash that runs the entry points is then unknown, and when a planning script, the lock or a pinned skill's file or directory cannot be read, or a pinned skill holds something that is not a file, directory or symlink. If it cannot write its receipt, it exits 1 with `doctor: FAIL. Receipt not written`.

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

## Tests

`bash tests/agent-tools/run.sh` needs bash, coreutils, git, python3 and node, Bun at the minimum (on PATH or in `CLEARCASE_BUN`) for the cases where the doctor and bootstrap pass in this environment, and a checkout with `origin/dev` or `dev`, because its receipts in this checkout use the default base. It must run as a user without root privileges, because root reads files whose permissions deny reading and several cases depend on that. It covers:

- The assertions themselves. `receipt_is`, `receipt_revision` and `receipt_check` fail, showing Python's error, on a receipt that is not JSON or lacks its fields. `lacks` and `lacks_in_receipt` fail when there is nothing to read.
- The synthetic plans `tests/agent-tools/fixtures/plans/{valid,invalid}.md` through pstack `check-plan.mjs`.
- Graph fixtures `tests/agent-tools/fixtures/graph/*.json`. Each one edits a disposable Git checkout of the committed plan (cycle, unmapped issue, scope overlap, stale generated files, Linear readback drift) and carries its expected exit code and diagnostics.
- App verification, in a `git archive` copy of HEAD without `node_modules`: the doctor passes its app rows; `verify app` exits 3 at the runner's preflight, naming the install command and building, starting and contacting nothing; a runner that is not executable is SKIPPED and fails the doctor's `app-runner` row; a missing Chromium and unavailable user namespaces (a test `unshare`) each fail exactly one doctor row. `verify-clearcase self-test` runs too: the clean checkout and a missing Chromium stop at preflight with no bun other than the runner, no Chromium and no connection to a stand-in registry or proxy, and the live doctor fails against a fake `/api/health` that differs in one way at a time (PID, data directory, build ID, revision, build time, no stamp, Bun, ports, journal mode, synchronous, storage error, no pragmas, a PID not running the run's `start.ts`, nothing listening) and passes the matching answer.
- Skipped checks, the receipt writer's output and exit-code preservation, the doctor with no node and with no python3, and bootstrap idempotency, conflict refusal and removal in a fresh Git checkout.
- Revision identity. Receipts record `head`, `baseRef`, `base` and `mergeBase` equal to `git rev-parse` and `git merge-base`, in this checkout and in a synthetic repository whose `dev` moved on after the fork. These cases are SKIPPED, exit 3, and the command does not run: no git (`verify`, `check-plan` and `receipt`), an unresolvable or empty `--base` or `CLEARCASE_BASE_REF`, no default base, an unrelated base, a `--root` below a checkout's top, a checkout without a commit, a copy of the tools outside any checkout, and a `receipt` run outside its checkout or in a nested repository. An inherited `GIT_DIR`, `CLEARCASE_GIT` and odd untracked files (non-ASCII and newline names, broken and directory symlinks) do not change or break the recorded revision. Every PASS receipt in the suite must list git and name all three commits.
- Evidence failures, in a disposable copy of the checkout whose Git data the cases damage and restore. A corrupt index makes `verify`, `doctor`, `receipt` and `check-plan` each refuse PASS, naming the failed `git status` and Git's message, while the intact index records the untracked file as dirty with a fingerprint. These are SKIPPED, or FAIL for the doctor: a missing HEAD tree, HEAD commit or changed file's object, an unreadable tracked or untracked file, an untracked directory Git cannot open (Git exits 0 and warns), a changed file marked assume-unchanged or skip-worktree, an `origin/dev` naming a deleted commit, and a test `git` on PATH that fails `status`, `diff`, `ls-files`, `rev-parse --abbrev-ref`, `rev-parse HEAD^{commit}` or `--version`, or prints a false commit ID. So are an untracked file that disappears between listing and reading, git, node and python3 version probes that fail, a `--tool` that prints no version or cannot start, an unreadable `--input` or plan, an input that changes while it is read (`/proc/self/status`), a command without execute permission, an unwritable receipt directory, one that becomes unwritable during the run, and output that cannot be captured under `ulimit -f`. During the run, these are never PASS either: a test node that renames a valid plan over the invalid one before checking it, as the review's atomic replacement did; an input changed in place (the failing command keeps FAIL and its exit code), replaced by a copy of its bytes, or removed; a tracked file edited, a commit made or the index broken by the command; and a `stdout.txt` capture removed, moved, replaced, appended to by another descriptor or rewritten in place with other bytes of the same size. The doctor fails when an input changes during its run, and when a tracked file is edited or the index broken between its two looks at the revision, by a test `tmux` that it probes after its skill checks; with a test `tmux` that changes nothing it passes. An external diff driver, a textconv filter that prints nothing, a change inside an untracked nested repository and `status.showUntrackedFiles=no` do not hide a change from the fingerprint, and a nested repository with a file name that is not UTF-8 is fingerprinted. A console on `/dev/full` neither stalls the command nor truncates the capture. A 3 MB output, larger than the block in which a capture is read back, passes whole. The doctor fails when it is not launched through its wrapper, and on an unreadable planning script, lock or skill directory, and on a FIFO in a skill. `pstack-upstream` keeps Git's error about a missing revision and fails on an unreadable object or installed file. A relock refuses an unreadable installed file and leaves the lock unchanged.
- The doctor's Bun row through its entry point. It fails with no bun on PATH, a fake bun 1.3.9 on PATH, a prerelease of the minimum, output that is not a version or holds other text, a version followed by a second line, output on stderr, and a failing `--version`. It passes with 1.4.2, with 1.4.2 between blank lines and spaces, and with 1.10.0, so versions compare as numbers. `CLEARCASE_BUN` finds a bun outside PATH, wins over the one on PATH and fails when it names no executable. In the disposable copy, a `package.json` whose `packageManager` raises or replaces the minimum decides the result, and one that names another package manager, has no `packageManager`, is not JSON or cannot be read fails. Where a test checks it, the Bun row is the only FAIL row. The receipt lists the bun checked and fingerprints `package.json`.
- Receipts per command. The doctor writes PASS with this checkout's revision and FAIL with a bad base or without git, node or bun. It writes none when python3 is missing. A plain `bootstrap` writes its doctor run's receipt. A refused `bootstrap`, `bootstrap --relock`, `bootstrap --remove` and `verify list` write none.
- The doctor on a copy of the pinned skills, before and after a planted change and a removed skill.
- `verify pstack-upstream` and `bootstrap --relock --checkout` against a synthetic upstream Git repository: no checkout and a missing one, mislabelled, unpinned and unlisted skills, a matching pin, a changed installed file, an ignored file in the working tree, a recorded version that differs, a pin the revision lacks, a stale pinned hash, a directory that is not a Git checkout, a skills dir without the checkout's skills, a later upstream HEAD, a replace ref, a recorded revision that is not a commit ID, a clone without the pinned revision, and a relock that removes a pin with and without `--allow-drop`.

- `docs/acceptance/CC-27/rerun.sh` itself, run in a copy of the checkout whose suite is a stub. It stops with exit 2 when it cannot write summary.tsv, revision.txt or identity-audit.txt, when summary.tsv becomes read-only or a transcript is blocked during the run, without a temporary directory, when it cannot add its throwaway worktree, which it then removes, and when it cannot redact an output. In one run that otherwise matches every step, it exits 1 and its audit names each of seven faults planted during the run: a deleted receipt and stdout artifact, a duplicated and a stray summary row, an emptied transcript, a receipt naming another head, and a stray receipt.

It exits nonzero if any case fails.
