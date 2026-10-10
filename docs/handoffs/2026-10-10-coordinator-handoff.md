# ClearCase coordinator handoff (paused 10 October 2026, 19:48 SAST)

**Next session's focus:** resume M2 when usage is back. In order:
1. Restart the three stopped owner fix rounds.
2. Finish the shared base: BASE-R2f, lane 03, an R2f delta check, the head files, the push, then the PR to dev and Dian's review.
3. Run the owners' base-merge rounds, then one verification each.
4. Open the stacked PRs.

You are the **ClearCase coordinator**. Subagents and headless workers do all the implementation and verification. You decide, dispatch, record, push, open PRs and update Linear. The general protocol is in `docs/orchestration.md`; this file is the live state.

## For the colleague taking over: where to work

**Work on the ClearCase host (`PUK`)**, in `/home/operator/Work/Active/MX-two/ClearCase/`. Most of what you need exists only there, and some of it must never leave it:
- the real case sample in `RAWS/`, which is read-only case material and never goes into Git or external services;
- the coordinator state in `clearcase/.orchestration/`, which is deliberately not in Git because parts of it are case-derived;
- the worker worktrees in `worktrees/`. CC-08's has uncommitted work.
- the Claude sessions the resume scripts continue, in `~/.claude/projects/` on that account;
- the leak scan's needles, which are built from the local sample.

From another machine you can read the pushed branches, the PRs and Linear, but you cannot run evidence, resume workers or leak-scan.

**Auto-memory.** The project owner's Claude auto-memory is in `~/.claude/projects/-home-operator-Work-Active-MX-two-ClearCase/memory/`. It loads automatically only under that account. From another account, read `MEMORY.md` and the files it links by hand.

In this document, "the product owner" is the user who ran this session. Only they approve product-visible changes and answer the open questions below.

## Read first (do not re-derive)

All paths are under `/home/operator/Work/Active/MX-two/ClearCase/` unless absolute.

- **Standing orders SO1–SO21:** `clearcase/.orchestration/preferences.md`. Also read the auto-memory index (loaded automatically) and `AGENTS.md` (Bun only).
- **Rules that bite:**
  - RAWS and production are read-only.
  - No case material in Git or external services.
  - Only the coordinator updates Linear.
  - Leak scan plus `push-approved/<sha>` before every push.
  - Never force-push, rebase or touch `main`.
  - Never cross the CC-11 or CC-25 gates without a verdict.
  - **SO21:** spawn subagents ONLY with T3 `delegate_task` at effort xhigh, never with the Agent or Workflow tools. T3 labels those as max, and the product owner objected.
  - Product-visible register entries stay `approvedBy: null`.
- **Live log, newest at the bottom:** `clearcase/.orchestration/checkpoint.md`. Read from the "19:44 SPIN-DOWN" entry back to about 18:30.
- **Per-unit state:** `clearcase/.orchestration/units.tsv`, with the state column updated at the spin-down.
- **Verdict history:** `clearcase/.orchestration/ledger.tsv`, appended with `orch-bin/ledger-add.sh <unit> <linear> <sha> <who> <verdict> <evidence>`.
- **Briefs:** `clearcase/.orchestration/briefs/`. **Reports and verify results:** `clearcase/.orchestration/reports/<unit>/`.
- **Linear:** project "ClearCase - Realignment". The latest status update, dc2bd952 (19:47), describes the pause in user terms.

## State at the pause

Every branch below is pushed to `origin` (GridShift-Software/clearcase), leak scan CLEAN, with **no PRs open**.

