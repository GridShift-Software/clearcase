# Agent tooling

Implementation and review agents run the project's planning checks and verification capabilities through `scripts/agent-tools/`. Every entry point works from a fresh non-interactive shell in any worktree and needs no GUI or shell profile. Every check writes a receipt; [Receipts](#receipts) lists exactly which commands do. CC-27 ([GRS-35](https://linear.app/vaper/issue/GRS-35/set-up-pstack-and-verification-skills-for-agent-cli-access)) owns this tooling. It implements no application behavior.

## Quick start

```sh
scripts/agent-tools/doctor                      # preflight with a receipt; nonzero on any missing dependency
scripts/agent-tools/check-plan                  # planning checker + pstack check-plan.mjs
scripts/agent-tools/check-plan --linear-relations PATH   # also compare a Linear readback
bash tests/agent-tools/run.sh                   # tooling self-tests
```

Run them from the worktree root, or by absolute path from anywhere. `receipt` is the exception: it runs its command in the current directory, which must lie in the checkout whose revision it records (see [Revision identity](#revision-identity)). The caller's shell does not matter; fish, zsh, bash and `env -i` all work because each entry point is an executable script.

## Sources and versions

| Component | Source | Version or revision | Access and license |
| --- | --- | --- | --- |
| pstack skill bundle: `poteto-mode` and 46 companion skills | [`backnotprop/pstack`](https://github.com/backnotprop/pstack), designated by the user on 2026-10-08. It is a harness-neutral mirror of [`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack). Installed in `~/.agents/skills/`; `~/.claude/skills/*` are symlinks into it. | 0.15.9, revision `124f622bcaeac490e7e9dac6af83f3ef9611d554` (2026-10-04), which mirrors `cursor/plugins@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a`. Pinned per skill by content hash in `scripts/agent-tools/skills.lock.json`. | MIT, Copyright (c) 2026 Lauren Tan. Public; no credentials. |
| `poteto-mode/scripts/check-plan.mjs` | Same bundle. | Pinned with `poteto-mode`. Dependency-free Node ESM. | Same. |
| Matt Pocock skills (`ask-matt`, `domain-modeling`, `codebase-design`) | `~/.agents/skills/`. The files name no upstream. | Pinned by content hash in the same lock. | Not recorded. |
| `scripts/planning/check.py`, `generate.py` | This repository. | Git revision. | Repository. |
| Bun, the app toolchain | The user's choice of 2026-10-08 (`AGENTS.md`, App toolchain). On `puk` it comes from the official installer at <https://bun.sh>, in `~/.bun/bin`, and `bun` and `bunx` are linked into `~/.local/bin`. Arch Linux packages it as `bun` in `extra`. | Stable 1.4.2, the minimum the doctor accepts; see [Bun](#bun). Upgrade with `bun upgrade --stable` (`pacman -Syu bun` for the package). The pin moves only with a reviewed commit. | MIT for Bun's own code; bundled components keep their licenses. Public; no credentials. |
| Runtimes | System packages. | bash >= 4.4, Python >= 3.10, Node.js >= 18, git, and Bun as above. Tested with bash 5.3, Python 3.14, Node 26.10, git 2.56 and Bun 1.4.2 on CachyOS. | Distribution packages. |

How the pstack pin was established:

- At the pinned revision, `.cursor-plugin/plugin.json` names `pstack` 0.15.9 by Lauren Tan under the MIT license, and `LICENSE` is the MIT license. `MIRROR.md` explains the mirror: branch `upstream` holds Cursor's files verbatim, and `main` is `upstream` plus the mirror's harness-neutral edits.
- The 47 skills present both in the revision's `skills/` and in `~/.agents/skills/` are byte-identical. The coordinator compared them with `diff -rq` on 2026-10-08 at 15:28 SAST, and the CC-27 round-2 worker reran the comparison from a fresh clone at 15:36 SAST.
- Three upstream skills at that revision are not installed and not pinned: `benchmark-checklist`, `correct` and `principle-explain-the-number`.
- `tdd` belongs to pstack, not to the Matt Pocock skills.
- `backnotprop/pstack` `main` had reached 0.15.15 (`3a604672c46c`) by 2026-10-08. The pin records the installed 0.15.9 snapshot.

The lock's `provenance.pstack` block records the same facts. Its reproduce command prints nothing when the install matches:

```sh
git clone https://github.com/backnotprop/pstack.git p && git -C p worktree add ../p124 124f622 && for d in p124/skills/*/; do n=$(basename $d); [ -e ~/.agents/skills/$n ] && diff -rq $d ~/.agents/skills/$n; done
```

`scripts/agent-tools/verify pstack-upstream --checkout DIR` makes the same comparison from the pinned revision's Git objects in any clone that contains it, so files in the clone's working tree do not count. Like the pin, and unlike the reproduce command, it skips `node_modules`, `__pycache__` and `.DS_Store`. It also checks the lock and writes a receipt. Install pstack only from this source; do not install a package merely because it is named pstack.

The leaf skills `to-spec`, `to-tickets` and `implement-spec` are absent. The doctor reports them as INFO, and nothing here installs or claims them.

pstack's `orch` and `watch-pr` scripts also run on bun, and this project does not use them. The doctor requires Bun for the app, not for them.

## Bootstrap, upgrade and removal

Prerequisites are bash, git, python3 and node on a standard PATH such as `/usr/local/bin:/usr/bin:/bin`, Bun at the app's minimum version on PATH or named by `CLEARCASE_BUN`, and the skill bundle in `~/.agents/skills`. The checkout needs `origin/dev` or `dev` for the default receipt base; otherwise pass `--base REF` (see [Revision identity](#revision-identity)). On a new Arch-family host:

```sh
sudo pacman -S --needed bash git python nodejs bun
rsync -a puk:.agents/skills/ ~/.agents/skills/   # or another host that holds the pinned bundle
scripts/agent-tools/bootstrap
```

On `puk`, `~/.local/bin/bun` lies outside that standard PATH, so a shell started with only `/usr/local/bin:/usr/bin:/bin` needs `CLEARCASE_BUN=~/.local/bin/bun`. `docs/acceptance/CC-27/rerun.sh` sets it that way.

`bootstrap` runs the doctor, then creates ignored local state only, `.local/agent-tools/skills` (a symlink to the resolved bundle) and `.local/agent-tools/bootstrap.json`. Rerunning it reports `unchanged`. If the link already points somewhere else it refuses with exit 1 instead of creating a second installation. It writes no global files and no tracked files. Bootstrap is optional; without it the tools find `~/.agents/skills` directly.

To use a bundle elsewhere, pass `--skills-dir DIR` to any command or set `CLEARCASE_SKILLS_DIR`. An explicit directory is used as given, with no fallback.

The doctor fails and names each pinned skill whose installed content differs from the pin, so a bundle change cannot pass unnoticed. To move pstack to a new upstream revision:

1. Clone the upstream at that revision: `git clone https://github.com/backnotprop/pstack.git .local/pstack-upstream && git -C .local/pstack-upstream checkout --detach REV`. `.local/` is ignored.
2. Install the revision's skills on the host one directory per skill, for example `rsync -a --delete .local/pstack-upstream/skills/NAME/ ~/.agents/skills/NAME/`. Never use `--delete` on `~/.agents/skills` itself, because it holds other skills. The tools never write there.
3. Compare the install with `diff -rq`, as in the reproduce command above. It must print nothing.
4. Run `scripts/agent-tools/bootstrap --relock --checkout .local/pstack-upstream`. It reads the skills at the checkout's HEAD from Git objects. It refuses a path without a Git HEAD that carries `.cursor-plugin/plugin.json`, a checkout none of whose skills is installed, and an install that differs from HEAD. It also refuses to remove a pstack pin that the checkout does not install unless you pass `--allow-drop`. Otherwise it pins every installed skill of the checkout as group `pstack` and rehashes the other pins. It prints the revision, the skills it added, moved to `pstack` or removed, the upstream skills that are not installed, and whether HEAD differs from `provenance.pstack.revision`.
5. Edit `provenance.pstack` in `skills.lock.json` (revision, its date and subject, version, license, `mirrorOf`, `notInstalled`, `checkedAt` and `checks`) and the table above. Provenance is never written automatically.
6. Run `scripts/agent-tools/verify pstack-upstream --checkout .local/pstack-upstream` and `scripts/agent-tools/doctor`. Both must pass. Commit the lock and this document through a reviewed pull request into `dev`.

For a skill with no recorded upstream, such as the Matt Pocock skills, review the installed change and run `bootstrap --relock` without `--checkout`. That rehashes the existing pins and changes no membership. A pin change is a reviewed repository change, never an automatic one.

To remove, run `scripts/agent-tools/bootstrap --remove`. It deletes only `.local/agent-tools/`. Receipts in `.local/agent-receipts/` and the global skills stay.

### Bun

Every app ticket from GRS-10 (CC-02) on builds and runs with Bun, so the doctor fails unless `bun --version` prints a version at least the app's minimum. Which minimum applies:

- While the repository has no `package.json`, the minimum is `MIN_BUN`, 1.4.2, in `scripts/agent-tools/agent_tools.py`.
- Once GRS-10 adds `package.json`, the minimum is its `packageManager` field, `bun@MAJOR.MINOR.PATCH` with an optional `+hash` suffix, and `MIN_BUN` no longer applies. A `package.json` that cannot be read, is not JSON, or pins no `bun@` version fails the doctor. The doctor's receipt then also fingerprints `package.json`.

The doctor uses `CLEARCASE_BUN` when it is set, otherwise the `bun` on PATH. It fails, with a fix, when no bun is found, when the version is older than the minimum, and when `bun --version` does not print exactly one version. That means it fails when `--version` exits nonzero, writes anything to stderr, even with exit 0, or prints on stdout anything other than one line holding a version such as `1.4.2`. White space around that line is ignored; a second line is not. Versions compare as numbers, and a prerelease such as `1.4.2-canary.1` counts as older than `1.4.2`. The row names the bun it checked and where the minimum came from, and the receipt lists that bun's path and its whole stdout as the version.

To move the pin, run `bun upgrade --stable` (`pacman -Syu bun` for the distribution package) and record the `bun --version` it installs. Then change `MIN_BUN`, or `packageManager` once it exists, in a reviewed commit into `dev`. The tools never upgrade Bun or change the pin themselves.

## Entry points

| Command | Runs | Exit codes |
| --- | --- | --- |
| `scripts/agent-tools/doctor` | OS and bash, Python, git and repository, the revision receipts record (head, base and merge base), Node, Bun at the app's minimum version, planning scripts, skill bundle discovery, required skill files, the content pin, writable receipt directory. Reports the pinned pstack source, optional tools (gh, tmux) and the deferred app/browser dependencies. Writes one receipt with the report. | 0 all required checks pass, 1 a check failed, 2 unsupported OS, old bash or no python3 (no receipt, because Python never starts) |
| `scripts/agent-tools/check-plan [--linear-relations PATH] [--require-linear-relations] [--plan PATH]` | `plan-graph` and `plan-format`, plus `linear-relations` when a readback is given (or `CLEARCASE_LINEAR_READBACK` is set). One receipt per step. | 0 every step passed, otherwise the first failing step's code. A required comparison without a readback exits 3. |
| `scripts/agent-tools/verify list` | Lists capabilities and whether each is available or deferred. Writes no receipt. | 0 |
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
| `app` | none yet | deferred. The app, build and browser commands and a project `verify-<app>` skill from pstack `create-verification-skill` arrive with GRS-12 (CC-03). GRS-10 (CC-02) owns the Bun/TypeScript/Vitest bootstrap. Always SKIPPED, exit 3. |

pstack's `create-verification-skill` and `maintain-verification-skill` need a runnable app to drive, so neither can run before GRS-12. The doctor checks that both skill files are present.

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
- The doctor's DEFERRED app/browser line is not a pass and not a failure. It becomes a required check when GRS-12 lands its commands.

## Receipts

`doctor`, `check-plan` (one receipt per step), `verify CAPABILITY` and `receipt` each write a receipt, and so does the doctor run inside a plain `bootstrap`. `verify list`, `bootstrap --relock`, `bootstrap --remove` and a `bootstrap` that refuses a conflicting link write none; wrap them in `scripts/agent-tools/receipt` when you need a record, as `docs/acceptance/CC-27/rerun.sh` does for `bootstrap`. An entry point that exits 2 before Python starts (unsupported OS, bash older than 4.4, no python3) writes no receipt, and neither does one that cannot create or write its receipt directory (see [Evidence failures](#evidence-failures)).

Each receipt is a directory `<receipts>/<UTC timestamp>-<name>/` with `receipt.json`, `stdout.txt` and `stderr.txt`. The receipt directory is `--receipts DIR`, else `CLEARCASE_RECEIPTS_DIR`, else `.local/agent-receipts/` in the checkout (ignored by Git). Workers point it at `.orchestration/reports/<planning-key>/` in the `dev` clone for machine-local evidence. Committed receipts go under `docs/acceptance/<planning-key>/` and must not contain case material.

`receipt.json` (schema `clearcase-agent-receipt/1`) records:

- `name`, `result` (PASS, FAIL or SKIPPED), `exitCode`, and `reason`: why it is not PASS when the receipt can say. That is a skip, evidence that could not be collected, or the doctor's FAIL rows. It is null for PASS and for a command's own failure.
- `command`, the exact argv, and `cwd`.
- `tools`, git first and then the command's own tools, each with path and the first line of its `--version` output. For bun it is all of its stdout, which the doctor requires to be one version line (see [Bun](#bun)).
- `inputs`, for example the checker scripts, the plan, the readback, or the lock and any `package.json` the doctor checks. Each row has the `path`, the `sha256` of its bytes, and the `size`, `mtimeNs`, `device` and `inode` of the file they were read from, all read before the command runs. After the command exits, every input is read again, and a difference is never PASS (see [Evidence failures](#evidence-failures)).
- `revision`, resolved before the command runs and again after it exits: `root`, `branch`, `head`, `baseRef` (as requested, or the default that resolved), `base`, `mergeBase`, `dirty`, and `diffSha256` when dirty. The receipt records the first resolution. Every key is present. `head`, `base` and `mergeBase` are null only in SKIPPED or FAIL receipts, and so are `dirty` and `diffSha256` when Git could not report the working tree. `diffSha256` is null when the checkout is clean, and `branch` is `HEAD` when it is detached.
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
| The output cannot be captured whole, for example a full disk. Or, after the command exits, a capture file's descriptor has no link left, its path is gone or names another file, or its size differs from the bytes written to it. | The command's exit code and FAIL if it failed. If it exited 0: SKIPPED, exit 3. The reason says `output not captured whole: ...`, for example `stdout.txt: removed during the run`, and gives the command's exit code. |
| After the command exits, an input is gone or cannot be read whole, or its sha256, size, modification time, device or inode differs from the identity recorded before the run | The command's exit code and FAIL if it failed. If it exited 0: SKIPPED, exit 3. The reason says `input changed during the run: ...` and names each field that differs, for example `inode 1302892 -> 1302893`. |
| After the command exits, the revision cannot be resolved, or its head, base, merge base, `dirty` or `diffSha256` differs from the one recorded, for example after an edit to a tracked file or a commit | As for inputs. The reason says `the revision cannot be read after the run: ...` or `the checkout changed during the run: ...` with the fields that differ. |
| The receipt cannot be written after the command ran | No receipt. The command's exit code if it failed, otherwise exit 3, with a message on stderr. |

The doctor reports the same failures for its own evidence as FAIL rows, `git`, `python3`, `node`, `bun`, `revision`, `skill-pin` or `receipt-input`, and exits 1. Its receipt's reason lists every FAIL row. It reads its inputs, the lock and any `package.json`, again after its checks, and a difference is a FAIL `receipt-input` row. It runs no command, so it resolves the revision once. It also fails when it is not launched through `scripts/agent-tools/doctor`, because the bash that runs the entry points is then unknown, and when a planning script, the lock or a pinned skill's file or directory cannot be read, or a pinned skill holds something that is not a file, directory or symlink. If it cannot write its receipt, it exits 1 with `doctor: FAIL. Receipt not written`.

No Git query has a time limit; a Git command that hangs blocks the entry point, which then writes no PASS receipt.

## What receipts prove

A receipt is evidence for an honest rerun, not a signature. It says which command ran at which revision, with which tools and inputs, on which host, and what the command printed and returned. Reviewers rerun the checks at the exact revision instead of trusting a receipt alone. This is the threat model the receipts are designed against.

**In scope: a receipt never says PASS.** Each of these gives SKIPPED or FAIL, or a FAIL row for the doctor and a nonzero exit for `rerun.sh`, with a reason that names what failed. [Revision identity](#revision-identity) and [Evidence failures](#evidence-failures) give every case.

- Missing or misbehaving tools: git, python3, node, bun or a `--tool` that is absent, or whose version probe fails, prints nothing, cannot start or hangs, and a bun that prints anything other than one version line or writes to stderr.
- Misconfiguration: no base, or an unresolvable or empty one; a `--root` that is not a checkout's top; Git configuration that could hide a change, such as external diff drivers, textconv filters, `status.showUntrackedFiles` and assume-unchanged or skip-worktree marks; an inherited `GIT_DIR`; a `package.json` that pins no Bun.
- I/O and permission failures: files, directories or Git objects that cannot be read, a receipt directory that cannot be created or written, output that cannot be captured whole, and in `rerun.sh` any transcript, summary, audit or other output it cannot write.
- Unreadable, special or changing inputs: an input that is not a regular file, changes while it is read, or is gone, replaced or changed by the time the command exits, detected as described below.
- Git state that cannot be read: a Git query that fails or warns, before or after the command, for example over a corrupt index or a missing object.
- Concurrent edits by ordinary tooling: an editor, formatter or build that rewrites an input, edits a tracked file or commits while a check runs.
- Lost or truncated artifacts: a capture file that is removed, moved or replaced or does not hold the bytes written to it, and in `rerun.sh` a receipt, transcript or summary row that is missing, empty, duplicated or names another head.

**Detected where cheap, not prevented.** A party with write access to the checkout, the inputs or the receipt directory can deliberately race the wrapper, replacing an input or unlinking a capture while a check runs. The mitigation is to look twice. Each input's sha256, size, modification time, device and inode are recorded before the command runs and read again after it exits. The revision is resolved again after the run. Before PASS, each capture descriptor must still have a link and the size written, and its path must name the same file. `rerun.sh` ends with an audit of every inventoried step's summary row, transcript and receipts and of each receipt's files. Any difference is never PASS. Two risks remain. A change that is undone between the two looks goes unseen, for example an input swapped and swapped back while the checker reads it. So does tampering with the receipt directory after a receipt or the audit is written.

**Out of scope.** A malicious local user, a compromised Git, Python, Node, Bun or OS binary, and kernel-level tampering. The tools trust the binaries they run, and what Git reports when it exits 0 without warnings. Receipts are evidence for honest reruns, not signatures; reviewers rerun at the exact revision.

## Tests

`bash tests/agent-tools/run.sh` needs bash, coreutils, git, python3 and node, Bun at the minimum (on PATH or in `CLEARCASE_BUN`) for the cases where the doctor and bootstrap pass in this environment, and a checkout with `origin/dev` or `dev`, because its receipts in this checkout use the default base. It must run as a user without root privileges, because root reads files whose permissions deny reading and several cases depend on that. It covers:

- The assertions themselves. `receipt_is`, `receipt_revision` and `receipt_check` fail, showing Python's error, on a receipt that is not JSON or lacks its fields. `lacks` and `lacks_in_receipt` fail when there is nothing to read.
- The synthetic plans `tests/agent-tools/fixtures/plans/{valid,invalid}.md` through pstack `check-plan.mjs`.
- Graph fixtures `tests/agent-tools/fixtures/graph/*.json`. Each one edits a disposable Git checkout of the committed plan (cycle, unmapped issue, scope overlap, stale generated files, Linear readback drift) and carries its expected exit code and diagnostics.
- Deferred and skipped checks, the receipt writer's output and exit-code preservation, the doctor with no node and with no python3, and bootstrap idempotency, conflict refusal and removal in a fresh Git checkout.
- Revision identity. Receipts record `head`, `baseRef`, `base` and `mergeBase` equal to `git rev-parse` and `git merge-base`, in this checkout and in a synthetic repository whose `dev` moved on after the fork. These cases are SKIPPED, exit 3, and the command does not run: no git (`verify`, `check-plan` and `receipt`), an unresolvable or empty `--base` or `CLEARCASE_BASE_REF`, no default base, an unrelated base, a `--root` below a checkout's top, a checkout without a commit, a copy of the tools outside any checkout, and a `receipt` run outside its checkout or in a nested repository. An inherited `GIT_DIR`, `CLEARCASE_GIT` and odd untracked files (non-ASCII and newline names, broken and directory symlinks) do not change or break the recorded revision. Every PASS receipt in the suite must list git and name all three commits.
- Evidence failures, in a disposable copy of the checkout whose Git data the cases damage and restore. A corrupt index makes `verify`, `doctor`, `receipt` and `check-plan` each refuse PASS, naming the failed `git status` and Git's message, while the intact index records the untracked file as dirty with a fingerprint. These are SKIPPED, or FAIL for the doctor: a missing HEAD tree, HEAD commit or changed file's object, an unreadable tracked or untracked file, an untracked directory Git cannot open (Git exits 0 and warns), a changed file marked assume-unchanged or skip-worktree, an `origin/dev` naming a deleted commit, and a test `git` on PATH that fails `status`, `diff`, `ls-files`, `rev-parse --abbrev-ref`, `rev-parse HEAD^{commit}` or `--version`, or prints a false commit ID. So are an untracked file that disappears between listing and reading, git, node and python3 version probes that fail, a `--tool` that prints no version or cannot start, an unreadable `--input` or plan, an input that changes while it is read (`/proc/self/status`), a command without execute permission, an unwritable receipt directory, one that becomes unwritable during the run, and output that cannot be captured under `ulimit -f`. During the run, these are never PASS either: a test node that renames a valid plan over the invalid one before checking it, as the review's atomic replacement did; an input changed in place (the failing command keeps FAIL and its exit code), replaced by a copy of its bytes, or removed; a tracked file edited, a commit made or the index broken by the command; and a `stdout.txt` capture removed, moved, replaced or appended to by another descriptor. The doctor fails when an input changes during its run. An external diff driver, a textconv filter that prints nothing, a change inside an untracked nested repository and `status.showUntrackedFiles=no` do not hide a change from the fingerprint, and a nested repository with a file name that is not UTF-8 is fingerprinted. A console on `/dev/full` neither stalls the command nor truncates the capture. The doctor fails when it is not launched through its wrapper, and on an unreadable planning script, lock or skill directory, and on a FIFO in a skill. `pstack-upstream` keeps Git's error about a missing revision and fails on an unreadable object or installed file. A relock refuses an unreadable installed file and leaves the lock unchanged.
- The doctor's Bun row through its entry point. It fails with no bun on PATH, a fake bun 1.3.9 on PATH, a prerelease of the minimum, output that is not a version or holds other text, a version followed by a second line, output on stderr, and a failing `--version`. It passes with 1.4.2, with 1.4.2 between blank lines and spaces, and with 1.10.0, so versions compare as numbers. `CLEARCASE_BUN` finds a bun outside PATH, wins over the one on PATH and fails when it names no executable. In the disposable copy, a `package.json` whose `packageManager` raises or replaces the minimum decides the result, and one that names another package manager, has no `packageManager`, is not JSON or cannot be read fails. Where a test checks it, the Bun row is the only FAIL row. The receipt lists the bun checked and fingerprints `package.json`.
- Receipts per command. The doctor writes PASS with this checkout's revision and FAIL with a bad base or without git, node or bun. It writes none when python3 is missing. A plain `bootstrap` writes its doctor run's receipt. A refused `bootstrap`, `bootstrap --relock`, `bootstrap --remove` and `verify list` write none.
- The doctor on a copy of the pinned skills, before and after a planted change and a removed skill.
- `verify pstack-upstream` and `bootstrap --relock --checkout` against a synthetic upstream Git repository: no checkout and a missing one, mislabelled, unpinned and unlisted skills, a matching pin, a changed installed file, an ignored file in the working tree, a recorded version that differs, a pin the revision lacks, a stale pinned hash, a directory that is not a Git checkout, a skills dir without the checkout's skills, a later upstream HEAD, a replace ref, a recorded revision that is not a commit ID, a clone without the pinned revision, and a relock that removes a pin with and without `--allow-drop`.

- `docs/acceptance/CC-27/rerun.sh` itself, run in a copy of the checkout whose suite is a stub. It stops with exit 2 when it cannot write summary.tsv, revision.txt or identity-audit.txt, when summary.tsv becomes read-only or a transcript is blocked during the run, without a temporary directory, when it cannot add its throwaway worktree, which it then removes, and when it cannot redact an output. In one run that otherwise matches every step, it exits 1 and its audit names each of seven faults planted during the run: a deleted receipt and stdout artifact, a duplicated and a stray summary row, an emptied transcript, a receipt naming another head, and a stray receipt.

It exits nonzero if any case fails.
