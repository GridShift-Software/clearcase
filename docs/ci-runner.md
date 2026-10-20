# CI runner on pc1

CI (`.github/workflows/ci.yml`) runs `bun run --bun check` and `bun run --bun test` on one self-hosted GitHub Actions runner, `clearcase-pc1-vm`, inside a disposable KVM virtual machine on pc1. The full case-fixture gate stays on workers' machines; nothing on the VM holds case material.

## What runs where

| Where | What | Created by |
| --- | --- | --- |
| Workstation | `~/.config/clearcase-ci/pc1-vm_ed25519` (guest management key) and `known_hosts`, which pins the guest host key (`CLEARCASE_CI_STATE` relocates the directory and must not contain whitespace) | `scripts/ci/pc1-vm` |
| pc1 host | `/var/lib/clearcase-ci/` (`disk.qcow2`, `seed.iso`, `console.log`, `powerdown`), system user `clearcase-ci`, `/etc/systemd/system/clearcase-ci-vm.service`, `/etc/clearcase-ci-vm.nft` and the nftables table `inet clearcase_ci_vm` it loads while the VM runs, packages `qemu-system-x86`, `qemu-img`, `libisoburn`, `nftables`, `socat` | `scripts/ci/vm-host.sh` |
| Guest | Ubuntu 24.04 cloud image, 4 vCPU, 8 GiB, 40 GiB sparse disk; admin user `ciadmin`; runner user `runner` (no sudo); Bun 1.4.2 in `/usr/local/bin`; runner in `/home/runner/actions-runner`; service `actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm` | `scripts/ci/guest-provision.sh`, installed as `/usr/local/sbin/clearcase-ci-guest` |

The runner is repository-scoped, with labels `self-hosted`, `Linux`, `X64` and `clearcase-pc1` (the workflow names them in that case). The job installs Chrome for Testing 148.0.7778.96 into the runner's home with `scripts/ci/install-chrome.sh` (it unpacks a tree again only when the tree's `.zip-sha256` stamp does not name the checked zip) and wraps each check in `scripts/agent-tools/receipt --base origin/dev` after a full-history checkout. The receipts, Vitest's JSON report `vitest.json`, the summary and a `run-metadata.json` (run ID and attempt, `GITHUB_SHA`, event, ref, pull request head SHA where there is one, runner name; no environment dump) are uploaded as the `receipts` artifact, which fails the job when it is empty.

CI runs for pull requests from this repository's own branches (on GitHub's merge commit), pushes to `dev` and manual runs (`workflow_dispatch`), and for nothing else ("Public repository", below). A push to a feature branch runs nothing until its pull request exists. That push run used to duplicate the PR run of the same commit on the one runner, so the PR run queued behind it for 110-140 s. The cost: a branch gets no CI before its pull request is opened. The worker's local `bun run --bun gate`, which is required anyway, covers that stretch, and a manual run covers a branch on request (`gh workflow run CI --ref BRANCH`). A newer run of a pull request cancels the superseded one. A push to `dev` never cancels a run in progress, but GitHub keeps only one pending run per branch and replaces it with a newer one, so quick successive pushes can lose the middle commits' results (the last push always runs).

## Test step and timings

The test step puts its temporary files (`TMPDIR` and `CLEARCASE_TEST_TMP`) in a fresh directory on `/dev/shm`, removed when the step ends, and runs Vitest with six workers and its JSON reporter. The reasons, from GRS-60's measurements on this VM (synthetic data only, scratch checkouts and caches):

- The limiter was disk sync. The unit tests commit to SQLite with `synchronous=FULL`, and on the VM's ext4 disk in qcow2 each fsync is slow: a store's startup took about 200 ms there. On tmpfs the test files' summed time fell from 216 s to 117 s. Workers' machines already have tmpfs `/tmp`, so CI now matches them. Durability under power loss was never something a unit test could observe. The test files used under 64 MB of `/dev/shm`.
- The other limiter was sleeping. Four unit tests hold `work.sqlite`'s write lock through every attempt and expect the 503, and each waited the production 9.5 s (4 × `busy_timeout` 2,000 ms plus 1.5 s of backoff). They now use `withoutBusyWait` (`src/lib/local-case/test-support.ts`), which sets the connection's `busy_timeout` to 0 for that write only, so the held lock, `SQLITE_BUSY`, the four attempts, the backoff and the 503 all stay real. `src/lib/local-case/busy.test.ts` runs the production budget end to end and fails if `busy_timeout` or the backoff changes. Tests that release the lock during the wait keep the production timing, and so do the e2e lanes in the local gate.
- `vitest.config.ts` starts the files that wait longest first (`SLOW`). On a fresh checkout Vitest otherwise orders files by size, which put them last.
- Six workers on four vCPUs, because much of the run is asleep. The run takes about 85 CPU-seconds, so four vCPUs set a floor of about 21 s. Eight workers came within 1 s of that floor, but the load average reached 9, and one of six trials with eight workers failed `tests/gate/pidfile.test.ts` because an orphan was not reaped in time. Six workers ran clean.

Measured on 12 October 2026 by running each commit's own workflow steps in scratch homes on this VM. Each side had one cold run (empty home: Chrome download, empty Bun cache), then five warm runs, alternating with the other side. Times are medians in seconds, with the warm range; the queue is not included. Both sides passed every run: 1943 tests before, 1979 after (the 36 new ones are GRS-60's).

| step | before (`6edaff0`) warm | after (`cd6845e`) warm | before cold | after cold |
| --- | --- | --- | --- | --- |
| install Chrome | 3.7 (3.7-3.7) | 0.2 (0.2-0.2) | 32.7 | 33.7 |
| `check` | 10.0 (10.0-10.1) | 10.3 (10.1-10.5) | 10.5 | 10.8 |
| `test` | 87.2 (84.4-90.2) | 25.4 (25.2-25.5) | 84.3 | 25.3 |
| whole job | 101.3 (98.5-104.4) | 36.3 (35.9-36.4) | 134.1 | 76.4 |

`check` grew 0.3 s with `source-check`. Removing the duplicate push run saves queue time, which this table does not show: on 12 October such a run held the runner for 110-140 s while the pull request run waited.

## What a failed run tells an agent

The `summary` step runs even after a failure. It writes the job summary, and `summary.md` and `summary.json` into the `receipts` artifact. It fails the job, with exit 1, unless the `check` and `test` receipts both exist for the checked-out HEAD, ran on a clean tree, and say PASS with exit 0, and unless `vitest.json` lists every tracked `*.test.ts` file (except `tests/acceptance/`, which Vitest never collects) with at least one test, none failed and none skipped. A skipped test fails the job, because a skip usually means a missing tool. Each problem names:

