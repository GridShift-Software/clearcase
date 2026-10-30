# Final guidance-change review

22 October 2026. Review-only assignment against the eight tracked documentation/skill changes on `audit/retrospective-2026-10-22`, with HEAD `225b7e00578319d16383678a8d1ae6efb362a0ba`. Final source readback: 09:04:46 UTC. These changes are uncommitted; this is a review of their working-tree content, not acceptance of a new commit.

The changes correctly describe the principal evidence boundaries and retain the required gates. Three residual wording findings remain: one medium and two low. They are incomplete reconciliation of existing guidance, not newly introduced executable defects. The parent corrected the obsolete human wave-review sentence during this review; final readback confirms that correction.

## Standards

No additional hard standards violation found in the eight-file diff. The changes preserve exact-revision reporting, synthetic verification, required final gates, independent review and user-only merges into `main`. No executable behavior, gate exemption or permission to deploy is introduced. The route-tree warning correctly leaves exact reservations and their synchronized snapshot to the coordinator.

## Specification findings

### GC-1 — Closed during review: obsolete human wave-review wording

`docs/plan/verification-and-review.md:48` now requires Greptile and CI at the exact head with no unresolved finding, retains the bounded internal fix/recheck and leak scan, and reserves checkpoint approval and `main` merges to the user. It agrees with line 53, section 4b and `AGENTS.md`. The parent fixed the remaining VF-2 sentence before final readback. No outstanding finding and no app gate needed for this text correction.

### GC-2 — Medium: the linked current operating plan contradicts the restored provider exception

**Locations:** revised `docs/plan/verification-and-review.md:70–80`; its linked `docs/plan/agent-delivery-operating-plan.md:3–10,93`.

The revised disposition permits explicitly authorized Clerk-development proof legs while Cloudflare remains pinned. The operating plan declares its opening sections current at line 5, but line 10 still puts **any** credentialed or real-provider leg on HOLD, line 93 says real Clerk evidence comes only after Cloudflare is unpinned, and line 3 says every real-provider check is UNRUN. This is an active instruction conflict, not just a frozen checklist. The new product brief sends workers to the current provider decision, while the document advertised as the full procedure sends them back to the superseded blanket restriction.

The exception matches the dated GRS-26 comment readback in `product-and-delivery.md:124`; the incoming proof's `docs/acceptance/hosting/identity.md:3–5` also distinguishes its recorded local/Clerk-development result from the remaining HOLDs and production integration. I did not independently fetch those Linear comments.

**Minimal correction:** in the operating plan, date the old blanket status explicitly and replace its operative provider restrictions with a pointer to section 4a of the verification/review plan and subsequent live GRS-26 decisions. Preserve the Cloudflare pin, secret-path requirement and release HOLD. Also clarify the similar blanket sentence in `docs/plan/hosted-alpha-acceptance.md:77` as the 17 October state superseded by that disposition; that file is already marked as a dated baseline, so it is supporting cleanup rather than an additional finding. This needs no expanded authorization or executable change.

### GC-3 — Low: the verification model still overstates protection from verifier edits

**Location:** `docs/plan/verification-and-review.md:9`.

“Checks the agent did not write and cannot alter” is an absolute claim inconsistent with the newly accurate calling-checkout verifier description. `docs/agent-tooling.md:231–233` explicitly limits receipts to honest reruns and records the possibility of changes between observations; lines 591–597 distinguish the local ledger from authenticated reviewer identity and an installed external hook. Independent review is a requirement, not evidence that verifier files are technically immutable.

**Minimal correction:** replace that clause with “independently reviewed checks at the declared revision and service boundary.” Keep acceptance criteria and saved evidence in the sentence. This is the existing verification/factory report's proposed correction; do not count it again as a new security vulnerability.

### GC-4 — Low: the local feature map still claims every canary hit fails

**Location:** `.agents/skills/verify-clearcase/features/README.md:27`.

“Any egress attempt (canary hit, request to another origin) fails the run” conflicts with `SKILL.md:95,173` and `lib/inner.mjs:162–169`. The implementation filters `isBackground` hits, permits the documented browser-background category, and records it under `backgroundHits`; other canary hits or disallowed browser requests fail. A reader of the feature map can wrongly report that a passing run had zero attempted background connections.

