# ClearCase V1 and V2 scope

Planning baseline, 8 October 2026. Build a local case workspace that faithfully reproduces the supplied v5 sample, then add hosted client intake and controlled publication. Processing remains manual initially. The [delivery plan](delivery-plan.md) and [Linear project](https://linear.app/vaper/project/clearcase-realignment-e64366f52809) turn this scope into dependency-linked work and independent gates. Application implementation has not started.

## Agreed direction

- V1 runs fully locally. A local development server is acceptable. Improve the layout and usability while preserving the sample's useful functions.
- The first acceptance baseline is `RAWS/CASE_Lawyer_Pack_v5-002.zip`, specifically its main `ESS_DCS_Workspace.html`, with 1,689 indexed documents. Then test the newer 2,131-document export as a separate compatibility fixture.
- V2 runs on Cloudflare, with a separate client instance and admin/client roles. An operator checks results privately and signs off before clients can access them.
- Keep the manual intake, processing and results-import boundaries suitable for later Pi Durable automation.
- Work on `dev` through per-ticket `feature/*` worktrees and pull requests. Preserve the original archives and production system.

## What matching the sample means

V1 must reproduce the supplied case data, relationships, calculations and user workflows. It need not reproduce the old styling, implementation or known bugs. Record every intentional behavioral difference with its reason and an acceptance example.

There are two distinct tests. First, the supplied results must render correctly and link to the right originals. Second, a manually prepared replacement package must pass validation and update the workspace. Recreating identical analysis from raw documents is a later processing task: the complete original processing scripts are unavailable, and the prompts alone do not establish a reproducible pipeline.

The v5 main HTML declares a build date of 12 August 2026 and contains 42 navigation entries. Its bundled manual and START HERE file contain older counts, so the main HTML takes precedence. The September export is structurally different and must not silently replace the v5 baseline.

## V1 user experience

An operator starts the local app, selects a case folder and imports its processed results. The app reports record counts, missing originals, unresolved references and unsupported fields before activation. The operator previews the case and activates the selected version. The previous version and locally entered work remain recoverable.

The workspace supports browsing, searching, opening originals, following citations, reviewing analysis, maintaining registers and exporting work. Source documents remain outside the source-code repository. Once dependencies are installed, normal use needs no internet connection, account or external service.

### Feature coverage

All 42 v5 navigation entries are in the V1 parity scope. These groups come from the main HTML rather than the older manual.

| Group | Views |
| --- | --- |
| Matter | Overview; Matter & Strategy; Timeline; Chronology; Quantum & Interest |
| Evidence | Documents; Contracts; Filings & Affidavits; Advanced Search; People; Entities; Document Diff |
| Case management | Invoice Ledger; Disbursements; Timesheet; Deadlines; Discovery Schedule; Court Bundle; CaseLines |
| Analysis | Contradiction Tracker; Risk Matrix; Defence & Rebuttal; Info Required; Witnesses; Conflict Check |
| Litigation strategy | Enforcement Roadmap; Legality & SIU Risk; Prescription; Interest Recalculator; Payments & Net Claim; Cause of Action; Authorities; Heads of Argument; Cross-Exam Prep; Settlement / BATNA |
| Registers | Privilege Log; POPIA Register; Annotations; Transcripts |
| System | Rescan & Update; Backup / Restore; Manual |

Each view needs a behavior checklist before implementation. A working navigation item alone is insufficient. Preserve the actual sample's export and bundle capabilities; additional PDF assembly features require a separate scope decision. Local rescan discovers changed files and marks processing as pending. It must not imply that OCR or case analysis has been rerun.

### V1 acceptance gates

| Gate | Required evidence |
| --- | --- |
| Data parity | Exactly 1,689 base chronology records, with matching references, metadata and analysis values. Compare derived values against fixed inputs and dates. Account explicitly for differences. |
| Source integrity | Check every indexed path and citation. Every available original opens or downloads correctly; missing or unsupported files have an explicit state. Preserve attachment-parent relationships where supplied. |
| Functional coverage | Exercise every one of the 42 views and its meaningful actions. Verify search/filter results, citation navigation, editable fields and exports against recorded examples. |
| Local operation | Disable external networking after setup. Browsing, originals, search, editing, restart and backup/restore still work. Bind the local server to loopback. |
| Durable user work | Restart preserves notes and registers. Export and restore reproduce them. Activating new results does not silently overwrite them. |
| Safe replacement | Invalid packages leave the active version untouched. Duplicate refs, ambiguous file matches and broken citation targets produce actionable diagnostics. Existing source defects stay visible in the parity report. |
| Usability and speed | Keyboard navigation, visible focus, readable tables and working browser Back. Proposed targets on the recorded development machine: usable overview within 2 seconds of a cold local load, warm navigation within 200 ms and search within 300 ms, measured on a production build. Document loading is measured separately. |
| Newer export | After v5 passes, load all 2,131 newer records through an explicit format adapter. Preserve extra datasets and report any view support still missing. Do not silently drop data. |

Performance figures are proposed acceptance budgets, not measured results. Search must disclose the text it actually has. The newer export caps document text at 4,000 characters; a frontend cannot restore the omitted text.

V1 excludes cloud deployment, authentication, client intake, notifications, billing integration, automated OCR, automatic analysis and Pi Durable execution. A full Markdown editing application is also outside the first parity milestone.

## Proposed implementation and handoff format

Use SvelteKit and TypeScript, with a local Node server initially. SvelteKit provides documented [Node](https://svelte.dev/docs/kit/adapter-node) and [Cloudflare](https://svelte.dev/docs/kit/adapter-cloudflare) deployment adapters. This is a reuse choice, not a claim that the framework alone fixes performance. Keep case rendering and validation independent of filesystem or cloud storage access.

Define a versioned results package containing a manifest, structured datasets and references to original files or generated attachments. The manifest identifies the case, input revision and results version. Validate reference uniqueness, file mappings and supported data shapes at import. Preserve legacy refs within each fixture; never assume the same ref identifies the same document across independently rebuilt packs.

Keep imported results separate from user-entered notes and registers. Preview and activation use the same validated package that V2 will later publish. Store original paths and content fingerprints so a replacement cannot silently attach analysis to the wrong file. The exact serialization and validation rules belong in the next technical design.

[Knap](https://knap.md/) turns data and templates into Markdown. Use it, if useful, to generate analysis templates or reports from known case metadata. An operator edits the Markdown, then a separate parser validates its fields and citations and produces structured results. Knap does not supply that reverse conversion. Machine-generated document indexes and extracted text should remain structured data rather than hand-edited Markdown tables.

## V2 client workflow

1. A client uploads files into a case submission. Finalizing the submission records the exact input revision and notifies the operator.
2. The operator downloads that revision and processes it manually.
3. The operator imports a results package into the case's admin area. It is private and cannot replace published results yet.
4. Validation reports errors and warnings. The operator previews the same viewer the client will use, checks completeness and resolves blocking errors.
5. An admin signs off that specific results version. Publication changes the client's active version atomically and records who approved it and when.
6. Later revisions repeat the process. A failed import or rejected preview leaves the previous publication available. Editing results after approval requires a fresh review and sign-off.

Clients must be unable to retrieve draft results or their attachments through direct URLs or APIs. Preview is an access-controlled state, not just a hidden menu. Background automation may prepare packages later; it must not bypass human publication approval.

Each client gets an isolated deployment and data boundary. Start with admin/client roles and avoid a shared multi-tenant control plane in V2's first release. A dedicated container is an infrastructure option, not part of the user-facing requirement. Cloudflare Containers have a managed start/stop lifecycle, so durable case storage must be designed independently of a running process. See [Cloudflare's lifecycle documentation](https://developers.cloudflare.com/containers/concepts/architecture/). Select the hosting layout after measuring the local workload.

## Delivery sequence and remaining unknowns

1. Establish the v5 fixture inventory, package contract and per-view acceptance examples. Pass the independent reference gate. Capture known defects separately.
2. Implement one complete path: import, validation, overview, chronology, document opening and citations. Pass its independent pilot gate before feature fan-out.
3. Complete the remaining v5 workflows, persistence and backups, then pass the independent v5 release gate.
4. Add the newer export adapter and a narrow Markdown authoring round trip. Pass the compatibility gate without weakening v5 acceptance.
5. Resolve hosted roles, isolation and storage, then pass the hosted design gate. Add V2 intake, private review, sign-off and publication and pass staging acceptance. Pi Durable processing remains parked until the manual path works.

The current operator results-upload endpoint and accepted payload remain unknown. The firm-admin session exposes client operations; earlier `/admin` navigation redirected to `/cases`. The inspected public chunks expose client uploads, not results import. The recent ClearCase email contains no operator URL. See [the evidence note](evidence.md). Operator-level access or application source is needed to confirm the existing contract, but this does not block the local viewer.

Before V2 implementation, settle whether “client” means a firm or an individual, whether clients may edit shared registers, and whether the publisher may be the same admin who prepared the results. These choices do not block V1. Quote/payment handling, Outlook integration and other production-only features are not automatically included in the v5 parity scope.