- its check (`check` or `test`);
- the file and line where there is one: `tsc`'s `file(line,col): error TSnnnn`, `svelte-check`'s machine output, `source-check`'s `path:line:col: error [rule]`, or a failing test's line from Vitest's task location;
- the raw diagnostic, or the contract that failed (a missing receipt, a receipt for another revision, a skipped test, a test file missing from the report);
- the command that reproduces it, such as `bun run --bun test tests/a.test.ts -t 'name'` or the receipt's own command.

Read it with `gh run view RUN_ID` (the summary) or `gh run download RUN_ID -n receipts` (`summary.json`, and the full logs in each receipt's `stdout.txt` and `stderr.txt`). `bun scripts/ci/summary.ts DIR check test` runs the same verdict on local receipts.

## Public repository

The repository has been public since 20 October 2026. Anyone can read its code and its workflow logs, fork it, open issues and comment; any signed-in GitHub user can download a run's `receipts` artifact. Only collaborators can open pull requests. The runner must still run only this repository's own code. Three layers, each weaker than the next: the job's guard (a pull request's run uses the pull request's own copy of the workflow, so it can drop the guard); GitHub's settings (an organization member needs no approval, so a writer can send a fork's workflow to the runner); and the runner's own admission hook (below), which does not depend on the workflow file or on who opened the pull request.

**State on 20 October 2026: the hook is installed on pc1, loaded by the running runner and proven on the real `Runner.Worker`.** Source `4fb92a92584063d2850972eeee4930eb8811d118` was provisioned onto actions/runner 2.338.0, the version the hook was reviewed against (hook sha256 `54d266cb…`, policy `fdb92480…`). The service restarted and the readback matched at 17:14 UTC. The proof ran between 17:20 and 17:24 UTC from a checkout at `ff87e18cd7655b747327829b366cbc9520565591`, whose `scripts/ci` is identical to the installed source, using throwaway branches and a draft pull request of this repository (no fork), which the coordinator closes and deletes unmerged:

- **Refused, a push to a branch other than `dev`:** runs [39464961995](https://github.com/GridShift-Software/clearcase/actions/runs/39464961995) (the workflow sets `GITHUB_REPOSITORY`, `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH` and `GITHUB_REF` to look like a push to `dev`) and [39464962224](https://github.com/GridShift-Software/clearcase/actions/runs/39464962224) (plain). Both failed with no step, the runner's own `Worker` log for each processes only the hook step and ends with exit 137, the guest's admission log has a `denied event=push` line for each, and neither the ordinary nor the `always()` marker was written. GitHub kept no log for those jobs (HTTP 404), so the absence of the markers rests on the runner's `_diag` logs and the admission log, not on an empty GitHub log.
- **Admitted, a pull request from a branch of this repository:** runs [39464982453](https://github.com/GridShift-Software/clearcase/actions/runs/39464982453) (same overrides) and [39464982317](https://github.com/GridShift-Software/clearcase/actions/runs/39464982317) (plain). Both ran their ordinary and `always()` steps, and the payload's repository, head and base were all `GridShift-Software/clearcase`. The runner ignored the workflow's `GITHUB_*` overrides, so a job cannot supply them to the hook.
- **After the proof,** the Listener had not restarted, its environment carried the one hook assignment, and GitHub showed `clearcase-pc1-vm` online with the four labels.
- **Not covered:** a push to `dev`, a manual run, and a pull request from a fork. The rejection of a fork's pull request rests on `tests/ci/admission-hook.test.ts` and on the fix re-check's probes under the runner's own command line, not on a live fork pull request.

Forks of the public repository are still possible, and a fork's copy of the workflow can drop the guard, but this runner takes no job from a fork and the hook ends a pull request whose head is not this repository. The primary control is that only collaborators can open pull requests; the hook backs it. This is not a defence against a trusted writer: a job the hook admits runs as `runner` and can change what later jobs run (Limits, below).

### Settings

The coordinator set and read these on 20 October 2026 with an admin `gh` login; GRS-158 read them again at 14:40 UTC the same day. Read them again with the same commands after any change to the settings, the collaborators or the organization's members. Use the REST API's default version, `2022-11-28`: a newer version returned unreadable JSON that day.

| Setting | Value on 20 October 2026 | Read with `gh api` |
| --- | --- | --- |
| Visibility and issues | `visibility: public`, `has_issues: true` | `repos/GridShift-Software/clearcase` |
| Who can open a pull request | `pull_request_creation_policy: collaborators_only`. In an organization's repository GitHub counts only the write, maintain and admin roles as collaborators for this. | `repos/GridShift-Software/clearcase` |
| Forks | `allow_forking: true`. A public repository cannot refuse forks; this flag governs private forks. | `repos/GridShift-Software/clearcase` |
| Approval of a fork's workflow run | `approval_policy: all_external_contributors`: a user who is not a member or owner of the repository and not a member of the organization needs a writer's approval. | `repos/GridShift-Software/clearcase/actions/permissions/fork-pr-contributor-approval` |
| Actions | `allowed_actions: selected`, `sha_pinning_required: true`, `github_owned_allowed: false`, `verified_allowed: false`, and only the four actions below | `.../actions/permissions`, `.../actions/permissions/selected-actions` |
| Workflow token | `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false` | `.../actions/permissions/workflow` |
| Runners | `clearcase-pc1-vm` alone, labels `self-hosted`, `Linux`, `X64`, `clearcase-pc1` | `.../actions/runners` |

The allowed actions, each pinned to the commit the workflow uses:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1)
- `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6` (v2.2.0)
- `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1` (v7.1.0)
- `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9` (v7.0.2)

GitHub refuses a run that uses any other action or commit, so bumping an action changes the workflow, this list and the repository's allowed actions together.

GRS-158 also read, on 20 October 2026: the collaborators are two admins and one member with the read role, and all three are private members of the organization; `main`, the default branch, has no workflow files; `dev` has no branch protection and the repository has no rulesets; Dependabot security updates are off (its alerts are on).

### Who can run code on pc1

- **A pull request from a branch of this repository, a push to `dev`, a manual run.** Each runs code that someone with write access pushed. The job runs.
- **A fork's pull request.** The guard skips it, but the fork's copy of the workflow can drop the guard. Two settings stop it instead: only writers (today the two admins) can open a pull request, and a fork's run from an external contributor, as the table above defines one, waits for a writer's approval. Organization members need no approval, so a writer who opens a pull request from a fork, their own or anyone else's, sends that fork's workflow to pc1 without one. After a writer has opened and reviewed such a pull request, the fork's owner can still push to its head branch, and whether GitHub gates those new runs (`synchronize`) has not been verified. Open pull requests only from branches of this repository, never from a fork, and never approve a fork's workflow run. With the admission hook installed, none of this reaches a step: the hook reads the pull request's head repository from the payload GitHub sent and ends the job for any head that is not this repository, whoever opened or updated it.
- **Issues, comments, discussions, stars and forks.** No workflow listens. GitHub runs the default branch's workflows for these events and for `pull_request_target`, `workflow_run` and `schedule`; `main` has none yet, and the one it will get from `dev` lists only `pull_request`, `push` to `dev` and `workflow_dispatch`.

Adding an organization member, or giving anyone the write role, widens who can run code on pc1.

### The guard and its tests

The `check` job runs only in `GridShift-Software/clearcase`, and only for a pull request whose head is a branch of this repository, a push to `dev` or a manual run. Any other event is skipped, takes no runner and uses no GitHub-hosted minutes. GitHub counts a skipped job as passing a required status check; `dev` has no required checks, and `orch-bin/merge-check` requires the `check` job to have succeeded, so a skipped run never clears a merge. A fork's own copy of the workflow is skipped too, instead of waiting for a runner the fork lacks.

`tests/ci/workflow-admission.test.ts` evaluates each job's guard and each workflow's triggers with GitHub's expression rules (`tests/ci/actions-expression.ts`) against pull requests from forks, deleted forks and a fork's own branches, `pull_request_target`, `workflow_run`, issue and comment events and the other events, and pushes to other branches and tags, for every job in every workflow. It also checks that each job can land only on `clearcase-pc1-vm`, has a token that only reads, uses only the actions listed above, checks out without keeping a credential, stops within an hour and puts no `${{ }}` expression inside a script. These tests run in the pull request they judge, so a pull request that edits `.github/` can edit them too: read such a diff before merging it.

### The runner's admission hook

`scripts/ci/guest-provision.sh` (`provision`) installs a job-started hook, so the runner itself ends a job whose event is not this repository's own, whatever the workflow file says.

| What | Where | Owner and mode |
| --- | --- | --- |
| Hook, run by the runner as `bash -e` | `/usr/local/lib/clearcase-ci/job-started-hook.sh` | `root:root`, `0755` |
| Policy, run as `python3 -I` by the hook | `/usr/local/lib/clearcase-ci/job-started-policy.py` | `root:root`, `0644` |
| systemd drop-in: `Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=<the hook>` | `/etc/systemd/system/actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm.service.d/10-clearcase-admission.conf` | `root:root`, `0644` |
| Denial log, one line per refusal, written by the hook as the runner user | `/home/runner/clearcase-admission.log` | `runner`; a convenience, not evidence |

The runner user can read and run the first two but not change them, and not the drop-in or their directories. The worker takes the variable from the listener's environment, which is fixed when the service starts, so installing or changing any of them restarts the runner service: `provision` stops it first when it is running and a file differs (or a new runner version unpacks), reloads systemd, and starts it again under the same lock and with the same restoration as before. After it has installed the files, `provision` refuses to start the service, and stops a running one, if systemd's loaded unit does not carry the variable (`systemctl show --property=Environment`); a failure before that check restores the service's entry state, which on a runner provisioned without the hook is running without it. `register` refuses to run unless the three files are there and the drop-in names the hook, and refuses to start the reinstalled service unless systemd has loaded the variable.

**What the hook decides from, and why that cannot be supplied by a job.** Read in actions/runner v2.338.0 (`JobExtension.cs`, `JobHookProvider.cs`, `ScriptHandler.cs`, `StepsRunner.cs`, `Program.cs`) on 20 October 2026:

- The runner worker reads `ACTIONS_RUNNER_HOOK_JOB_STARTED` from its own process environment, which it inherits from the listener and the service, not from the job. The hook is added as the first pre-job step, before checkout, any container setup and any step of the workflow, with the condition `always()`.
- The hook step runs with an empty step environment plus the runner's `github` and `runner` contexts. The workflow's `env:` is not passed to it, so a job cannot set `GITHUB_REPOSITORY`, `GITHUB_EVENT_NAME` or `GITHUB_EVENT_PATH` for it. The payload is the event GitHub gave the runner, which the worker writes to `_work/_temp/_github_workflow/event.json` immediately before it runs the hook.
- The policy reads only that payload and `GITHUB_REPOSITORY`, `GITHUB_EVENT_NAME`, `GITHUB_REF` and `GITHUB_EVENT_PATH`. It requires the path to be exactly the file above (no link, a regular file, written in the last five minutes, under 8 MiB), JSON without a repeated key or `NaN`, `GITHUB_REPOSITORY` and the payload's `repository.full_name` both `GridShift-Software/clearcase`, and then admits only:
  - `pull_request` whose head and base repositories are both this repository (a fork's head, a deleted fork's missing head and a base in another repository are all refused; so is any payload that has a `pull_request` object under another event name);
  - `push` to `refs/heads/dev`, in the payload and in `GITHUB_REF`;
  - `workflow_dispatch` whose payload ref is `GITHUB_REF`.
  Every other event, a missing or unreadable field, a crash or a wrong type is a refusal. It names no person, role or association: who opened or updated a pull request changes nothing.
- A non-zero exit from the hook fails the job, but the worker then still runs the steps whose condition is `always()` or `failure()`; there is no "stop on a failed pre-job step". So a refusal does not rely on the exit status. The hook ends the `Runner.Worker` process above it (`kill -KILL`, found by walking `/proc` from the hook upward), the listener sees the worker die, and it completes the job as failed. No step of the job runs, and the runner stays online for the next job. If the hook cannot find a `Runner.Worker` above it, it fails the job and says so, and that job's `always()` steps may run; the live proof below shows that does not happen on pc1.

**Limits, which the tests and the proof do not remove.**

- Trusted jobs are trusted. A job the hook admits runs as the `runner` user, owns `/home/runner/actions-runner` and can do what the Isolation section says. In particular it can write `/home/runner/actions-runner/.env`, which the listener loads at its next start and which then overrides the service's environment (`Program.cs`, `LoadAndSetEnv`), `.path`, and `runsvc.sh`, the script the service starts (`svc.sh` copies it from a template). None is a boundary against a job the hook admitted; `provision` does not clean them, and the readback below checks them.
- A new actions/runner version that moves the payload file, renames the `Runner.Worker` process or changes how hooks get their environment makes the hook refuse every job, or fall back to the non-killing failure. That fails closed and shows as a failing CI, but `provision` fetches the latest runner each time, and the fail-open branch above becomes reachable if a runner wraps or renames the worker, so run the refusal proof (step 5 below) after every `provision` and every runner update.
- The hook cannot stop the downloads "Set up job" makes for the workflow's actions before it runs, and it cannot see a job that is dispatched to a runner without the variable. Nothing admits a job to a runner that has no hook unless a coordinator registers or restarts the runner without one; `register` and `provision` refuse that.
- `tests/ci/admission-hook.test.ts` runs the hook exactly as `provision` installs it, in the fake guest of `tests/ci/fake-guest.sh`, as a child of a process named `Runner.Worker` that goes on to run an `always()` step, against a pull request from a fork opened by a writer and updated by an outsider, every other event it models, and malformed, stale, linked and repeated-key payloads. Its case with no worker above the hook runs in a PID namespace with its own `/proc` (`unshare -Urpf --mount-proc`): on the real runner the test run sits under the real `Runner.Worker`, which the hook would find and end, and did, in the test step of PR 80's first run on 20 October 2026. `tests/ci/admission-hook-outer-worker.test.ts` runs the whole file under an outer stand-in worker and requires it to survive. It is a model of the worker, not the worker: it runs no real actions/runner. The live proof below is the check against the real one.

### Deploying, proving and rolling back

The hook was deployed and proven on 20 October 2026 (the state paragraph above). This section is the procedure to repeat after `provision` changes the hook or the runner, after a runner update and on a recreated guest. A coordinator with an admin `gh` login and SSH to pc1 does the following. No step needs code from a fork, and the proof must not use one: every probe is a branch of this repository. On 20 October the commands ran with `CLEARCASE_CI_HOST=carl@pc1.tail498db1.ts.net` exported (the script's default is `root@100.80.13.122`); `provision`, `register` and `ssh` use that account only to forward SSH to the guest, where `ciadmin` has `sudo`. The host subcommands (`create`, `refresh`, `destroy`) were not run as `carl`.

1. **Deploy.** `scripts/ci/pc1-vm provision` (it refuses while GitHub shows the runner busy). It upgrades packages and the runner, installs the hook and drop-in, restarts the runner service and prints the versions. A failure does not mean the runner is stopped. The script restores the service to the state it had at entry, so a first deploy that fails before the hook is installed and loaded can leave the old runner active without the hook (GRS-158's fix re-check probed this). After every failure, and after every success, do step 2 before trusting the runner; if the hook is not loaded, stop the service (`scripts/ci/pc1-vm ssh 'sudo systemctl stop actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm'`) until it is, then fix the cause and run `provision` again.
2. **Read what is installed and loaded.** All from `scripts/ci/pc1-vm ssh`:
   - `stat -c '%U:%G %a %n' /usr/local/lib/clearcase-ci /usr/local/lib/clearcase-ci/* /etc/systemd/system/actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm.service.d/*` shows `root:root` and the modes above.
   - `systemctl show --property=Environment --value actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm` contains `ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/lib/clearcase-ci/job-started-hook.sh`.
   - `sudo cat /proc/$(pgrep -u runner -f Runner.Listener | head -n1)/environ | tr '\0' '\n' | grep ^ACTIONS_RUNNER_HOOK` shows the same assignment, and only that line, in the running listener. The `cat` must run under `sudo`: a `<` redirect is opened by `ciadmin` before `sudo` starts and fails. Print only the hook assignment, never the whole environment.
   - `sudo grep -c ACTIONS_RUNNER_HOOK /home/runner/actions-runner/.env /home/runner/actions-runner/.path /home/runner/actions-runner/runsvc.sh` prints a count of 0 for each; `/home/runner` is mode 750, so these need `sudo`. `runsvc.sh` should be the stock service template (on 20 October its sha256 began `ee4b86d3`, the same before and after `provision`).
   - `gh api repos/GridShift-Software/clearcase/actions/runners` shows `clearcase-pc1-vm` online with the four labels.
3. **Admit.** A pull request from a branch of this repository and a push to `dev` each start their job (a manual run too, once `main` carries the workflow: it has none on 20 October 2026, and GitHub starts a manual run only from the default branch's workflow list), whose log begins with a "Set up runner" step: "A job started hook has been configured by the self-hosted runner administrator" and "admitted a ... event of GridShift-Software/clearcase". For the pull request, print `.pull_request.head.repo.full_name`, `.pull_request.base.repo.full_name` and `.repository.full_name` from `$GITHUB_EVENT_PATH` in a step to confirm a real payload has the fields the policy reads.
4. **Spoof.** On a pull request from a throwaway branch of this repository, set `GITHUB_REPOSITORY: example/other`, `GITHUB_EVENT_NAME: pull_request_target` and `GITHUB_EVENT_PATH: /dev/null` in the workflow's top-level `env:` and in the job's. The job must still be admitted. If it is refused, the hook is reading the workflow's environment, and the whole design fails: roll back. If GitHub rejects the workflow for those names, record that instead; the runner never sees it.
5. **Refuse.** On a throwaway branch of this repository, add a workflow with `on: push` and no job guard, whose job has a step `run: echo should-not-run` and a step `if: always()` that writes `always-step-ran`, and push the branch. A push to a branch other than `dev` is outside the policy, so the hook must refuse it. Print each marker split across `printf` arguments, so that no step header in a log contains it. Expected: the job completes as failed with no step output after the hook's, neither step ran, `/home/runner/clearcase-admission.log` has a line for the refusal, and `gh api .../actions/runners` shows the runner online and not busy. A later pull request from a branch of this repository is admitted. Delete the branch and any pull request afterwards. This is the only check that exercises the kill on the real worker: if the always() step ran, do not rely on the hook; roll back and open a ticket. Repeat it after every `provision` and every runner update, because a new runner version can change the one thing this relies on.

   Do not accept an empty or missing GitHub log as evidence: the kill can cut the hook step's log short, and on 20 October GitHub returned no log for the refused jobs. The evidence is the failed job with no steps, the admission-log line, and the runner's own logs under `/home/runner/actions-runner/_diag` (read with `sudo`): the job's `Worker_*.log` lists the hook as its only processed step, and the listener's log in the same directory records that `Runner.Worker` finished with code 137. A `Worker` log that processed the workflow's steps is a failed proof.
6. **Record.** Record the date, the runner version, the output of step 2 and the run IDs of steps 3 to 5 in the ticket, and replace the state paragraph at the top of "Public repository" with the date, the installed commit and the run links.

**Rollback.** With the runner idle: `scripts/ci/pc1-vm ssh 'sudo rm /etc/systemd/system/actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm.service.d/10-clearcase-admission.conf && sudo systemctl daemon-reload && sudo systemctl restart actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm'`. That returns pc1 to the writer rule alone. Leave the other two files: `register` needs all three and `provision` rewrites them. A guest created with `pc1-vm create` gets the hook before the runner registers.

### Limits

- GitHub-hosted runners are not turned off for the organization. That needs the `admin:org` scope, which the coordinator's login lacks. The tests refuse a job that could land on one, but a pull request can change both.
- Forks cannot be refused. A fork's copy of the workflow runs in the fork, where the guard skips it; this runner is registered to this repository and takes no fork's jobs, and with the hook installed it refuses a pull request from a fork that someone with write access opens against this repository.
- Everything a job prints is public: run logs to anyone, and the `receipts` artifact, with each check's raw stdout and stderr, to any signed-in user. No workflow reads a secret, the token only reads, checkout keeps no credential and the checks use synthetic data; keep it that way.
- The runner is persistent (Isolation, below). One admitted job that ran hostile code could change every later job and read the runner's credential. The VM boundary limits what such code reaches on pc1, not what it does on the internet.
- The guard names the repository, so after a rename or a transfer every job is skipped, and merges block, until the name in `ci.yml` changes.

## Isolation

- **The VM is disposable, a job is not.** The runner is persistent: it keeps its credentials, binaries (`/home/runner/actions-runner`, writable by `runner`), caches and `_work` between jobs, and one job can alter what every later job runs. There is no per-job isolation and no ephemeral runner. Run only code from trusted writers; the isolation boundary is the VM, and `destroy` followed by `create` removes all state it retained, including the runner credential, which `create` replaces with a new one.
- **Fork code is kept off the runner by the repository's settings, and by the admission hook, installed on 20 October 2026.** Until 20 October 2026 the repository was private, with forking and fork workflows off. It is now public, and "Public repository" above lists the settings that replace those, the hook that backs them and what both leave open. Keep pull request creation at collaborators only and fork approval at all external contributors while this runner is registered.
- QEMU runs as the unprivileged `clearcase-ci` user under systemd sandboxing, with only `/dev/kvm` and its own directory. There are no shared folders, host sockets or credentials in the guest.
- **The guest cannot reach pc1's own services, even as root.** QEMU's user-mode network turns the guest's `10.0.2.2` into pc1's loopback, and guest root can hand QEMU raw frames for any address, such as `127.0.0.53:1716`, which QEMU then connects to from pc1. So the boundary is on the host, around the QEMU process:
  - `clearcase-ci-vm.service` sets `IPAddressDeny=` for all of `127.0.0.0/8` and `::1`, private ranges, the tailnet and pc1's own networks, and `IPAddressAllow=` for `127.0.0.57` (the SSH forward) and `127.0.0.53` (the resolver QEMU forwards the guest's DNS to). These lists are per address, not per port.
  - Before QEMU starts, the service loads the nftables table `inet clearcase_ci_vm` from `/etc/clearcase-ci-vm.nft`, and deletes it after QEMU stops. Its output chain drops every packet that the `clearcase-ci` user sends to pc1 itself (routed through `lo`), except DNS (TCP and UDP port 53) to `127.0.0.53` and replies on connections that came in to `127.0.0.57:2257`. A connection QEMU opens from that port is not a reply, so it is dropped too. The table touches no other table or user. Flushing pc1's whole ruleset (`nft flush ruleset`, or starting `nftables.service` after the VM) removes it while the VM runs; run `scripts/ci/pc1-vm restart` afterwards.
  - The same table also drops, for that user and on any interface, IPv4 multicast (`224.0.0.0/4`), the limited broadcast `255.255.255.255` and IPv6 multicast (`ff00::/8`), and `IPAddressDeny=` lists the same three. These leave through pc1's LAN interface, not `lo`, so the `lo` rules never see them, yet pc1's wildcard mDNS and LLMNR listeners receive them by multicast loopback.
  - The only inbound path is SSH forwarded from `127.0.0.57:2257` on pc1. Because the service's source address must be allowed, `pc1-vm` reaches the guest through `socat` on pc1 bound to `127.0.0.57`.
  - `scripts/ci/vm-boundary-probe` proves this from guest root with raw frames: it fails if any of pc1's loopback addresses answers on a denied port, over TCP or UDP, or if a wildcard listener on pc1 receives raw UDP from the guest sent to a synthetic multicast group (`239.255.57.57`) or to `255.255.255.255`, and checks that DNS, HTTPS to github.com and management SSH still work. It changes nothing on pc1 or in the guest, so it can run while a job does.
  - Inside the guest, nftables additionally stops the `runner` user from reaching `10.0.2.2` and private ranges.
- The deny list of pc1's own networks is read when the unit is written, at `create`. After pc1's addresses or routes change, run `scripts/ci/pc1-vm refresh` to rewrite the unit and restart the VM.
- Ubuntu 24.04 refuses unprivileged user namespaces by default, and the browser tests need them (`unshare -rn`). The guest sets `kernel.apparmor_restrict_unprivileged_userns = 0` in `/etc/sysctl.d/60-clearcase-ci-userns.conf`, so jobs don't need sudo. That widens the guest's kernel attack surface, which is why the host boundary above matters.
- Registration uses a one-hour token piped from `gh api` into the guest; it is never printed, stored or passed on a command line. The runner keeps only its own runner credential.

## Commands

Run these from a checkout on a workstation with SSH to pc1 over Tailscale (`root@100.80.13.122` by default; the 20 October deploy used `carl@pc1.tail498db1.ts.net`) and an admin `gh` login. `verdict` needs only management SSH, without a GitHub login or API request; `verify` also needs GitHub, to pause dispatch. Override the host with `CLEARCASE_CI_HOST`.

`provision`, `refresh` and `restart` refuse to run unless GitHub reports `clearcase-pc1-vm` as registered and idle, because they would kill a running job: a GitHub API error or a runner missing from the list also refuses. Only `create` provisions a VM that isn't registered yet. `stop` does not check. In the guest, `provision` and `register` refuse while `verify` holds its lock, and the reverse.

| Command | Effect |
| --- | --- |
| `scripts/ci/pc1-vm create` | Create the key if needed, build and start the VM, provision it and register the runner |
| `scripts/ci/pc1-vm provision` | Rerun guest provisioning: package upgrades, Bun, latest actions/runner and the admission hook (the runner service stops while a new version unpacks or the hook changes, systemd reloads, then it starts; it stays stopped if systemd has not loaded the hook, and after any failure it restores the entry state, so read the loaded hook back as in "Deploying, proving and rolling back") |
| `scripts/ci/pc1-vm register` | Register again with a fresh token, replacing the runner of the same name; refuses unless provision has installed the admission hook, and does not start the reinstalled service unless systemd has loaded it; a failure before `config.sh` succeeds restores the previous registration and service state |
| `scripts/ci/pc1-vm refresh` | Rewrite the service unit and `/etc/clearcase-ci-vm.nft` with pc1's current networks and restart the VM; the disk and runner stay |
| `scripts/ci/pc1-vm ssh [COMMAND]` | SSH to the guest as `ciadmin`, through pc1 to `127.0.0.57:2257` |
| `scripts/ci/pc1-vm verify REV` | Pause dispatch to the runner through GitHub, bundle the committed revision and cached `origin/dev`, run the CI commands in the idle guest, store receipts, resume dispatch once the guest is done and print `PASS SHA` or `FAIL SHA` plus the receipt directory when the checks ran to completion |
| `scripts/ci/pc1-vm verdict SHA` | Read the most recent completed result for a full commit SHA; print its verdict and receipt directory, or `UNKNOWN SHA` (exit 2) |
| `scripts/ci/pc1-vm status`, `stop`, `start`, `restart` | `systemctl` on `clearcase-ci-vm.service`; `stop` powers the guest off cleanly |
| `scripts/ci/vm-boundary-probe` | Check from guest root that pc1's loopback, multicast and broadcast are closed and DNS, github.com and SSH work; exits 1 on any reachable denied port |
| `scripts/ci/pc1-vm destroy` | Delete the runner from GitHub, then stop the VM and delete everything `create` made on pc1 |

`vm-host.sh` installs the QEMU packages without syncing pacman's database, so it never partially upgrades pc1. When that database is older than the mirrors, a few files 404; on 12 October 2026 the fix was to install `wolfssl-5.9.2-1`, `vde2-2.3.3-9` and `iniparser-4.3.0-1` from `https://archive.archlinux.org/packages/` with `pacman -U --asdeps`, then rerun `create`.

The VM starts on boot and the runner service starts with the guest. `create` refuses to run while `/var/lib/clearcase-ci/disk.qcow2` exists, so recreating is `destroy` then `create`. It fetches the current Ubuntu 24.04 cloud image and the latest actions/runner, and checks both against published SHA-256 sums. Neither is pinned, so `provision` prints the versions it ends with. On 12 October 2026 they were Ubuntu 24.04.5 LTS (cloud image serial 20260926), kernel 6.8.0-146-generic, actions/runner 2.338.0, Bun 1.4.2, Chrome for Testing 148.0.7778.96 and QEMU 11.1.1 on pc1.

`destroy` removes only the runner named `clearcase-pc1-vm`, `clearcase-ci-vm.service`, `/etc/clearcase-ci-vm.nft`, the `inet clearcase_ci_vm` table, `/var/lib/clearcase-ci` and the `clearcase-ci` user. The packages stay; `nftables` and `socat` were already on pc1 on 12 October 2026, so remove only the QEMU ones with `pacman -Rs qemu-system-x86 qemu-img libisoburn` if nothing else uses them. The same thing by hand on pc1:

```sh
gh api repos/GridShift-Software/clearcase/actions/runners --jq '.runners[] | select(.name == "clearcase-pc1-vm") | .id'
gh api -X DELETE repos/GridShift-Software/clearcase/actions/runners/RUNNER_ID   # from the workstation
systemctl disable --now clearcase-ci-vm.service                                 # on pc1, as root
rm -f /etc/systemd/system/clearcase-ci-vm.service /etc/clearcase-ci-vm.nft && systemctl daemon-reload
nft delete table inet clearcase_ci_vm 2>/dev/null                               # normally gone when the service stops
rm -rf /var/lib/clearcase-ci && userdel clearcase-ci
```

## Running the CI checks by hand in the guest

Prefer `scripts/ci/pc1-vm verify REV`, described below: it pauses dispatch through GitHub, checks for a running job, captures receipts and restarts the runner through an exit trap. The older manual recipe below requires those precautions from the operator.

Stop the runner service first, so a live job doesn't race this run for `~/.cache` and `~/.bun`, and start it again afterwards. The guest holds no GitHub credential, so send the source over the SSH link as a bundle and run the job's commands as `runner`:

```sh
git branch -f ci-bundle HEAD && git bundle create /tmp/ci.bundle ci-bundle && git branch -D ci-bundle
scripts/ci/pc1-vm ssh 'sudo systemctl stop actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm'   # only when no job is running
scripts/ci/pc1-vm ssh 'cat > /tmp/ci.bundle && chmod 644 /tmp/ci.bundle' < /tmp/ci.bundle
scripts/ci/pc1-vm ssh 'sudo -u runner -H bash -c "cd && rm -rf by-hand && git clone -q -b ci-bundle /tmp/ci.bundle by-hand && cd by-hand &&
  scripts/ci/install-chrome.sh && bun install --frozen-lockfile && bun run --bun check &&
  t=\$(mktemp -d /dev/shm/by-hand.XXXXXX) && TMPDIR=\$t CLEARCASE_TEST_TMP=\$t bun run --bun test --maxWorkers=6; s=\$?; rm -rf \$t; exit \$s"'
scripts/ci/pc1-vm ssh 'sudo systemctl start actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm'
```

Recreating the VM registers a new runner ID under the same name and labels, so the workflow needs no change.

## Verdicts from the CI VM

```sh
scripts/ci/pc1-vm verify HEAD                                            # needs GitHub, to pause dispatch
GH_HOST=github.invalid scripts/ci/pc1-vm verdict FULL_40_CHARACTER_SHA   # answers with GitHub unreachable
```

`verdict` answers without GitHub. `verify` produces a verdict for a fresh bundle only while GitHub is reachable, because it pauses dispatch through GitHub before it stops the runner and refuses when it cannot. GRS-139 first asked for `verify` to work with GitHub unreachable too; the user's decision of 18 October 2026 ("Fine, just use GitHub to trigger CI runs") narrowed that, because sampling the guest for a quiet runner cannot exclude a job GitHub dispatches just before the stop.

`verify` resolves `REV` in the script's checkout and sends only that commit's history and the locally cached `origin/dev` history as a Git bundle. It neither fetches nor changes local refs; uncommitted edits are excluded. The cached base must exist because the job's receipt commands use `--base origin/dev`. Both commands reach the guest over the existing workstation-to-guest management SSH path; no listener, guest credential or guest-to-host connection is added. `CLEARCASE_CI_SSH` is an executable SSH transport override for the local fake-guest tests; leave it unset for real management SSH.

Before it touches the guest, `verify` reads the runner from GitHub (`gh api repos/GridShift-Software/clearcase/actions/runners`). It refuses with exit 1, stopping nothing, when that read fails (GitHub unreachable or `gh` not logged in), when GitHub does not list `clearcase-pc1-vm` or when GitHub reports it busy. Otherwise it pauses dispatch by removing the runner's custom label `clearcase-pc1` (`gh api -X DELETE repos/GridShift-Software/clearcase/actions/runners/ID/labels/clearcase-pc1`). Every workflow job requires that label, which a test checks over `.github/workflows/`, so GitHub assigns the runner no new job while the label is gone and new jobs wait in the queue. Only one removal can succeed, so the label also keeps a second `verify`, from another workstation, from running at the same time. A failed removal refuses with exit 1. After `CLEARCASE_CI_PAUSE_SETTLE_SECONDS` (default `5`) it reads the runner again: a runner still busy, meaning a job GitHub assigned before the label went, refuses with exit 3, and an unreadable state or a label still present refuses with exit 1. Only then does it upload the bundle. The pause changes this runner's labels only, not repository settings, and needs the admin `gh` login that `register` and `destroy` already use. A runner without the label at entry refuses with exit 1 and stays paused, because another `verify` may hold that pause and lift it mid-run.

The workstation's EXIT trap puts the label back (`gh api -X POST repos/GridShift-Software/clearcase/actions/runners/ID/labels -f 'labels[]=clearcase-pc1'`) on every exit after a successful removal, including HUP/INT/TERM. Once the guest phase has begun, it does so only after a fresh SSH session has taken the guest's verification lock (`sudo flock -w 300 /run/clearcase-ci-verify.lock true`), because a guest session can outlive its SSH client and stop the runner after an early resume. `CLEARCASE_CI_RESUME_WAIT_SECONDS` (default `300`) bounds that wait; it returns at once after a normal run. If the session cannot confirm the lock is free (the guest is unreachable or still busy past the bound), the label stays off, `verify` exits nonzero and prints the command to run once it is: `scripts/ci/pc1-vm ssh sudo flock -w 300 /run/clearcase-ci-verify.lock true && gh api -X POST repos/GridShift-Software/clearcase/actions/runners/ID/labels -f 'labels[]=clearcase-pc1'`. A refusal before the guest phase resumes at once. If that call fails, `verify` exits 1, even after a PASS, and prints the command; until someone runs it, the runner is online but gets no jobs. After a failed or interrupted removal it does not add the label back, since another `verify` may have removed it; it prints the same command, to run only if the label is gone and no other `verify` is running.

The guest holds one `flock` across admission, service stop, checks, restoration and verdict publication. Before stopping anything it reads systemd's `ActiveState`; unreadable or transitional states refuse verification. An active service is stopped and restored to active after success, failure or HUP/INT/TERM, including a failed stop. An inactive or failed service is left untouched, preserving its entry state without starting it. The exit trap checks that the final state matches the entry state and removes the uploaded bundle and checkout. A failed restoration or cleanup makes `verify` exit 1 and says why; it does not change the verdict of checks that ran to completion. `guest-provision.sh provision` takes the same lock and reads a registered service's entry state before any provisioning mutation. Version replacement stops only an active-at-entry service; its EXIT trap restores that state and removes scratch after success, failure or HUP/INT/TERM under the lock. First provision without a registered service leaves service startup to `register`. `guest-provision.sh register` takes the same lock and reads a registered service's entry state before any mutation, refusing unreadable or transitional states. It stops the service only if it is active, uninstalls the unit, and moves the previous registration files (`.runner`, `.credentials`, `.credentials_rsaparams`) into a root-only scratch directory until `config.sh` succeeds. Until then its EXIT trap, after a failure or HUP/INT/TERM, puts back exactly the files recorded at entry (removing only files a failed `config.sh` wrote, never one that existed at entry and was not yet moved aside; a file it cannot put back stays in the named scratch directory), reinstalls the unit and starts the service if it was active; a failed service comes back inactive, because a reinstalled unit starts inactive. Once `config.sh` succeeds, the new registration has replaced the old one on GitHub, so a later failure is reported, not rolled back. A powered-off guest, SIGKILL or broken systemd cannot be repaired by a shell trap.

After the GitHub pause, the guest confirms quiet before any service stop. It requires three consecutive idle observations spanning at least five seconds, with `pgrep -u runner Runner.Worker` absent at each and unchanged Worker diagnostics throughout. A worker at the first observation refuses with exit 1; activity at a later observation refuses with exit 3 before stopping or running checks. The lock remains held throughout. `CLEARCASE_CI_QUIET_SECONDS` (default `5`), `CLEARCASE_CI_IDLE_OBSERVATIONS` (default `3`) and `CLEARCASE_CI_DRAIN_TIMEOUT` (default `30`) are forwarded as numeric arguments to the guest; quiet/timeout accept decimal seconds. Require `0 < quiet <= timeout <= 300` and `2..100` observations. Samples are spaced by `quiet / (observations - 1)`; the sampling loop uses a monotonic deadline and bounds its process probes by the remaining time. Timeout refuses with exit 3; it never proceeds on a partial quiet period. Inspection/configuration errors also fail closed.

The snapshots include Worker log names, inodes, sizes and nanosecond modification/change times, plus the diagnostic directory's inode, size and modification/change times. Directory changes conservatively refuse even if a transient Worker log has already vanished; listener log creation/rotation can also cause a refusal. Writes to existing listener logs are excluded. After stop, compare the original snapshot again and require no worker before running checks; activity in that final interval refuses and restores the service. Missing, unsafe or changing diagnostic history refuses admission. This relies on the guest filesystem recording metadata changes; snapshots do not provide a filesystem event journal.

The runner itself offers no live drain. In the [runner listener source](https://github.com/actions/runner/blob/main/src/Runner.Listener/Runner.cs), `--once` is selected at process startup; changing a live registered service to it would itself require a stop/restart. Listener shutdown [cancels running dispatches](https://github.com/actions/runner/blob/main/src/Runner.Listener/JobDispatcher.cs), so ordinary service stop does not establish a graceful drain. That is why the pause goes through GitHub.

The guarantee is that GitHub assigns the runner no job from the confirmed pause until the resume, and that the guest saw no worker and no Worker-log activity from before the stop until after it. What remains:

- GitHub's `busy` flag is the only evidence that no job was assigned before the label went. The settle period and the guest's confirmation cover a flag that lags.
- Jobs queued while `verify` runs wait for the resume, about as long as one CI job.
- Interrupting `verify` on the workstation does not resume dispatch until a fresh session sees the guest lock free, so a guest session that outlives the lost SSH connection finishes and restores the runner first. Interrupting again during that wait leaves the label off, and the command above lifts the pause.
- The manual lock serializes verify, provision and register, not GitHub dispatch. Once stopped, this assumes systemd has quiesced the listener and nobody independently starts it.

Other subcommands retain their GitHub-based `not_busy` checks.

Checks run as `runner` in a fresh bundle clone with a minimal environment (`CI=true`). The commands match the job: install Chrome, `bun install --frozen-lockfile`, the `check` and six-worker tmpfs `test` steps under `scripts/agent-tools/receipt --base origin/dev`, then `summary.ts` even after a failed check. A missing, failed or skipped check cannot produce PASS.

Results live on the guest's persistent disk, owned by `runner`:

```text
/home/runner/ci-results/<full-sha>-<run>-<attempt>/
  verdict.txt              # PASS <full-sha> or FAIL <full-sha>; published last, only after the checks ran to completion
  run-metadata.json        # checkout_head, GITHUB_SHA, PR_HEAD_SHA, run/attempt; no environment dump
  <timestamp>-check/       # receipt.json (if check ran)
  <timestamp>-test/        # receipt.json (if test ran)
  summary.json, summary.md # if summary ran
```

For manual verification `run` is `verify` and `attempt` is a unique suffix; its GitHub SHA and PR head fields are empty. Manual receipts are written directly into the store and additionally retain `stdout.txt`, `stderr.txt` and `vitest.json`. Every GitHub job copies only regular `receipt.json` files and the top-level `summary.json`/`summary.md` into `<GITHUB_SHA>-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`. It rejects symlinks, special files and paths resolving outside the receipt directory, and never copies raw stdout/stderr into the persistent store. Metadata is regenerated from the allowlist. The existing Actions artifact upload still uploads the original receipt directory, including raw output; this change does not scrub that artifact or manual output.

GitHub entries record both `GITHUB_SHA` and `PR_HEAD_SHA`, and store FAIL if an earlier step failed or the summary is missing or fails. For a PR, the key and verdict refer to GitHub's tested merge commit; `PR_HEAD_SHA` records the branch head without giving it a verdict. Results survive guest reboot and are lost on `destroy`; no automatic retention cleanup is installed.

`verify` publishes a verdict only when the checks ran to completion (`check` and `test` finished, passing or failing). A refusal, a failed stop, a guest signal or a workstation interrupt publishes no `verdict.txt`, prints no `PASS`/`FAIL` and no scope line, and leaves the latest earlier verdict for that SHA the answer; its entry directory has no `verdict.txt`, so `verdict` ignores it. A failed restart or resume after completed checks changes the exit status to 1, not the verdict: it still prints and stores the PASS or FAIL. `verify` exits 0 only for PASS and nonzero for refusal, failure or transport errors; exit 3 is a refusal because of a job that GitHub assigned before the pause took effect, or activity the guest saw after its first observation. `verdict` requires the full SHA and exits 0 for a stored PASS, 1 for a stored FAIL, or 2 for UNKNOWN. It ignores unfinished entries and entries naming another SHA, chooses the latest completed `verdict.txt` modification time (directory name breaks ties), and prints the guest's receipt directory. Reads use non-following directory/file descriptors, `lstat`-equivalent checks and realpath containment. A symlinked store root, matching entry or verdict, or an unsafe path encountered while opening it, returns UNKNOWN/2 with a reason, even alongside a valid result. Transport errors still fail the command. Paths in copied receipt JSON refer to the original checkout or Actions temporary directory; workflow entries omit the raw output those paths name.

The store is evidence for an honest rerun, not a signature: **any job can write it**, alter caches or forge previous results. It has the same trusted-writer assumption as a push to this runner. Receipt and metadata commands add no tokens, credentials or environment dump; trusted code must also keep secrets out of its output. A `verify` PASS proves only that the bundled SHA passed `check` and `test` in the CI VM environment. It says nothing about GitHub check status, branch protection, a different head or merge commit, the full case-fixture gate, or the external reviewer's approval. Both commands print this line under every PASS or FAIL, and none under a refusal, an interrupt or UNKNOWN:

```text
scope: check and test of this SHA in the CI VM only; not a GitHub check status, branch protection or approval by the external reviewer
```

## Known limits

Accepted and not fixed in GRS-57:

- The receipts compare against a hardcoded `origin/dev`, whatever a pull request's base is, so a stacked pull request is compared with `dev`, not its parent branch.
- `run-metadata.json` is evidence about a run, not a check. Since GRS-60 the `summary` step fails the job when a `check` or `test` receipt is missing, belongs to another revision, or is not a PASS.
- Fixed in GRS-139: guest provisioning that failed while the runner was stopped for an upgrade (for example in the `tar` unpack) left the runner service stopped. It now restores the service's entry state itself.
- `wait_guest` runs a second SSH command for `cloud-init status --wait`; if that command fails with an SSH error it is reported as a cloud-init error with exit 255.
- `nft flush ruleset` on pc1 removes the boundary table until the VM restarts, a host reboot has not been tested, and the busy check can race a job that starts just after it.

## Review, 17 October 2026

A read-only review at `origin/dev` `8ab9ef4` of the last 30 CI runs (12 to 15 October). Verdict: CI is already fast. The gap is independence from GitHub, not speed. Step times come from GitHub's whole-second timestamps.

| Median seconds (range) | 6 runs before GRS-60 | 23 runs on GRS-60 code |
| --- | --- | --- |
| Queue wait | 48 (4-105) | 4 (3-75) |
| Job | 116 (60-122) | 57 (54-88) |
| `check` | 10 | 11 |
| `test` | 85 | 28 |
| Checkout, setup-bun, install-chrome, `bun install` | 1.5, 0, 4, 0 | 2, 0, 0, 0 |

- Queue waits over 30 s: 5 of 29. Two were a push run and a PR run of the same SHA, which GRS-60 removed. Two were one run waiting behind another on the single runner (75 s and 42 s). One was the first run after setup.
- No infrastructure failures. "Set up job" took 12 to 16 s on 15 October against 3 to 4 s on other days.
- All 9 failures in the last 200 runs were `bun run --bun test` failures under the pre-GRS-57 workflow.

pc1 headroom, measured 17 October 09:43 SAST after the Tailscale re-login (read-only): AMD Ryzen 7 8700F with 8 cores and 16 threads, load 0.33 over 21 days of uptime. RAM 30 GiB with 19 GiB available, swap unused. 399 GB free on the disk that holds `/var/lib/clearcase-ci`. The guest is `-smp 4 -m 8G` with `MemoryMax=11G`. `plasmalogin.service` and `cups.service` are desktop services, so pc1 is not yet a dedicated host. By the formula `min((threads - 2) / 4, (RAM - 4 GiB) / 9)` there is room for two guests at 4 vCPU and 8 GiB, or three if `memory.peak` confirms 6 GiB is enough. One 8 vCPU guest also fits.

Proposals, ranked by payoff per hour:

1. **GitHub-independent verdict (about 4 h).** `pc1-vm verify REV` runs the job's exact commands in the guest under `receipt` and writes a verdict. A receipt store in the guest, keyed by commit, lets `pc1-vm verdict SHA` answer for any SHA that GitHub or `verify` already ran. No new listener, no credential in the guest. It proves one bundle's SHA passed `check` and `test` in the CI VM. It does not satisfy branch protection or the external reviewer. Ticket: [GRS-139](https://linear.app/vaper/issue/GRS-139/ci-verdict-without-github-pc1-vm-verify-and-verdict-answer-pass-or).
2. **Second guest (about 1 day).** Instance-aware `vm-host.sh` and `pc1-vm`, one guest per runner, to remove the 40 to 75 s queues when merges overlap and to keep CI up when one guest is down. It does not shorten a job. Do it after the verdict ticket. Ticket: [GRS-140](https://linear.app/vaper/issue/GRS-140/second-ci-guest-on-pc1-instance-aware-vm-scripts-and-two-jobs-at-once).
3. **Faster single job (1 to 3 h each, 10 to 20 s of the 57 s).** An 8 vCPU guest, then `check` and `test` as parallel jobs once a second guest exists. Caching is already done. Not ticketed.
4. **Hosted workerd gate in the same job (2 to 4 h).** The guest needs nothing new as root. `workerd` arrives through `bun install`, D1 and R2 run under Miniflare with their persist directory under `/dev/shm`, and no Cloudflare binding or token enters the job. It is an acceptance item of [GRS-138](https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before).