| Unit (Linear) | Branch @ head | State | Next action |
| --- | --- | --- | --- |
| BASE-R2 (GRS-13/GRS-38) | `feature/m2-base-r2` @ `aa636ff` | R2e PASS (full evidence; merges clean into all 6 owners). Lanes 01 and 02 PASS_WITH_FOLLOWUPS at 853810b. | Launch **BASE-R2f** and **lane 03** together (see below). |
| CC-04 (GRS-14) | `feature/grs-14-evidence` @ `af08d57` | r2 HOLD unmerged; verify PASS_WITH_FOLLOWUPS | After the head files: `logs/CC-04-r3.resume.sh` (brief `briefs/CC-04-r3.resume.txt`) |
| CC-05 (GRS-15) | `feature/grs-15-analysis` @ `707da83` | r2 PASS; **its fix verifier was cancelled at the spin-down** | Relaunch the verifier, then write the CC-05-r3 brief (below) |
| CC-06 (GRS-16) | `feature/grs-16-quantum` @ `981f94f` | r2 **stopped mid-round** (8 commits, clean tree, report not written) | `logs/CC-06-r2.resume.sh` |
| CC-07 (GRS-17) | `feature/grs-17-registers` @ `5060cc1` | r2 PASS; verify PASS_WITH_FOLLOWUPS (2 medium) | After the head files: `logs/CC-07-r3.resume.sh` (brief `briefs/CC-07-r3.resume.txt`) |
| CC-08 (GRS-18) | `feature/grs-18-litigation` @ `20a4a1d` | r2 **stopped about 8 min in**. 8 uncommitted files stay in the worktree; a snapshot is on `origin/wip/grs-18-litigation-cc08-r2-spin-down` (801f4ff). | `logs/CC-08-r2.resume.sh`. Delete the wip ref once the round has committed. |
| CC-09 (GRS-19) | `feature/grs-19-bundles` @ `2e51b51` | r2 **stopped mid-evidence** (6 commits, clean tree, draft report) | `logs/CC-09-r2.resume.sh` (it must rerun its evidence) |

- **Local branches deliberately not pushed** (checked at 19:50; nothing is lost):
  - `feature/grs-11-gate-reference-package`, `feature/grs-12-local-pilot` and `feature/m2-plan-reconcile` are pre-rebase local copies. GitHub's stack merge rewrote their SHAs, and their trees equal `origin`'s. Pushing them would need a force-push.
  - `feature/grs-13-gate-local-pilot` (6394ad7) is the superseded first CC-24 gate. Its files are in dev, with a newer README.
  - `research/processing-pipeline` is fully in dev.
  - Local `dev` is only behind `origin/dev`.
- **Resume sessions:**
  - The stopped workers get `briefs/SPINDOWN-resume.txt`.
  - The r3 and R2f scripts carry their own resume texts.
  - Session ids are inside each `logs/<U>.resume.sh`.
- **Still running:** tmux `lock-watchdog` and `tmp-janitor`, which make no API calls. Six idle T3 child sessions from finished tasks also remain; they are harmless.

## Restart sequence

1. Check capacity with `free -m`. About 10 GB is available when idle. Browser jobs share 2 slots (`orch-bin/browser-lock`) and need more than 3500 MB available. Earlier, 4–5 heavy units ran at once.
2. **Critical path: the base.**
   - Launch R2f: `tmux new-session -d -s BASE-R2f -c /home/operator/Work/Active/MX-two/ClearCase/worktrees/m2-base-r2 /home/operator/Work/Active/MX-two/ClearCase/clearcase/.orchestration/logs/BASE-R2f.resume.sh`. Give tmux an **absolute** script path.
   - R2f covers six items: the banner overflow (medium), the 40rem wording, the features-discovery fixes, the follow-up text, **the CSV formula gap in cells after the first column (medium)**, and M1's committed-register test patch.
   - Lane 03 (merge health plus adversarial converter input) at `aa636ff`: run `python3 -I orch-bin/render-lanes.py clearcase/.orchestration/workflows/args/BASE-R2.verify.aa636ff.json 3`, then `delegate_task` with the prompt "Read <lane-03.prompt.md> and do exactly what it says".
   - When both pass, run one small delta verifier on R2f's commits (delegate_task, xhigh).
   - Then write `clearcase/.orchestration/m2-base-r2.head` (the full 40-hex SHA of the R2f head) and `m2-base-r2.identity`. The identity is `sha256:935abfe9aff259c71494a52783fb5a54ee6e1b15b12a2fa8d86858d595b25ff1` unless R2f reports a change.
   - Push, open the PR `--base dev`, link it in T3, and request `dianbrown`.