**Minimal correction:** “Any non-background canary hit or disallowed browser request fails the run. Chrome background-service hits are recorded under `backgroundHits` using the rule described in the skill.” Keep the namespace's no-outbound-network requirement unchanged. This corrects a description of the existing exception; it must not broaden it.

## Checks against source and incoming work

- App/verifier provenance matches local `lib/main.mjs:137–159` and `lib/inner.mjs`: the selected application is archived, while the runner imports the calling checkout's harness/drive. The changed wording does not claim that a build stamp identifies those verifier inputs.
- Activation wording matches `lib/drive.mjs:42–45,59,78–79`: `/` goes to `/cases`; the case-list destination and resulting active version distinguish the states. Receipt FAIL/exit behavior matches `scripts/agent-tools/agent_tools.py:691–709`.
- Navigation coverage and the missing prose-Step binding match the local drive/parser. The local browser-admission warning matches its direct namespace/browser launch. The guard incoming SHA changes the local runner's Git environment, not that admission gap.
- `scripts/gate-hosted.mjs:59–67,232–255` requires the shared lifecycle and drive, so removing a mandatory duplicate standalone run preserves acceptance coverage. Incoming proofs add checks of recorded probe evidence and probe tests; those do not establish fresh provider execution at the current application SHA.
- The control-suite gap remains visible in the CI/gate entry points. GitHub documents default PR activity as opened/synchronize/reopened, supporting the label-trigger warning in the updated guidance. Its rerun documentation preserves the original SHA/ref; it does not establish refreshed label input. The conservative “not proof” wording is appropriate. Sources: [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request), [GitHub reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
- `deploy/client/hosted-files.json:2` selects `deploy/client/routes`; the warning about `src/routes` is accurate. PD-1 through PD-3 still require coordinator/implementation work; these prose changes do not close them.

The two new report links resolve to present files, but their target directory is still untracked. `scripts/check-links.mjs:73–84` requires tracked targets. Include the linked reports in the eventual delivered change; shipping only the eight tracked modifications would leave broken clean-clone links. This is a packaging condition while the parent is still synthesizing, not a separate defect finding. The link checker was not run.

## Scope and limits

Read repository `AGENTS.md`, glossary, relevant development/tooling documentation, the three named prior reports and the affected code. `C:/Users/dianb/AGENTS.md` is absent. Used the `code-review` skill's standards/specification distinction; did not delegate because this assignment explicitly forbids agents. No verification skill was executed.

Doctor through Git Bash returned exit 1 with: `agent-tools: unsupported OS 'msys'. Supported: Linux (Arch, CachyOS) with bash >= 4.4. See docs/agent-tooling.md.` No doctor receipt was produced. Builds, gates, suites, browser drives and runtime acceptance are **UNRUN**. No runtime PASS is claimed at any SHA.

Inspected incoming `a3f80d1305294a8c685a87351281eef7928c7d9c` and `99cf56bba6afc0bf30d0dc914816ad97d1a750ae` with Git objects only. No checkout, fetch, merge, commit, push, external mutation, case material or secret access. Linear status/authorization assertions were checked against the supplied dated specialist report, not a fresh live capture. This review validates the guidance change; it does not independently repeat the ten specialists' full-codebase audits or authenticate historical evidence.

Working-tree blob identities at final readback, in diff-file order: hosted skill `a7dff1e671b988c1f608365b67751f6b03744cdb`; hosted map `7023a007b7b2b3997b89bd3bcbc2deae5aedc924`; local skill `402000c9d03a3d2c99764248ef64b4ae3780fded`; local map `453e8a8c076ae792a89649a9781b5d8eb295ccb0`; AGENTS `ad589c7b45e52e3faa3c2fcb9ff5cc9f34d25607`; tooling `a483d6516d8d398fc4b1ecc12680acf9747ce4c4`; verification plan `413ffd88f7c58e645fc234cf9cabff90011ca60b`; product brief `9494b27b02cf63cd38195554b64f1ee931176033`.

Only this report was written. Standards: zero additional findings. Specification: one medium and two low residual guidance findings; GC-1 closed on final readback.
