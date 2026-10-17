# Chart the route from the ClearCase POC to hosted alpha

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha) is the execution authority.

## Destination

A user-approved, agent-navigable plan for ClearCase 0.1 alpha: convert the client-alignment POC into an intuitive hosted case application, initially for one or two clients with a separate instance and subdomain each. Align scope, stack, UX, ADRs, Linear milestones, delivery dependencies and acceptance gates before implementation starts.

## Notes

This is the canonical planning map and retains the existing realignment gate. No V2 implementation begins until this issue is Done. Done requires the user's approval of the written scope, architecture, milestones and ordered implementation tickets, with blocked issues reconciled.

Use grill-with-docs, grilling and domain-modeling for decision sessions; wayfinder for map maintenance. Resolve at most one decision ticket per session. Claim a child by assigning it to the person driving the decision before work. Query open, unassigned children whose native blockers are closed for the frontier. Use only wayfinder labels on map and decision children. Record answers in resolution comments and index closed children here. Keep implementation tickets separate.

User direction is recorded in this issue's interview comments, dated 14 October. Retain production capabilities, conduct a software and dependency audit, improve information grouping and in-app viewing, and implement manual queue/download/processing/upload/private-preview/approval/publication first. Checks and review throughout, plus final gates. Fable and swarm are requested for later execution; reconcile the older operating rules before dispatch.

Original case archives and production are read-only. Real case data, extracted text, private screenshots and credentials stay out of Git and external agent/test services. No production changes, deployment or main merge is authorized by this planning map.

Existing POC acceptance and unfinished demo/compatibility work are inputs, not assumed hosted acceptance. Older Cloudflare, local-product and automation assumptions are subject to decisions here.

## Decisions so far

