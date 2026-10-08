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
| pstack skill bundle (`poteto-mode` and companions) | `~/.agents/skills/`, copied from `archlinux` by rsync. `~/.claude/skills/*` are symlinks into it. | Unknown upstream version. Pinned by per-skill content hash in `scripts/agent-tools/skills.lock.json`. | Not recorded in the files. No LICENSE or README ships with the bundle. HOLD, see below. |
| `poteto-mode/scripts/check-plan.mjs` | Same bundle. | Pinned with `poteto-mode`. Dependency-free Node ESM. | Same. |
| Matt Pocock skills (`ask-matt`, `domain-modeling`, `codebase-design`, `tdd`) | `~/.agents/skills/`. | Pinned by content hash in the same lock. | Not recorded. |
| `scripts/planning/check.py`, `generate.py` | This repository. | Git revision. | Repository. |
| Runtimes | System packages. | bash >= 4.4, Python >= 3.10, Node.js >= 18, git. Tested with bash 5.3, Python 3.14, Node 26.10, git 2.56 on CachyOS. | Distribution packages. |

What the bundle files establish about pstack:

- Playbooks cite paths as `pstack/skills/<skill>/...`, so the upstream is a repository with a `pstack/skills/` tree. Its URL is not in the files.
- `poteto-mode/scripts/package.json` names the package `@cursor-skill/poteto-mode-tools`, private, with no version field.
- `poteto-mode/SKILL.md` says pstack was written for Cursor and maps Claude Code, Codex, Pi and OpenCode onto it.
- `~/.agents/.skill-lock.json`, the skills CLI lock, tracks only `find-skills` and `dogfood`, not pstack.

The upstream repository, release and license therefore remain open. The content pin makes drift detectable but is not an upstream version. Do not install a package merely because it is named pstack.

The leaf skills `to-spec`, `to-tickets` and `implement-spec` are absent. The doctor reports them as INFO, and nothing here installs or claims them.

pstack's `orch` and `watch-pr` scripts need bun and are not used by this project. bun is optional, absent on `puk` and present on `archlinux`; no ClearCase tool needs it.

## Bootstrap, upgrade and removal

Prerequisites are bash, git, python3 and node on a standard PATH such as `/usr/local/bin:/usr/bin:/bin`, plus the skill bundle in `~/.agents/skills`. On a new Arch-family host:

```sh
sudo pacman -S --needed bash git python nodejs
rsync -a archlinux:.agents/skills/ ~/.agents/skills/   # or the host that holds the pinned bundle
scripts/agent-tools/bootstrap
```

`bootstrap` runs the doctor, then creates ignored local state only, `.local/agent-tools/skills` (a symlink to the resolved bundle) and `.local/agent-tools/bootstrap.json`. Rerunning it reports `unchanged`. If the link already points somewhere else it refuses with exit 1 instead of creating a second installation. It writes no global files and no tracked files. Bootstrap is optional; without it the tools find `~/.agents/skills` directly.

To use a bundle elsewhere, pass `--skills-dir DIR` to any command or set `CLEARCASE_SKILLS_DIR`. An explicit directory is used as given, with no fallback.

To upgrade, update the bundle on the host, then run `scripts/agent-tools/doctor`. It fails and names each skill whose content differs from the pin. Review the change, run `scripts/agent-tools/bootstrap --relock`, and commit the updated `skills.lock.json` through a PR. A pin change is a reviewed repository change, never an automatic one.

To remove, run `scripts/agent-tools/bootstrap --remove`. It deletes only `.local/agent-tools/`. Receipts in `.local/agent-receipts/` and the global skills stay.

## Entry points

| Command | Runs | Exit codes |
| --- | --- | --- |
| `scripts/agent-tools/doctor` | OS and bash, Python, git and repository, Node, planning scripts, skill bundle discovery, required skill files, the content pin, writable receipt directory. Reports optional tools (bun, gh, tmux) and the deferred app/browser dependencies. | 0 all required checks pass, 1 a check failed, 2 unsupported OS, old bash or no python3 |
| `scripts/agent-tools/check-plan [--linear-relations PATH] [--require-linear-relations] [--plan PATH]` | `plan-graph` and `plan-format`, plus `linear-relations` when a readback is given (or `CLEARCASE_LINEAR_READBACK` is set). One receipt per step. | 0 every step passed, otherwise the first failing step's code. A required comparison without a readback exits 3. |
| `scripts/agent-tools/verify list` | Lists capabilities and whether each is available or deferred. | 0 |
| `scripts/agent-tools/verify CAPABILITY [--readback PATH] [--plan PATH]` | One capability with a receipt. | The wrapped command's own exit code, or 3 when skipped |
| `scripts/agent-tools/receipt --name NAME [--tool T]... [--input FILE]... -- CMD ARGS...` | Any command with a receipt. A missing `--tool`, `--input` or command is SKIPPED and is not run. | The command's own exit code, or 3 when skipped |
| `scripts/agent-tools/bootstrap [--relock \| --remove]` | See above. | 0 or 1 |
| `python3 scripts/planning/generate.py --compare-linear EXPORT` | Diffs generated briefs against the descriptions in a full Linear export. | 0 all match, 1 drift |

All commands accept `--skills-dir`, `--receipts`, `--base REF` and `--root DIR`. `--root` checks a different planning tree; the tests use it for fixtures.

Capabilities and the commands they wrap, unchanged:

| Capability | Command | State |
| --- | --- | --- |
| `plan-graph` | `python3 scripts/planning/check.py --require-linear-ids` | available |
| `linear-relations` | `python3 scripts/planning/check.py --require-linear-ids --linear-relations READBACK` | available. A readback is a file the coordinator exports from Linear; this command never fetches live data. |
| `plan-format` | `node ~/.agents/skills/poteto-mode/scripts/check-plan.mjs docs/delivery-plan.md` | available |
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

It exits nonzero if any case fails.
