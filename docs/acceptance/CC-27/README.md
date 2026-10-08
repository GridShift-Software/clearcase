# CC-27 acceptance evidence

CC-27 is [GRS-35](https://linear.app/vaper/issue/GRS-35/set-up-pstack-and-verification-skills-for-agent-cli-access), agent tooling and the Linear plan sync. The receipts in `evidence-b0b83a3/` were produced at `b0b83a344486fccf4f93559978d9c93aa080a206` on branch `feature/grs-35-agent-tooling`, base `dev` at `81c3f4b`, on `puk` (CachyOS, bash 5.3, Python 3.14.7, Node 26.10, git 2.56). Later commits on the branch change only this directory. Run `git diff --stat b0b83a3 HEAD` to confirm that before accepting these receipts for the reviewed head. They contain no case material, and paths under the home directory appear as `~`.

## Independent rerun (verification item 7)

From a fresh checkout or worktree of the reviewed head on `puk`:

```sh
git rev-parse HEAD
git clone https://github.com/backnotprop/pstack.git .local/pstack-upstream
git -C .local/pstack-upstream checkout --detach 124f622bcaeac490e7e9dac6af83f3ef9611d554
CC27_READBACK=/home/operator/Work/Active/MX-two/ClearCase/clearcase/.orchestration/linear-readback.json \
CC27_EXPORT=/home/operator/Work/Active/MX-two/ClearCase/clearcase/.orchestration/linear-export.json \
CC27_PSTACK_CHECKOUT=.local/pstack-upstream \
CC27_OUT=/tmp/cc27-review \
  bash docs/acceptance/CC-27/rerun.sh; echo exit=$?
```

The clone must contain the pinned pstack revision from `scripts/agent-tools/skills.lock.json`; `.local/` is ignored. `rerun.sh` runs every step below in `env -i HOME=$HOME PATH=/usr/local/bin:/usr/bin:/bin bash --noprofile --norc`. It creates and removes a throwaway detached worktree for item 6. Then it writes `summary.tsv`, `revision.txt`, `transcripts/` and `receipts/` under `CC27_OUT`. It exits 1 if any step's exit code differs from the expectation. Without `CC27_READBACK` the Linear steps, and without `CC27_PSTACK_CHECKOUT` the pstack comparisons, are SKIPPED, and the run exits 3 (INCOMPLETE) instead of 0. If the export changes, `v3-description-drift` may return 0 (no drift) instead of 1. Set `CC27_EXPORT_EXPECT` accordingly and read the transcript.

## Results at b0b83a3

All 21 steps returned their expected exit code (`evidence-b0b83a3/summary.tsv`). `evidence-b0b83a3/revision.txt` shows the tested head with a clean worktree, and all 26 receipts record that head with `dirty: false`.

| Item | Step | Expected, actual | Evidence |
| --- | --- | --- | --- |
| 1 Bootstrap in a clean shell, repeat without duplication | `v1-bootstrap-first`, `v1-bootstrap-repeat` (reports `unchanged`), `v1-doctor` (50 skills match the pin: pstack 47, matt-pocock 3), `v1-bootstrap-remove` | 0, 0 each | `transcripts/v1-*.txt`, `receipts/v1-*/` |
| Acceptance 1, pstack source and version | `v1-pstack-upstream`, `verify pstack-upstream --checkout` against `backnotprop/pstack` at `124f622` (0.15.9, MIT). All 47 pinned pstack skills match the revision's Git objects file for file. `benchmark-checklist`, `correct` and `principle-explain-the-number` are upstream but not installed. | 0, 0 | `receipts/v1-pstack-upstream/` |
| 2 Planning checker and pstack check-plan.mjs | `v2-check-plan`. `check.py --require-linear-ids` reports PASS with 28 issues and 28 Linear mappings. `check-plan.mjs docs/delivery-plan.md` reports 13 PR sections and 0 problems. | 0, 0 | `transcripts/v2-check-plan.txt`, `receipts/v2-check-plan/` |
| 3 Fresh Linear readback | `v3-linear-relations`, `check.py --linear-relations` against the coordinator's readback read at 2026-10-08T13:04:09Z | 0, 0 | `receipts/v3-linear-relations/*-linear-relations/` |
| 3 Description drift, informational | `v3-description-drift`. 23 of 28 generated briefs match live text. The remaining 5 are listed below. | 1, 1 | `transcripts/v3-description-drift.txt` |
| 4 Valid and invalid fixtures | `v4-fixture-tests`, `bash tests/agent-tools/run.sh`, 121 passed and 0 failed | 0, 0 | `transcripts/v4-fixture-tests.txt` |
| 5 Verification capability on synthetic fixtures | `v5-plan-format-valid` (0 problems), `v5-plan-format-invalid` (4 diagnostics, exit 1 preserved), `v5-app-deferred` (SKIPPED, GRS-12), `v5-pstack-upstream-no-checkout` (SKIPPED) | 0, 0. 1, 1. 3, 3. 3, 3 | `receipts/v5-*/` |
| 6 Fresh worktree, missing dependency, skipped check | `v6-doctor`, `v6-check-plan`, `v6-fixture-tests` and `v6-pstack-upstream` in a new detached worktree. Then `v6-doctor-without-node` (FAIL with fix), `v6-plan-format-without-node` (SKIPPED), `v6-required-readback-missing` (SKIPPED, overall FAIL) and `v6-doctor-empty-path` (no python3, exit 2 with fix). The worktree was clean and removed afterwards. | 0, 0, 0, 0, 1, 3, 3, 2, all matched | `transcripts/v6-*.txt`, `receipts/v6-*/` |
| 7 Independent rerun | Coordinator-dispatched, different model family | | This README |

`evidence-b0b83a3/verify-block.txt` is the round-2 brief's VERIFY command block, run verbatim at the same revision.

`tests/agent-tools/run.sh` also proves that the doctor fails on a planted change and on a missing pinned skill, and covers `verify pstack-upstream` and `bootstrap --relock --checkout` against a synthetic upstream repository.

## What is deferred

No application exists yet. The `app` capability, browser and test dependencies, and a project `verify-<app>` skill generated with pstack `create-verification-skill` are deferred to GRS-12 (CC-03). GRS-10 (CC-02) owns the npm/TypeScript/Vitest bootstrap. No application test was run or claimed. The verification capabilities exercised in item 5 are pstack's `check-plan.mjs` and the pstack upstream comparison through `scripts/agent-tools/verify`.

## Remaining description drift

`python3 scripts/planning/generate.py --compare-linear EXPORT` reports 5 intentional differences between the regenerated briefs and Linear.

- CC-01 (GRS-9), CC-06 (GRS-16), CC-11 (GRS-21). The repository writes `BA-01 to BA-21` and `BA-01 to BA-03` where Linear uses an en dash. These acceptance items render into `docs/delivery-plan.md`, and pstack `check-plan.mjs` rejects long dashes.
- CC-12 (GRS-22). "on the newer export. Date basis, ..." replaces a mid-sentence colon for the same reason.
- CC-27 (GRS-35). The repository lists each write-scope path separately so `check.py` can test overlaps, adds `scripts/planning/**` (changed by this ticket), and rewords the scope notes.

The coordinator can make Linear match the repository with `python3 scripts/planning/generate.py --linear-payloads`, or accept the drift.

## Earlier evidence

`evidence-b0b83a3/` supersedes every step of four earlier sets, which were removed from the tree and remain in Git:

- `eb0e73c:docs/acceptance/CC-27/evidence-52a2ec3/`, round 1, before the pstack provenance and the full-bundle pin.
- `902793c:docs/acceptance/CC-27/evidence-68ba5b8/`, round 2 before a fix: `bootstrap --relock --checkout` with a path that is not a pstack checkout would have dropped every pstack pin. `bd4b029` makes it refuse, with tests.
- `028395b:docs/acceptance/CC-27/evidence-67fea56/`, round 2 before review fixes. `verify pstack-upstream` compared the checkout's working tree, where an ignored file could pass as upstream content, and `bootstrap --relock --checkout` accepted a directory that is not a Git checkout. `b8dbbb9` reads the revision's Git objects instead and refuses such a directory, with tests.
- `f090d40:docs/acceptance/CC-27/evidence-e4e5f9a/`, round 2 before a second review's fixes. A local replace ref could stand in for the pinned commit, the recorded revision was not checked to be a commit ID, and relock could remove pins without an explicit flag. `b0b83a3` fixes these, with tests.