3. **Resume the stopped rounds** as capacity allows, in this order: CC-09-r2, CC-06-r2, CC-08-r2. Each picks up the base merge itself once the head files exist; their briefs handle "base merge pending".
4. **CC-05:**
   - Relaunch the verifier with `delegate_task` (prompt file `clearcase/.orchestration/reports/CC-05/r2/verify/prompt.md`) and a new `clientRequestId` such as `cc05-r2-verify-xhigh-2`.
   - Then write `briefs/CC-05-r3.resume.txt`, which does not exist yet. Model it on `CC-07-r3.resume.txt`. It covers the base merge, switching the Defence CSV keys and export names to the view-content fields (`reports/BASE-R2/report.md`, section "Per-owner fields"), deleting IDR-160/162, the verifier's mediums, and the final evidence.
   - Resume session `acdf1f73-9eb4-4e5c-a9b8-2fcac8b12657` in `worktrees/grs-15-analysis`, copying the r3 script pattern.
5. **After the head files exist:** launch CC-04-r3 and CC-07-r3.
6. **Each finished owner round:**
   - One fix verifier (delegate_task, xhigh; model the prompt on `reports/CC-07/r2/verify/prompt.md`, with port `43000 + n*10 + 9`).
   - Fix highs and mediums. Lost-edit issues count as high.
   - Then push, open a PR with `--base feature/m2-base-r2` (stacked on the base PR), link it in T3, and request Dian.
   - Record each step in the ledger, units and checkpoint. Post a Linear project update every couple of milestones.

## Commands

- **Wait for a worker:** Bash with `run_in_background` and timeout 7200000, running `/tmp/cc-wait.sh <U>`. If the janitor removed the script, recreate it: loop until `clearcase/.orchestration/logs/<U>.exit` is non-empty, `sleep 30` between checks, then echo the code. The worker's result is in `logs/<U>.json` (`.result`, `.session_id`, `.total_cost_usd`).
- **Delegate target:**
  - `{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5","options":[{"id":"effort","value":"xhigh"}]}`
  - `mode` async, `runtimeMode` full-access, `role` review.
  - Read results with `task_status` when the notification arrives.
- **New worker:** `orch-bin/run-worker.sh <U> <worktree> <brief> claude claude-opus-5-5 xhigh <usd>`. It refuses any effort other than xhigh.
- **Push:**
  1. `python3 -I orch-bin/leak-scan.py <worktree> origin/dev <sha>` must print CLEAN.
  2. `touch clearcase/.orchestration/push-approved/<sha>`.
  3. `git -C clearcase push origin feature/<b>`. A pre-push hook enforces the approval.
- **Stop a worker:**
  1. TERM, then KILL, the pane's whole process tree.
  2. `tmux kill-session`.
  3. Write `logs/<U>.exit` yourself, because the launcher's own write never runs.
  4. Check that `flock -n /tmp/clearcase-browser{,-2}.lock true` succeeds.

## Gotchas from this session

- zsh treats `$C:r…` as a modifier, so write `"${C}:refs/heads/…"`.
- Never `cd` into a worker's worktree, because the harness rebinds the working directory. Use `git -C`.
- Never write a timestamp later than `date`. That happened once and had to be corrected.
- `gh stack merge` needs each layer to contain the one below. Merge upward without rebasing, and merge by stack number. See memory `gh-stack-merge-rebases`.
- Verifiers, not workers, catch the residual lost-edit gaps: the no-JS action on another row after a refused save, and a prompt answered during an in-flight save. The CC-07-r3 and CC-08-r2 briefs carry both.

## Waiting on the product owner (do not decide these)

- The 24 product-visible parity entries from #10, plus new ones from quantum and litigation.
- V2 decisions D1–D6.
- A 365-day or 365.25-day interest year.
- The prescription rule (leap day, `<` or `<=`, interruption).
- Whether disbursement credits may be negative.
- Decimal comma or thousands separator for "0,500" and "1,500". The app currently reads "1,500" as 1 500.00 for amounts and rates, and refuses it for hours.

## Suggested skills (installed in `~/.claude/skills` on the host account)

- `recall`: at session start, to rebuild context from this chat's history and the live state.
- `unslop` and `technical-writing`: for PR bodies, briefs and Linear text. The product owner rewrites wordy text.
- `principle-guard-the-context-window`: keep bulk work in delegated subagents. Read results, not raw logs.
- `handoff`: for the next spin-down.
- Do **not** use `workflow-authoring` or the Workflow tool (SO21).
