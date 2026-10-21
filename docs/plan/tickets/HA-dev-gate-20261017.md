# Dev gate FAIL at c89d405: overview and documents subtitles differ from v5 since the demo merges

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-141/dev-gate-fail-at-c89d405-overview-and-documents-subtitles-differ-from) is the execution authority.

Found by `orch-bin/dev-gate c89d405` on 17 October 2026 (verdict file under `.orchestration/dev-gate/`). Build, check, test and the e2e suite PASS; strict parity FAILS with exactly two unregistered differences and `verify:pilot:v5` was skipped behind it.

## What is wrong

| View | Path | Kind | What parity saw |
| -- | -- | -- | -- |
| overview | `text.subtitle.2` | app-only | The app renders a second subtitle line that v5 does not have. |
| documents | `text.subtitle` | value | The subtitle text differs from v5's. The current source builds it as `<count> documents · filter by bundle, sorted by type then date`. |

Values are not quoted here because the parity run used the real v5 sample; see `.local/parity-out/dev-c89d405/views/{overview,documents}.json` on the workstation.

## Where it came from

The planning branch merged today (PR #45) changed nothing under `src/`, the parity adapters or the register. The demo merges PR #42 to #44 on 15 October did change both pages (`124b462` "Apply the design system to every page", `07c6351` "docs(ui): correct document ordering and v5 backup help", `5624bb1` comment removal), and no dev gate ran on `f89c56c`. The last PASS on record is `79b0bb2`. So `dev` has failed strict parity since 15 October.

## What to do

For each difference decide, with the user, between:

1. A register entry under the view owner's fragment (`docs/reference/parity/register/CC-04.json` for documents, the overview owner's for overview) with `approvedBy: null`, which the user approves in the PR. Use this when the demo wording is wanted (an improvement or a defect fix the audit dispositions support).
2. Restoring the v5 wording. Use this when the change was incidental to the restyle.

Then run `bun run --bun gate` to green at the head, including `verify:pilot:v5`, and the coordinator reruns `orch-bin/dev-gate` after merge.

## Acceptance criteria

- [ ] `bun run --bun parity -- --all --strict-register` reports 0 unregistered differences at the fix head, and `orch-bin/dev-gate` on the merged `dev` head records PASS.
- [ ] Any new register entry names the audit disposition or ADR that justifies it and keeps `approvedBy: null` until the user approves it in the PR.
- [ ] No other view's counts change.

## Scope and boundaries

Smallest change (`ponytail`). Sonnet-sized: one or two text lines plus register fragments. Reserved paths: the two page files, their owners' register fragments, and nothing else. No case values in the PR, the register notes or this issue. First dispatch after the plan approval; it blocks <issue id="3c0abf63-59db-4f84-b10b-71e35a5162f3" href="https://linear.app/vaper/issue/GRS-22/verify-newer-2131-document-and-json-export-compatibility">GRS-22</issue> and <issue id="75c4dcbc-09d3-4db9-b156-0c1fb1ea6aa7" href="https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery">GRS-104</issue> because both need a green dev gate as their base.
