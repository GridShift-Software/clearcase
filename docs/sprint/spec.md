# Spec: the ClearCase client experience, hosted on Cloudflare, for the 5 November demo

Status: ready-for-agent. Written 28 October 2026 from the post-mortem, the grilling session with the owner and nine research lanes (`docs/sprint/research/`). The plan and process are in `README.md`; the target architecture is in `architecture.md`. Domain words follow `GLOSSARY.md`.

## Problem Statement

A law firm's lawyers need to read a processed case: see what happened and when, see what the analysis surfaced, and open the original document behind any statement within seconds, because legal arguments rest on the source. The local release candidate does this well. All 42 views open in 60–300 ms, and a 258 MB PDF opens in 1.9 s. But it runs on one machine with no sign-in.

The hosted version on Cloudflare, built to serve each client from its own instance, fails the lawyer:
- sign-in takes 11–24 s, every page 1.2–3.6 s, and any PDF 4.5–7 s, even a tiny one;
- search returns an error;
- clients see none of the case views, because only the chronology could ever be published and nothing has been;
- the real v5 case cannot be published at all;
- 613 originals over 16 MiB were never uploaded;
- it looks nothing like the design the partners approved.

On Thursday 5 November the owner demos ClearCase to a law firm that is about to hand over 14–17 TB of matter data. The demo must run on the hosted product. Colleagues need a shared environment to test it, and three developers' agents need to build it in parallel without being micromanaged.

## Solution

A lawyer signs in once and stays signed in for the working day. They land on the case overview and move through the same views the local release candidate offers, in the partners' visual design: a dark numbered sidebar, a top bar with search and a "published version" pill, and cards. The chronology shows the timeline with the backing document open beside it. Any original, including a 258 MB court bundle, shows its first page in under 3 seconds. Lawyers can search, read the analysis views, keep notes and deadlines, and build court bundles.

Behind the scenes, the operator's machine turns a processed case into immutable, per-version view files and uploads them, together with the originals, straight to the client's storage. A human approves that exact version before clients see it. The hosted app checks the user's access once per request and serves those files from Cloudflare's edge.

Every change ships first to a preview URL of its own, then to a shared staging environment that colleagues use daily. A timed journey from South Africa is the release gate.

## User Stories

### Client lawyer: access
1. As a client lawyer, I want to sign in with my email and a code in under 5 seconds, so that I can start work immediately.
2. As a client lawyer, I want my session to last the working day, including long PDF reading and idle periods, so that I am never thrown out mid-task.
3. As a client lawyer, I want to see only my firm's cases, so that other clients' matters are never visible to me.
4. As a client lawyer, I want to see only cases I have been granted, so that matter-level confidentiality holds inside my firm.
5. As a client lawyer, I want signing out to end my access within about a minute on every device, so that a shared machine is safe.
6. As a client lawyer, I want my name, not an internal identifier, shown in the header, so that I know which account I am using.

### Client lawyer: navigation and shell
7. As a client lawyer, I want a case list that opens the case I choose, so that I can switch matters.
8. As a client lawyer, I want a persistent sidebar listing every view, grouped as in the partners' design, so that I can move anywhere in one click.
9. As a client lawyer, I want views that are not yet available to show a clear "coming soon" panel, so that I am not confused by errors.
10. As a client lawyer, I want a top-bar search I can reach with Ctrl+K, so that I can find a document from anywhere.
11. As a client lawyer, I want a pill that shows which published version I am reading, when it was published and how many documents it holds, so that I trust what I see is current.
12. As a client lawyer, I want every page to appear in under 2 seconds from South Africa, so that the tool keeps up with my thinking.
13. As a client lawyer, I want the browser's Back and Forward buttons, deep links and bookmarks to work on every view, so that I can share and return to exact places.
14. As a client lawyer on a phone, I want the layout to fit a 390 px screen with the navigation in a drawer, so that I can check a fact away from my desk.
15. As a keyboard user, I want visible focus and keyboard access to every control, so that I can work without a mouse.