* [Define client instances, membership and case permissions](<https://linear.app/vaper/issue/GRS-85/define-client-instances-membership-and-case-permissions>): isolated client instances, Clerk authentication, assigned viewer/editor case access, and distinct Global Admin, firm-admin and audited operator authority. The resolution comment holds the full decision.
* [Define the manual processing queue and results handoff](<https://linear.app/vaper/issue/GRS-87/define-the-manual-processing-queue-and-results-handoff>): mostly FIFO claimed jobs, corrected submissions rejoin last, and one candidate-import contract for manual processing and later automation. SLA measurement is deferred to release evidence.
* [Assess D1 and R2 performance and overhead for the alpha workload](<https://linear.app/vaper/issue/GRS-95/assess-d1-and-r2-performance-and-overhead-for-the-alpha-workload>): D1/R2 remains a reasonable candidate; local CPU evidence does not prove hosted performance. The ticket links the corrected research and required hosted probes.
* [Define private preview, approval and client publication](<https://linear.app/vaper/issue/GRS-88/define-private-preview-approval-and-client-publication>): editable, audited candidates require exact-version sign-off; alpha permits preparer approval, recovery preserves user work, and later processing flags correction conflicts. Review topology awaits the design gate.
* [Define an intuitive case workspace and information hierarchy](<https://linear.app/vaper/issue/GRS-89/define-an-intuitive-case-workspace-and-information-hierarchy>): retain the current app navigation as the planning baseline; the user and UX lead will explore later designs in Figma. The prototypes remain research, and the resolution retains the settled Notes and mobile requirements.
* [Assess browser viewers and manual previews for alpha file types](<https://linear.app/vaper/issue/GRS-96/assess-browser-viewers-and-manual-previews-for-alpha-file-types>): manual derived previews make the minimum families and conditional media/ZIP browsing feasible in principle; rendition fidelity and fail-closed range integrity still require proof. The ticket links the corrected research.
* [Define in-app file viewing and original integrity](<https://linear.app/vaper/issue/GRS-90/define-in-app-file-viewing-and-original-integrity>): every accepted file is viewable in-app, original/processed references remain traceable, failed previews hold publication, and complete exports include originals and published previews. A dedicated component evaluation and integrated viewer gate are planned.
* [Assess Outlook drafts and user-controlled case-email import](<https://linear.app/vaper/issue/GRS-98/assess-outlook-drafts-and-user-controlled-case-email-import>): Graph drafts and selected-message import are feasible candidates with mailbox-wide consent and durable-copy constraints; the research informs the later live-integration pass, with synthetic proofs still unrun.
* [Define alpha behavior for every production integration](<https://linear.app/vaper/issue/GRS-91/define-alpha-behavior-for-every-production-integration>): provider-neutral email files and app-side drafts in alpha, manual KYC and existing case costs, scoped audit access, explicit privilege handling and protected bundle history. Live mailbox connections are later; the ticket resolution holds the full decision.
* [Reconcile POC, demo and newer-export work with the hosted plan](<https://linear.app/vaper/issue/GRS-92/reconcile-poc-demo-and-newer-export-work-with-the-hosted-plan>): preserve reviewed work and v5 contracts, support newer/JSON exports, hold unsupported required sections, and use controlled E2E preservation tests; no live-client migration is needed. Standalone Markdown authoring is later.
* [Audit hosted software choices and Clerk–Workers integration](<https://linear.app/vaper/issue/GRS-100/audit-hosted-software-choices-and-clerk-workers-integration>): dated dependency/advisory inventory, Clerk integration and residency constraints, local Workers testing and Void comparison are published. Adoption and all runtime proofs remain with the stack decision.
* [Assess a local agent test platform on PC1 and PC2](<https://linear.app/vaper/issue/GRS-101/assess-a-local-agent-test-platform-on-pc1-and-pc2>): local Workers tooling and both PCs’ read-only capacity are assessed; PC2 is the recommended first pool candidate, while the delivery decision holds roles, isolation proofs and measured concurrency. No platform is installed.
* [Assess cf and Void for the alpha agent tooling jobs](<https://linear.app/vaper/issue/GRS-102/assess-cf-and-void-for-the-alpha-agent-tooling-jobs>): released source supports a Void/Kit 3 prebuilt route and cf resource/automation jobs; native D1, credential separation and same-account client boundaries have explicit unrun proofs. Research is published, without tool adoption or cloud execution.
* [Choose the hosted stack and software audit criteria](<https://linear.app/vaper/issue/GRS-86/choose-the-hosted-stack-and-software-audit-criteria>): SvelteKit 3/Workers with Bun app builds and supported Node tooling; D1/R2, separate client/staff Clerk apps and invite-only access; MFA initially off. Void/cf are preferred proof candidates with Wrangler fallback. The resolution holds the accepted constraints and required proofs.
* [Research Cloudflare-first transactional alpha notifications](<https://linear.app/vaper/issue/GRS-103/research-cloudflare-first-transactional-alpha-notifications>): native email is a feasible candidate with separate free/Paid recipient paths, delivery/retry constraints and unrun proofs. Research is published; provider and notification-failure choices remain with acceptance planning.
* [Define alpha acceptance, rollout and recovery](<https://linear.app/vaper/issue/GRS-93/define-alpha-acceptance-rollout-and-recovery>): accepted outcome/evidence checklist, practical rollout guidance, soft recovery timing, data-recovery/deletion policy, initial notifications and user-owned release/incident/spend decisions. Later SLA/reliability refinement stays explicit; hosted proofs remain unrun.
* [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>): early hosted PDF workflow before broad migration, explicit pending-preview and supplement rules, usable unpublished cases, and prompt optimization after stabilization.

## Not yet specified

No additional unticketed planning questions are currently identified. Surface any further questions as the remaining delivery operating plan is worked.

## Out of scope

Executing the hosted build in this charting session; maintaining a separately shipped local product as an alpha requirement. Automated processing is later work, after the manual workflow is proven. Main merges and deployment remain under the user's control.

[Plan live Outlook and Gmail integrations after alpha](<https://linear.app/vaper/issue/GRS-99/plan-live-outlook-and-gmail-integrations-after-alpha>) preserves the explicitly deferred live mailbox connections, provider-side draft creation and syncing. Alpha handles exported provider-neutral email files; this later work does not block alpha.

[Round-trip one manually authored analysis through Markdown](<https://linear.app/vaper/issue/GRS-23/round-trip-one-manually-authored-analysis-through-markdown>) is preserved in M7 after alpha. Validated package upload and editable private preview cover alpha; Markdown no longer blocks hosted delivery. There are no current live clients requiring production migration or cutover; controlled preservation/recovery E2E remains in scope.
