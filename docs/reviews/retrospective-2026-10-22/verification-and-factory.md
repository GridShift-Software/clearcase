# Verification skills and delivery process retrospective

Reviewed 22 October 2026. Scope: verification skills, feature maps, runners, verification/review guidance, agent-tooling contracts and gate/CI routing. This replaces the failed Opus review for this scope only.

## Revision, method and limits

- Baseline: `225b7e00578319d16383678a8d1ae6efb362a0ba`, branch `audit/retrospective-2026-10-22`; HEAD was checked directly. No checkout, implementation, test, configuration or skill changes were made.
- Incoming proofs: `a3f80d1305294a8c685a87351281eef7928c7d9c` (`origin/wave/proofs-final`, PR #114). Its merge base with baseline is baseline itself.
- Incoming guards: `99cf56bba6afc0bf30d0dc914816ad97d1a750ae` (`origin/wave/guard-followups`). Its merge base with baseline is `e44e12b397561e7d7ad229e8fad00753db9f00bc`. Incoming changes were assessed with the three-dot diff. Differences caused by this branch lacking later dev commits are **not** proposed incoming reversions or fixes.
- Read repository `AGENTS.md`, `GLOSSARY.md`, relevant development/agent-tooling guidance, the verification/review plan, both verification skills and their implementation, feature maps, gate steps, CI and test collection. No parent workspace instruction file exists here, as the brief states. Verification skills were read as audit subjects; no skill workflow was invoked and no agents were spawned.
- Linear connector reads succeeded for GRS-104, GRS-138, GRS-150, GRS-154, GRS-156, GRS-161 and GRS-169. Status observations below are from those reads, not inferred from checked boxes. No external writes or PR monitoring occurred.
- Acceptance, gates, builds, browser driving and Linux behavior suites: **UNRUN**. Parent's doctor attempt reported unsupported OS `msys`, exit 2; the source confirms this is a pre-Python refusal with no receipt (`scripts/agent-tools/_common.sh:6–9`). This report does not substitute static inspection for acceptance or manufacture a receipt.
- One small read-only Node reproduction is described below. It imports the feature parser/index and constructs synthetic Markdown in memory; it neither builds nor drives the app. It is an **unreceipted static reproduction**, not a verification PASS. No case material, private screenshots or secrets were read.
- Source line references below identify the pinned baseline, not later shared-worktree edits. At close, concurrent edits were visible in the two skill documents, the local feature README and verification/review plan. Those edits were not made by this reviewer; they were left untouched and are not reviewed or accepted by this report.

The most useful changes are narrow: make evidence describe the verifier that actually ran, make the published instructions agree, and reuse existing checks at their correct boundary. No additional reviewer tier or broad guard rewrite is justified by this scope.

## Findings

### VF-1 — A local skill's app SHA does not identify all code used to verify it

**Severity:** medium. **Confidence:** high for the source mismatch; no forged runtime PASS was attempted. **Disposition:** baseline documentation/provenance gap, still present in both inspected incoming changes. Related area: GRS-35/GRS-104 verification tooling; GRS-161 addresses inherited Git environment, not this distinction.

**Evidence at baseline:** `.agents/skills/verify-clearcase/SKILL.md:31` says uncommitted edits are not part of the proof, and `docs/agent-tooling.md:126` says only committed code is verified. That accurately describes the isolated application build, but not the entire verification run:

- `lib/main.mjs:139` archives the selected application revision.
- `lib/main.mjs:151–158` instead uses the calling checkout's harness and `SKILL/lib/inner.mjs`. Fixture construction preferentially comes from the archived revision, making the distinction especially easy to miss.
- `lib/inner.mjs:8–19` imports its doctor and drive beside itself and the harness at `cfg.harness`; `lib/features.mjs:83–88` imports owner step modules from the current skill directory.
- `lib/main.mjs:41–72` checks the selected revision, dependencies, tools and ports, but does not reject an initially dirty verifier checkout.
- The receipt wrapper fingerprints the launcher and `lib/*.mjs` (`scripts/agent-tools/agent_tools.py:1433–1438`) and records checkout state. It provides additional provenance; it does not make those files come from the application archive. Owner step modules and harness files also remain outside that explicit input list, although tracked repository state is represented by the receipt revision/diff.

**Trigger and impact:** a developer modifies a step locally while debugging, or invokes `run --rev <older SHA>` from a newer checkout. The application stamp identifies the requested commit while current verifier code supplies the observations. A standalone summary can therefore be accurately about application SHA A without establishing that the tests/harness also came from A. Treating the app stamp alone as an exact-revision proof for a verifier change overstates what ran. This is an ordinary mixed-revision/debugging case, not a claim of malicious receipt forgery.

**Smallest instruction fix, parent to implement:** replace the last two sentences of `SKILL.md:31` with:

> The application's build comes from the selected committed revision. The doctor, drive, owner step modules and harness come from the calling checkout. For acceptance, use a clean checkout of the intended verifier revision and retain its receipt alongside the application's full SHA; a standalone summary or app stamp alone does not establish verifier provenance.

At `docs/agent-tooling.md:126`, replace “Only committed code is verified” with “The application build uses committed HEAD; the verifier runs from the calling checkout, whose state the receipt records.” Preserve the existing requirement to fail when that state changes during the run. If cross-revision verification is retained as acceptance evidence, report **application SHA plus verifier SHA/state**, rather than silently treating them as one identity. A later implementation can stamp those identities in standalone summaries; the instruction correction needs no new acceptance infrastructure.

**Validation to request:** on supported Linux, in disposable synthetic checkouts, compare a clean HEAD run, an older app `--rev` run, and a run with an initially modified owner step. Evidence must explicitly identify the differing verifier state, or refuse it for acceptance. Do not infer this validation from this static review. Incoming GRS-161's `gitEnv()` addition is useful but does not change where these modules are loaded.

### VF-2 — The verification/review plan still directs readers to a superseded human wave-approval gate

**Severity:** medium process defect. **Confidence:** high. **Disposition:** baseline and unchanged by the actual incoming guard diff. Related tickets: GRS-94 delivery model, GRS-159 guidance reconciliation; no new ticket was created.

**Evidence:** `docs/plan/verification-and-review.md:35` starts with Greptile as the external wave reviewer since 20 October, then says the wave is what “he reviews, in his hours” and requires another request for his findings. Line 40 still says nothing merges into dev without “his approval.” In the same file, line 86 correctly says Greptile, CI and no unresolved finding gate dev. Repository `AGENTS.md:44` also correctly limits `dianbrown` approval to release PRs into main. This is a contradiction inside a mixed current/historical section, not merely an old explicitly frozen checklist row.

**Trigger and impact:** a coordinator follows the “Now” column or cost paragraph literally and waits for a person to approve a wave, despite the actual integration rule being satisfied. It recreates the human bottleneck the plan was intended to remove. The opposite interpretation—ignoring all reviews—is also unnecessary: internal ticket review, checkpoint approval, wave review and release approval already have separate purposes.

**Smallest instruction fix:** at line 35, replace the text beginning “One PR from the wave branch into `dev` is what he reviews” through “one re-request” with:

> One wave PR targets `dev`. It merges only when Greptile and CI pass at its exact head and no review finding is unresolved. Findings use the bounded fix/recheck process; the user still owns checkpoint approval and merges into `main`.

At line 40 replace the final two sentences with:

> The wave merges into `dev` under the Greptile, CI and unresolved-findings rule above. Ticket merges into the wave still require their internal verification and review.

Retain the dated checklist and historical wave map as history; do not rewrite an old gate result as acceptance for today's SHA. The short hashes in the dated 20 October reconciliation are historical claims, not proof at baseline. No fresh gate result was available to this reviewer.

**Validation:** read the “Now” column, cost paragraph, line 86 and AGENTS together; they must name the same approver/check boundary. This is a prose correction; another full app gate does not test it.

### VF-3 — Hosted feature-owner instructions require the same lifecycle twice

**Severity:** low process inefficiency. **Confidence:** high. **Disposition:** baseline; remains in incoming. Related ticket: GRS-138, confirmed Done for the local bootstrap slice.

**Evidence:** `.agents/skills/verify-clearcase-hosted/features/README.md:16` tells an owner to run both standalone `verify-clearcase-hosted run` and `gate:hosted` before handoff. The skill itself explains at `SKILL.md:8` that the gate runs the same lifecycle with more checks. `scripts/gate-hosted.mjs:28`, `:59–67`, and `:253–255` use the shared hosted runner with additional checks, including the same Chromium feature drive. This is genuine duplicate build/start/doctor/drive/stop work when both are demanded at the final SHA. The incoming proofs branch adds further evidence checks and probe tests to that gate; it does not remove the overlap.

**Trigger and impact:** every hosted feature owner follows the map literally, building and driving twice on one worktree. This adds browser queue demand and extra artifact churn without an additional acceptance boundary. The absolute cost was not measured here; old 7/10-second timing claims should not be extrapolated to today's larger gate or queue waits.

**Smallest instruction fix:** replace the final sentence of that README line with:

> Run `bun run --bun gate:hosted` at the final SHA before handoff. The standalone skill run is available for focused debugging; a passing gate already includes its lifecycle and feature drive.

Keep the local skill's `self-test`: it proves distinct failure modes. Keep independent review and required reruns after relevant fixes or integration. Do not use this recommendation to reuse evidence from another SHA or to waive the local gate where policy requires it.

**Validation:** inspect the gate's recorded required steps and shared runner call after the next change; the gate must still include the feature map drive. No additional test is needed solely for the wording change.

### VF-4 — The local skill tells users to expect SKIPPED for stale execution evidence, while the wrapper returns FAIL

**Severity:** low documentation defect. **Confidence:** high. **Disposition:** baseline; not corrected in either actual incoming diff.

**Evidence:** `.agents/skills/verify-clearcase/SKILL.md:169` says a commit or edit during `verify app` turns its receipt SKIPPED. `docs/agent-tooling.md:126` and `:202–207` correctly describe FAIL: if the wrapped command succeeded, exit 1; otherwise retain its failure code. These are different from missing-preflight SKIPPED/exit 3.

**Trigger and impact:** a user sees a stale-run FAIL and investigates an apparent runner defect or classifies stale execution as missing prerequisites. In a busy shared checkout, concurrent draft/report writes make this distinction practical. Merely extending a timeout or retrying without quieting the checkout does not fix the cause.

**Exact minimal fix:** replace the second sentence at `SKILL.md:169` with:

> A commit or edit during the run makes the receipt FAIL (exit 1 if the runner otherwise succeeded; otherwise its failure code is retained), so rerun when the checkout is quiet.

Also replace “the `/` redirect before and after activation” at `SKILL.md:98` and the corresponding “the `/` redirect before and after” at `features/README.md:25` with “the case list's Open destination before and after activation.” `lib/drive.mjs:42–45`, `:59`, and `:78–79` already use that distinction correctly; `/` always redirects to `/cases`. These are stale descriptions of corrected behavior, not newly discovered activation defects.

**Validation:** compare the wording to the documented receipt-failure table and existing revision-change controls. No fresh application test is warranted for the text alone.

## Corroborated controls findings; count once in parent synthesis

The separately written [verification controls report](gpt-verification-controls.md) already owns these findings. My independent source trace and static observation support them; they should not become additional defect counts.

1. **Local skill bypasses browser admission (VC-3).** At baseline, `scripts/agent-tools/agent_tools.py:1433–1438` invokes the local runner directly; `lib/main.mjs:158–159` spawns the namespace without an admission wrapper; `lib/inner.mjs:107–113` launches Chromium directly. Checking a lock in doctor is not taking a slot. The hosted implementation resolves admission at `verify-clearcase-hosted/lib/main.mjs:80–83` and actually wraps its drive at `lib/inner.mjs:217–230`. Incoming guards add `gitEnv()` to the local runner, **not** admission. GRS-154 is Done, but its actual reserved scope listed gates, evidence and the hosted verifier; this is a remaining local-skill entry point, not evidence that its listed work was never done. Minimal immediate instruction at local `SKILL.md:16–19`: “On the shared host, invoke the local runner through the workspace browser lock; this runner does not acquire admission itself.” Parent should implement the shared resolver/wrapper fix once, as the controls report recommends, then remove the temporary manual instruction.

2. **Feature parser does not bind prose step references (VC-4).** The local parser's `DRIVE_MARK` (`lib/features.mjs:13`, `:50–51`) checks only for a marker; `featureIndex` (`:101–110`) validates module ownership and unique IDs without checking every referenced ID. Hosted `lib/features.mjs:25–34` does cross-check references. On Node `v22.17.1`, a synthetic well-formed feature with `- **Action.** Step \`does-not-exist\`.` returned `problems: []`. This is a parser-level reproduction, not a runtime acceptance failure. Preserve valid cross-feature references such as `every-view` when implementing the local check; requiring every reference to belong to its containing file would break honest existing navigation descriptions.

3. **Factory behavior regression suites are outside normal gate/CI collection (VC-1).** Root Vitest's explicit includes (`vitest.config.ts:32–46`) do not run Python/shell agent-tool suites. Local gate steps (`scripts/gate.mjs:103–110`) and the CI test command do not compensate. Running the trusted guard on this PR's manifest is useful, but is not running its positive and negative regression suite. Incoming GRS-156/169 adds substantial docs-only/base-merge behavior and `test_docs_only.py`, increasing the importance of an explicit suite route. Avoid running the entire host/plugin-dependent factory suite on every unrelated UI change; require the relevant behavior suites when factory paths change and preserve the controls report's CI regression recommendation.

## Feature-map truth and evidence wording

The read-only index call on baseline reported **33 feature files, 16 drive steps, 9 features with directly assigned steps, and 24 features with no directly assigned step**. These are discovery counts, not test results. A feature without its own step may still have a navigation reference to `every-view`, and may have separate e2e coverage. Therefore “24 untested features” would be an incorrect conclusion.

`every-view` (`lib/drive.mjs:159–172`) proves 42 entries, arrival at each path, a current navigation marker and a nonempty heading. It does not validate every export, save, deletion, reload or calculation. The map is often admirably explicit: `bundles-court-bundle.md:24` says “page and heading only,” and subsequent actions are marked not yet driven; `import-validation.md:32` says diagnostic values are recorded without asserting their counts. Preserve those qualifications.

Minimal common wording to add at local `features/README.md:3`:

> The index validates documentation and step wiring, not application behavior. A run proves only the assertions in the steps it executed. “Not yet driven” actions remain outside this skill's proof; separate-suite coverage counts as acceptance only with that suite's complete evidence at the required SHA.

Until the reference check is implemented, amend the same paragraph's absolute “drives every bullet marked with a step ID” to “runs the discovered steps listed by the index; check that each documented step reference resolves.” After the check lands, restore the stronger wiring statement. Do not solve incomplete skill coverage by duplicating the entire e2e suite into the skill: link each action to its existing proof and add a step only where the user path lacks one.

## Bounded workflow and smallest instruction improvements

The detailed tool documentation is valuable reference material, but not all of it belongs in each worker/reviewer brief. A minimal task route in `docs/agent-tooling.md` immediately after Quick start can remove ambiguity without inventing another approval system:

> The brief names the required checks and exact revision. For factory changes, include the affected Python/shell behavior suites through `receipt`; root `test` and a guard PASS do not run those suites. For a hosted acceptance claim, use `gate:hosted`; a separate standalone hosted skill run is optional when that gate includes the same drive. Record missing prerequisites as UNRUN/SKIPPED, and never convert static inspection to acceptance. On an unsupported host, continue authorized read-only review and return the blocked runtime checks for supported Linux execution.

Add after the review model's line 22:

> A provider/infrastructure failure with no completed report supplies no review verdict. Preserve its task identity and error, use the existing bounded infrastructure-retry policy, and replace only the failed scope. A replacement receives the original brief and any actual findings; it does not restart unaffected reviewers or reset issue/stage budgets. Completion of the replacement is still a review, not a runtime gate.

This is proposed wording for parent review, not a claim that I inspected or changed the external coordinator's policy. It describes the present failed-review trigger without prescribing a new model, weakening freshness, or using a timeout as proof of cancellation.

`docs/plan/verification-and-review.md:11` should also avoid the absolute “checks the agent did not write and cannot alter.” Replace that clause with:

> independently reviewed checks at the declared revision and boundary

The real controls are more specific: base-owned CI guard, exact-SHA receipts for honest reruns, independent review and external wave review. `docs/agent-tooling.md:219–233`, `:595–597`, and `:754–762` explicitly acknowledge unsigned receipts, unauthenticated reviewer identity and the external hook not being installed by this repo. Do not describe a callable local ledger as an authenticated reviewer or an installed push gate.

Keep one written finding list, one bounded fix/recheck path, exact required-check provenance and the same issue/stage identity. A changed SHA invalidates prior acceptance where required, but need not trigger unrelated research, repeat historical cleanup or another whole-model panel. A surviving finding keeps its severity and goes through the documented escalation/user path. Dispatch records (`docs/agent-tooling.md:629–657`) explicitly do not implement a live deadline watchdog; that is a stated limit, not a newly discovered enforcement bypass.

## Incoming work and existing planned boundaries

| Area | What is true at pinned dev | Incoming/planned disposition |
| --- | --- | --- |
| Empty protected-test list for a fix | Approval/manifest protocol disagreement is documented | GRS-156 is In Review; `99cf56bb` adds a review-bound docs-only declaration and approval receipt requirement. Do not propose dummy tests or reopen this as a new defect. Its base-owned rollout limitation is explicitly documented. |
| Base rename/merge handling | Guard has known conservative/incorrect cases | GRS-169 is In Review; incoming compares multiple references and documents reviewed fix-base advances. Adversarial implementation judgment belongs to the controls reviewer. |
| Git environment identity | Local runner still inherits Git environment | GRS-161 is In Review; incoming centralizes `gitEnv()` and adds revision-read controls. Do not file the same inherited-`GIT_DIR` problem anew. |
| Residual semantic guard routes | Documented manual reviewer probes | GRS-150 is Backlog; literal constructors, CommonJS/export routes, dynamic behavior and build-copied assets are already tracked. More prompt text cannot make the parser semantically complete. |
| Hosted production providers | Gate uses explicitly named doubles and real local workerd/Miniflare | GRS-113/115/117/118 and later workflow tickets own replacing boundaries. Local hosted gate PASS would not certify Clerk, Cloudflare services, email, publication or a deployed app. GRS-138's local bootstrap is Done; these remaining boundaries are planned work. |
| Hosting proof freshness/check routing | Baseline lacks the proofs-final additions | `a3f80d13` adds committed evidence checks for deployment/identity/storage/recovery/notifications and runs storage/notifications cases from the hosted gate. It also installs the identity probe's frozen workspace before the root test step and puts real Node before that step in CI. These are incoming improvements, not dev behavior or a reason to claim provider acceptance here. |

## Positives worth retaining

- The isolated local application build, live instance doctor and negative controls address stale-server mistakes directly. The app/harness provenance wording can be fixed without discarding them.
- The hosted gate shares its lifecycle with the skill, validates evidence schemas and cross-file identities, and names unavailable/double/real-local boundaries. This is a strong reason to consolidate duplicate commands, not split the runner again.
- Feature maps mostly distinguish a navigation smoke test from an undriven action and describe stable controls and observable results. The missing reference validation is small and does not require demanding all 42 views' behaviors in one skill.
- Gate/head checks and receipt fingerprints reject ordinary mid-run changes; cleanup is scoped to run-owned resources. Historical evidence is generally dated and should remain historical.
- `docs/agent-tooling.md` candidly documents the receipt, ledger, hook, guard and deadline limits. The shorter verification model should reuse those accurate claims instead of replacing them with universal assurances.

## Top priorities for parent synthesis

1. Address the local browser-admission and feature-reference gaps once, under VC-3/VC-4; require the factory regression route under VC-1.
2. Correct mixed app/verifier revision claims (VF-1), keeping app SHA and verifier identity explicit.
3. Remove the contradictory human dev-wave approval sentences (VF-2).
4. Remove the redundant hosted lifecycle requirement and stale FAIL/activation wording (VF-3/VF-4). Add the short check-routing and failed-review handoff guidance; retain bounded review and explicit runtime limits.

Report: `docs/reviews/retrospective-2026-10-22/verification-and-factory.md`. Runtime acceptance remains UNRUN at all three named revisions in this review.