### Client lawyer: reading the case
16. As a client lawyer, I want an overview with the headline counts (documents, contradictions, deadlines, amount claimed), narrative and quick links, so that I can orient myself in a matter.
17. As a client lawyer, I want overview tiles that link to the view behind each number, so that I can drill in.
18. As a client lawyer, I want the chronology of every dated document with filters by bundle, type, year and text status, so that I can reconstruct events.
19. As a client lawyer, I want clicking a chronology entry to open its document beside the list, so that I can read the source without losing my place.
20. As a client lawyer, I want every citation anywhere in the app to open its backing document in one click, so that each statement can be verified.
21. As a client lawyer, I want a documents list with paging and filters, so that I can browse the whole matter.
22. As a client lawyer, I want a document page with its metadata, excerpt, attachments, related documents and the link to its original, so that I understand a document before opening it.
23. As a client lawyer, I want the original PDF to show its first page in under 3 seconds, whatever its size, so that checking a source never interrupts an argument.
24. As a client lawyer, I want to jump to a cited page in a PDF, so that I land on the exact passage.
25. As a client lawyer, I want e-mails and other non-PDF originals to open or download clearly, with a note when an attachment is only inside its parent message, so that nothing looks broken.
26. As a client lawyer, I want a clear "original not supplied" message where the source file is missing, so that I know it is a gap in the evidence, not a fault.
27. As a client lawyer, I want to search by reference, file name, subject or sender and get results in under 2 seconds, so that I can find a document I remember.

### Client lawyer: analysis views
28. As a client lawyer, I want Matter & Strategy, Timeline, Contradiction Tracker, Risk Matrix, Defence & Rebuttal, Witnesses, People, Entities and Conflict Check to show the analysis the processing surfaced, so that I can prepare the matter.
29. As a client lawyer, I want the litigation views (cause of action, legality, authorities, heads of argument, cross-examination preparation, enforcement roadmap, filings and contracts) to show their content, so that I can build the case.
30. As a client lawyer, I want the quantum views (quantum and interest, invoice ledger, prescription, interest recalculator, payments and net claim, settlement) to show their figures with their sources, so that I can argue the money.
31. As a client lawyer, I want every figure and finding in those views to cite its documents, so that I can check them.
32. As a client lawyer, I want to export the tables I see to CSV, so that I can use them in my own documents.

### Client lawyer: own work
33. As a client lawyer, I want to add a note to a document, and see it again after a reload and in the case's notes list, so that my thinking is kept with the evidence.
34. As a client lawyer, I want to add, edit and delete deadlines, see their countdowns and download them as a calendar file, so that I do not miss a date.
35. As a client lawyer, I want the registers (timesheet, disbursements, privilege, POPIA, annotations, transcripts) to keep my entries, so that the case file lives in one place.
36. As a client lawyer, I want to add my own authorities, heads of argument, cross-examination questions, payments and enforcement statuses beside the processed content, so that I can extend the analysis.
37. As a client lawyer, I want to build a court bundle from chosen documents and download it as a PDF, and still find it after a reload, so that I can file it.
38. As a client lawyer, I want the discovery schedule and CaseLines index with links to the originals, so that bundle work matches the court's structure.
39. As a client lawyer, I want my saves to finish in under 2 seconds and never silently overwrite a colleague's change, so that collaborative work is safe.
40. As a client lawyer, I want to upload a small number of extra documents and have the team notified, so that new evidence gets into the next version.

### Operator (the owner's team)
41. As an operator, I want to turn a processed results package and its case folder into a version's view files on my own machine, so that the hosted app does no heavy work.
42. As an operator, I want to upload the originals and view files straight to the client's storage from my machine or the NAS, so that terabytes never pass through the web app.
43. As an operator, I want a re-run of an upload to skip files that are already stored, so that an interrupted transfer resumes cheaply.
44. As an operator, I want the import to refuse a version built from a partial set of originals, so that clients never see hundreds of "missing" files by accident.
45. As an operator, I want to register a built version as a candidate, preview it as staff, and see its warnings (missing originals, failed previews, count disagreements) before anyone approves it, so that problems are found before clients see them.
46. As a publisher, I want to approve one exact version, bound to its view files' manifest, with reasons for any acknowledged warning, so that what clients read is exactly what was approved.
47. As a publisher, I want publication to switch clients to the new version at once and keep the previous one for rollback, so that an update is safe.
48. As an operator, I want each client to have its own instance, storage, database and sign-in on its own subdomain, so that one client's data can never reach another.
49. As an operator, I want to grant and revoke a lawyer's access to a case, so that the firm's staffing changes are reflected.
50. As an operator, I want to receive clients' small uploads in storage with a notification, so that I can fold them into processing.

