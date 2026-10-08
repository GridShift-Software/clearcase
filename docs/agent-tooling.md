# Agent tooling

Implementation and review agents run the project's planning checks and verification capabilities through `scripts/agent-tools/`. Every entry point works from a fresh non-interactive shell in any worktree, needs no GUI or shell profile, and writes a receipt. CC-27 ([GRS-35](https://linear.app/vaper/issue/GRS-35/set-up-pstack-and-verification-skills-for-agent-cli-access)) owns this tooling. It implements no application behavior.

## Quick start

```sh
scripts/agent-tools/doctor                      # preflight; nonzero on any missing dependency
scripts/agent-tools/check-plan                  # planning checker + pstack check-plan.mjs
scripts/agent-tools/check-plan --linear-relations PATH   # also compare a Linear readback
bash tests/agent-tools/run.sh                   # tooling self-tests
```

Run them from the worktree root, or by absolute path from anywhere. The caller's shell does not matter; fish, zsh, bash and `env -i` all work because each entry point is an executable script.

## Sources and versions

| Component | Source | Version or revision | Access and license |
| --- | --- | --- | --- |
| pstack skill bundle: `poteto-mode` and 46 companion skills | [`backnotprop/pstack`](https://github.com/backnotprop/pstack), designated by the user on 2026-10-08. It is a harness-neutral mirror of [`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack). Installed in `~/.agents/skills/`; `~/.claude/skills/*` are symlinks into it. | 0.15.9, revision `124f622bcaeac490e7e9dac6af83f3ef9611d554` (2026-10-04), which mirrors `cursor/plugins@e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a`. Pinned per skill by content hash in `scripts/agent-tools/skills.lock.json`. | MIT, Copyright (c) 2026 Lauren Tan. Public; no credentials. |
| `poteto-mode/scripts/check-plan.mjs` | Same bundle. | Pinned with `poteto-mode`. Dependency-free Node ESM. | Same. |
| Matt Pocock skills (`ask-matt`, `domain-modeling`, `codebase-design`) | `~/.agents/skills/`. The files name no upstream. | Pinned by content hash in the same lock. | Not recorded. |
| `scripts/planning/check.py`, `generate.py` | This repository. | Git revision. | Repository. |
| Runtimes | System packages. | bash >= 4.4, Python >= 3.10, Node.js >= 18, git. Tested with bash 5.3, Python 3.14, Node 26.10, git 2.56 on CachyOS. | Distribution packages. |

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

`scripts/agent-tools/verify pstack-upstream --checkout DIR` makes the same comparison against a checkout of the pinned revision, checks the lock as well, and writes a receipt. Install pstack only from this source; do not install a package merely because it is named pstack.

The leaf skills `to-spec`, `to-tickets` and `implement-spec` are absent. The doctor reports them as INFO, and nothing here installs or claims them.

pstack's `orch` and `watch-pr` scripts need bun and are not used by this project. bun is optional, absent on `puk` and present on `archlinux`; no ClearCase tool needs it.

## Bootstrap, upgrade and removal

Prerequisites are bash, git, python3 and node on a standard PATH such as `/usr/local/bin:/usr/bin:/bin`, plus the skill bundle in `~/.agents/skills`. On a new Arch-family host:

```sh
sudo pacman -S --needed bash git python nodejs
rsync -a puk:.agents/skills/ ~/.agents/skills/   # or another host that holds the pinned bundle
scripts/agent-tools/bootstrap
```

`bootstrap` runs the doctor, then creates ignored local state only, `.local/agent-tools/skills` (a symlink to the resolved bundle) and `.local/agent-tools/bootstrap.json`. Rerunning it reports `unchanged`. If the link already points somewhere else it refuses with exit 1 instead of creating a second installation. It writes no global files and no tracked files. Bootstrap is optional; without it the tools find `~/.agents/skills` directly.

To use a bundle elsewhere, pass `--skills-dir DIR` to any command or set `CLEARCASE_SKILLS_DIR`. An explicit directory is used as given, with no fallback.

The doctor fails and names each pinned skill whose installed content differs from the pin, so a bundle change cannot pass unnoticed. To move pstack to a new upstream revision:

1. Clone the upstream at that revision: `git clone https://github.com/backnotprop/pstack.git .local/pstack-upstream && git -C .local/pstack-upstream checkout --detach REV`. `.local/` is ignored.
2. Install the revision's skills on the host one directory per skill, for example `rsync -a --delete .local/pstack-upstream/skills/NAME/ ~/.agents/skills/NAME/`. Never use `--delete` on `~/.agents/skills` itself, because it holds other skills. The tools never write there.
3. Compare the install with `diff -rq`, as in the reproduce command above. It must print nothing.
4. Run `scripts/agent-tools/bootstrap --relock --checkout .local/pstack-upstream`. It refuses if an installed upstream skill differs from the checkout. Otherwise it pins every installed skill of the checkout as group `pstack`, rehashes the other pins, and prints the revision and the upstream skills that are not installed.
5. Edit `provenance.pstack` in `skills.lock.json` (revision, its date and subject, version, license, `mirrorOf`, `notInstalled`, `checkedAt` and `checks`) and the table above. Provenance is never written automatically.
6. Run `scripts/agent-tools/verify pstack-upstream --checkout .local/pstack-upstream` and `scripts/agent-tools/doctor`. Both must pass. Commit the lock and this document through a reviewed pull request into `dev`.

For a skill with no recorded upstream, such as the Matt Pocock skills, review the installed change and run `bootstrap --relock` without `--checkout`. That rehashes the existing pins and changes no membership. A pin change is a reviewed repository change, never an automatic one.

To remove, run `scripts/agent-tools/bootstrap --remove`. It deletes only `.local/agent-tools/`. Receipts in `.local/agent-receipts/` and the global skills stay.

## Entry points

| Command | Runs | Exit codes |
| --- | --- | --- |
| `scripts/agent-tools/doctor` | OS and bash, Python, git and repository, Node, planning scripts, skill bundle discovery, required skill files, the content pin, writable receipt directory. Reports the pinned pstack source, optional tools (bun, gh, tmux) and the deferred app/browser dependencies. | 0 all required checks pass, 1 a check failed, 2 unsupported OS, old bash or no python3 |
| `scripts/agent-tools/check-plan [--linear-relations PATH] [--require-linear-relations] [--plan PATH]` | `plan-graph` and `plan-format`, plus `linear-relations` when a readback is given (or `CLEARCASE_LINEAR_READBACK` is set). One receipt per step. | 0 every step passed, otherwise the first failing step's code. A required comparison without a readback exits 3. |
| `scripts/agent-tools/verify list` | Lists capabilities and whether each is available or deferred. | 0 |
| `scripts/agent-tools/verify CAPABILITY [--readback PATH] [--plan PATH] [--checkout DIR]` | One capability with a receipt. | The wrapped command's own exit code, or 3 when skipped |
| `scripts/agent-tools/receipt --name NAME [--tool T]... [--input FILE]... -- CMD ARGS...` | Any command with a receipt. A missing `--tool`, `--input` or command is SKIPPED and is not run. | The command's own exit code, or 3 when skipped |
| `scripts/agent-tools/bootstrap [--relock [--checkout DIR] \| --remove]` | See above. | 0 or 1 |
| `python3 scripts/planning/generate.py --compare-linear EXPORT` | Diffs generated briefs against the descriptions in a full Linear export. | 0 all match, 1 drift |

All commands accept `--skills-dir`, `--receipts`, `--base REF` and `--root DIR`. `--root` checks a different planning tree; the tests use it for fixtures.

Capabilities and the commands they wrap, unchanged:

| Capability | Command | State |
| --- | --- | --- |
| `plan-graph` | `python3 scripts/planning/check.py --require-linear-ids` | available |
| `linear-relations` | `python3 scripts/planning/check.py --require-linear-ids --linear-relations READBACK` | available. A readback is a file the coordinator exports from Linear; this command never fetches live data. |
| `plan-format` | `node ~/.agents/skills/poteto-mode/scripts/check-plan.mjs docs/delivery-plan.md` | available |
| `pstack-upstream` | `python3 scripts/agent-tools/agent_tools.py compare-upstream --checkout DIR` | available with `--checkout DIR`, a clean checkout of the pinned revision. It checks the checkout's revision and its `plugin.json` version and license against `provenance.pstack`. It requires every installed skill of the checkout to be pinned as `pstack` and no other skill to be. `notInstalled` must list exactly the upstream skills that are not installed. Each pinned skill must match the checkout byte for byte and match its pinned hash. SKIPPED, exit 3, without `--checkout` or when the checkout has no `.cursor-plugin/plugin.json`. |
| `app` | none yet | deferred. The app, build and browser commands and a project `verify-<app>` skill from pstack `create-verification-skill` arrive with GRS-12 (CC-03). GRS-10 (CC-02) owns the npm/TypeScript/Vitest bootstrap. Always SKIPPED, exit 3. |

pstack's `create-verification-skill` and `maintain-verification-skill` need a runnable app to drive, so neither can run before GRS-12. The doctor checks that both skill files are present.

## Supported environments

| OS | Shell running the tools | Status |
| --- | --- | --- |
| CachyOS (`puk`) | `/bin/bash` 5.x; any caller shell, including fish and `env -i` | Supported and tested |
| Arch Linux (`archlinux`) | `/bin/bash` 5.x; any caller shell | Supported, same packages. bun present but unused. |
| Other Linux with `/bin/bash` >= 4.4 | any caller shell | Expected to work; run the doctor |
| macOS, BSD, Windows without WSL | n/a | Unsupported. The tools exit 2 with an "unsupported OS" message. |

The entry points use `#!/bin/bash` rather than `#!/usr/bin/env bash`. With an empty or wrong PATH, `env` cannot find bash and prints only a bare "No such file or directory". `/bin/bash` still starts, so the tools can print an actionable message, for example `FAIL python3 not found (PATH=/nonexistent)` with the fix. `CLEARCASE_PYTHON` and `CLEARCASE_NODE` override interpreter discovery.

## Failure behavior

- Wrapped commands keep their stdout, stderr and exit code. Output streams live and is also saved to the receipt.
- A missing tool, input or command produces result SKIPPED and exit 3. The command does not run. SKIPPED never counts as PASS.
- `check-plan` runs every step, even after a failure, so one run shows all diagnostics. Its summary line names each step's result and anything not run.
- Without `--linear-relations`, `check-plan` says `NOT RUN: linear-relations`. Local ID checks do not prove agreement with the live Linear graph. Use `--require-linear-relations` where the comparison is mandatory.
- The doctor's DEFERRED app/browser line is not a pass and not a failure. It becomes a required check when GRS-12 lands its commands.

## Receipts

Each run writes `<receipts>/<UTC timestamp>-<name>/` with `receipt.json`, `stdout.txt` and `stderr.txt`. The receipt directory is `--receipts DIR`, else `CLEARCASE_RECEIPTS_DIR`, else `.local/agent-receipts/` in the checkout (ignored by Git). Workers point it at `.orchestration/reports/<planning-key>/` in the `dev` clone for machine-local evidence. Committed receipts go under `docs/acceptance/<planning-key>/` and must not contain case material.

`receipt.json` (schema `clearcase-agent-receipt/1`) records:

- `name`, `result` (PASS, FAIL or SKIPPED), `exitCode` and `reason` for a skip.
- `command`, the exact argv, and `cwd`.
- `tools`, each with path and `--version` output, and `inputs`, each with path and sha256 (for example the checker scripts, the plan and the readback).
- `revision`, with branch, `head`, `baseRef`, `base`, `mergeBase`, `dirty` and `diffSha256` (tracked diff plus untracked files) when dirty.
- `environment`, with OS, kernel, machine, host, bash, caller shell, Python and PATH.
- `startedAt`, `finishedAt` and `durationSeconds`.
- `artifacts`, the paths of the receipt, stdout and stderr.

Paths under `$HOME` are written as `~` so receipts carry no machine-specific home directory.

## Tests

`bash tests/agent-tools/run.sh` needs bash, coreutils, git, python3 and node. It covers:

- The synthetic plans `tests/agent-tools/fixtures/plans/{valid,invalid}.md` through pstack `check-plan.mjs`.
- Graph fixtures `tests/agent-tools/fixtures/graph/*.json`. Each one edits a disposable copy of the committed plan (cycle, unmapped issue, scope overlap, stale generated files, Linear readback drift) and carries its expected exit code and diagnostics.
- Deferred and skipped checks, the receipt writer's output and exit-code preservation, the doctor with no node and with no python3, and bootstrap idempotency, conflict refusal and removal in a fresh Git checkout.
- The doctor on a copy of the pinned skills, before and after a planted change and a removed skill.
- `verify pstack-upstream` and `bootstrap --relock --checkout` against a synthetic upstream Git repository: no checkout, mislabelled, unpinned and unlisted skills, a matching pin, a changed installed file, a checkout with local changes and a checkout at another revision.

It exits nonzero if any case fails.