### Colleague tester and developer
51. As a colleague, I want one staging URL behind a company sign-in, with the v5 case published, so that I can test and demo the product daily.
52. As a developer, I want every ticket branch to get its own preview URL with the staging data, so that I can show and check my change before merging.
53. As a developer, I want my agent to take a ticket from Linear, build it, check it, open a pull request, get one review and merge, in under 2 hours for a half-day ticket, so that three of us ship in parallel.
54. As a developer, I want each ticket to say exactly which files I may edit, which tests to run and which journey proves it, so that agents do not collide or guess.
55. As a developer, I want the pull request checks into the sprint branch to finish in under 5 minutes, so that merging is never the bottleneck.
56. As a developer, I want staging to redeploy itself on every merge, and the timed journeys to report on each deploy, so that a regression is seen within the hour.
57. As the owner, I want a daily digest and a "needs a human" view in Linear, so that I can steer without micromanaging.
58. As the owner, I want `dev` and `main` untouched until one reviewed sprint-to-dev pull request, so that the speed run never leaks shortcuts into the clean branches.

## Implementation Decisions

**Shape of the product**
- The hosted client reuses the local release candidate's view pages and components unchanged. Only their data loaders are new. Research found the pages import no server code. The local app keeps working throughout.
- Hosted routes live under a per-case, per-version prefix: case, then results version, then category and view. Every link builder (the version path, document route, view href, citation link, navigation) takes a base prefix, defaulting to the local one.
- Which views are available on hosted comes from a small availability overlay (ported, coming soon, never). The generated view registry is never edited by slices.
- System views (rescan, backup, manual) are never offered on hosted.

**View files (shards)**
- On the operator's machine, a **payload builder** turns a results version into immutable JSON shards:
  - a shell and an overview shard;
  - one shard per dataset view, which is the existing local loader's own return value, computed on the operator machine;
  - the chronology list, paged, plus facets;
  - one shard per document;
  - a search index;
  - a bundle-paths index;
  - an originals index;
  - a manifest listing every shard with its SHA-256 and size.
- Shard types live in one shared payload module. Mixed loaders are split into a pure part (from the version) and a merge part (with user work), so the builder can call the pure part.
- The hosted app reads a shard by checking the user's access once, then reading Cloudflare's edge cache, falling back to storage. Shards are cached as immutable. Integrity is checked when shards are written and recorded in the manifest. Nothing re-hashes on read.
- The whole-model load and hash on every page (`loadVerifiedModel`) and the per-page version verification are removed from the client read path.

**Originals**
- Originals are stored once per content hash, under the existing key scheme. They are served with ranged, streamed reads that are conditional on the stored tag, with no hashing on read.
- The viewer page issues a short-lived signed asset ticket, so the PDF viewer's range requests need no database lookup.
- Very large downloads (about 100 MB and up) go through short-lived presigned storage URLs.
- Media family and size come from the originals index, so delivery does not probe the bytes first.

**Access and sessions**
- Clerk is used only at sign-in and sign-out.
- After sign-in the app issues its own HttpOnly session: 8 hours sliding, 24 hours at most.
- Sign-out writes a revocation entry that every request checks. The revocation store is Cloudflare KV.
- Access to a case is one indexed grant lookup per request.
- The owner accepted that revocation takes effect within about a minute.

**Audit**
- Every read is still audited: one row per request, written after the response, with no read-back.
- Changes are audited in the same database batch as the change, and fail closed.

**Request budget**
- Per page view: no Clerk call, at most one database query, at most one storage read.
- Per PDF range request: no database query, one storage read.
- A test enforces this budget.

**Publication**
- A candidate version is registered from the builder's manifest.
- Sign-off binds the results version, the package manifest hash and the shard manifest hash, with acknowledgements of warnings.
- Failed or missing previews are warnings, not blockers. "Required render" becomes "the shard manifest is present and hashed".
- Publication flips a per-case pointer and keeps the previous version for rollback.
- The staged import with leases, the online evidence engine, the native render checks and the Browser Rendering reservations are frozen. They are bypassed, not extended.

**User work**
- Notes, registers, seed overlays, custom bundles, the discovery mode and the bundle header stay in the client's database through the existing hosted user-work store.
- One adapter gives the local form actions the hosted store's semantics: an operation id, the expected version, and stale or gone answers.

**Look**
- The partners' prototype v0.1 tokens and shell, as measured in `research/ui-spec.md`: a 240 px dark navy sidebar with teal accents, a 56 px top bar with search and the version pill, 6 px cards with a light shadow, 14 px body text and 28 px KPI figures. Fonts: the system font stack only (owner decision, 28 October: it matches what the prototype actually rendered and loads no font files).
- Local route semantics, provenance and truthful totals stay.
- A navigation drawer replaces the sidebar on phones.
- Prototype-only surfaces (operations console, tray, "what changed", Outlook) are deferred.

**Environments**
- One Cloudflare account and one codebase:
  - a `clearcase-staging` Worker with its own EU database, EU storage and KV, a Clerk development application, a London placement pin in config, and Cloudflare Access for the team;
  - a per-branch Workers Preview bound to the staging resources;
  - per-client production Workers on client subdomains once the domain is active.
- A deploy builds once, applies database migrations (after a time-travel bookmark) and deploys a version. Rollback redeploys the previous version.
- Database migrations for the sprint are pre-numbered per ticket, so parallel tickets never collide.

**Data for the demo**
- The real v5 export, converted against the full case folder: 1,753 originals, about 1.85 GB of unique referenced bytes.
- Staging is pre-loaded with a few notes, deadlines and a custom bundle, so those screens are not empty.

## Testing Decisions

- **What a good test is:** it exercises behaviour a user or operator sees, through the highest seam available, and never asserts on implementation detail.
- **Seam 1, the payload contract:**
  - the builder's output for a synthetic fixture case matches the shard types;
  - each hosted view loader renders the same props from a shard as the local loader renders from the local store.
  - Prior art: the fixture-driven view tests under the analysis, litigation, quantum and calculations test folders, and the in-memory case reader.
- **Seam 2, the request budget:** a test counts database, Clerk and storage calls per route through the existing hosted test doubles, and fails above the budget.
- **Seam 3, the acceptance journeys:** ten Playwright journeys (J1–J10) that run against local, a preview or staging by changing an environment variable:
  - J1 shell and navigation;
  - J2 overview;
  - J3 chronology, split pane and citation;
  - J4 documents, document page and PDF first page at three sizes;
  - J5 analysis views;
  - J6 search;
  - J7 notes;
  - J8 deadlines and calendar export;
  - J9 bundles;
  - J10 a 20-minute idle survival.
  Each ticket names the journey and the step that proves it. Hosted pages carry the `data-testid` hooks listed in `research/journeys.md`.
- **Seam 4, security:** the existing hosted identity, tenancy, audit and storage test suites stay green. Auth changes add tests for session expiry, revocation, cross-client and cross-case refusal, and asset-ticket expiry.
- **Per ticket:** typecheck; svelte-check when Svelte changed; `vitest related` plus the ticket's test folders; the hosted import check and hosted build when hosted code changed; a walk of the journey on the ticket's preview. The full suite, the hosted gate and the timed journeys from South Africa run on merge and nightly, not per pull request.
- **The release gate (Monday 2 November):** J1–J10 on staging from a South African network:
  - pages under 2 s;
  - first PDF page under 3 s;
  - sign-in under 5 s;
  - no 401 or 503 across a 20-minute idle;
  - at a recorded SHA.

## Out of Scope

These are out of scope for the demo sprint and come later:
- the 14–17 TB ingest at scale:
  - the per-case file catalogue with file-name search over millions of files;
  - batch bundles and a Workflow-based importer;
  - stable references across batches;
  - results-package format version 2;
- full-text and semantic search;
- the staff publication UI beyond what already exists (the demo publishes through the operator command with a recorded human sign-off);
- client production instances on custom domains (blocked on the domain's nameservers);
- recovery tooling and grant renewal;
- prototype-only surfaces (operations console, bundle tray, "what changed", Outlook integration, billing, audit-log view);
- converted previews for non-PDF formats.

The sprint-to-dev pull request with full review happens after the demo.

## Further Notes

- The owner allows the real v5 case on staging and in the demo. Real case material still never goes into Git, and the partners' prototype stays out of Git because it holds real case dates.
- `research/` holds the evidence behind every decision here: view contracts, the build spike, delivery speed, the agent protocol, Cloudflare operations, the data path, the boat.dev fleet, the UI spec and the journeys.
- Local defects found by the journeys, which hosted must not copy:
  - the chronology has no split pane;
  - case-wide notes don't show note text;
  - an assembled bundle PDF is lost after a reload;
  - document-note saves take 2–4 s.
  Heads of Argument is empty because it is a user register that starts blank; that is expected.
