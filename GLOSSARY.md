# ClearCase

ClearCase organizes a legal case's source documents, processed results and working records for review. The terms cover the local v5 pilot and the hosted alpha. Hosted roadmap entries describe planned contracts, not guarantees of this local revision. Local access is limited to loopback requests.

## Language

### Case material

**Case**:
A legal matter and its associated documents, results and working records. The local pilot derives its case list from stored results versions. An independent case lifecycle before first publication and after results withdrawal is a hosted roadmap contract (GRS-114).
_Avoid_: Workspace when referring to the legal matter itself.

**Case folder**:
The local folder that holds a case's originals in the local app. The app reads it and never writes into it. The hosted app has no case folder.
_Avoid_: Data directory, which holds the app's own stores.

**Original**:
A source file supplied for the case, or an extracted attachment whose parent source is recorded. It is kept unchanged.
_Avoid_: Result when referring to source evidence.

**File preview**:
A readable or playable representation of an original inside the case workspace. It may be a converted representation and does not replace the original. Rendition is a synonym; prefer file preview. Hosted asset visibility is roadmap work (GRS-28, GRS-30, GRS-31). An unchanged acknowledged original is not a candidate-derived asset: a file preview or other asset derived while a candidate is private stays private until publication, while the original keeps its own access rule.
_Avoid_: Preview alone when it could mean the private review of an unpublished results version.

**Case pack**:
The `.zip` supplied for a case, or the folder it was extracted to, containing the workspace HTML and originals. The local app converts its processed workspace data into a results package.
_Avoid_: Results package, which is the versioned output of that conversion.

**Citation**:
A reference in results text to an original and, when supplied, a precise location within it. A reference without a precise location is a file-level citation.
_Avoid_: Link when referring to the case reference itself.

**Submission**:
Hosted roadmap (GRS-28).
A finalized set of files supplied for processing as one input revision; it never changes once finalized. Files supplied later form a new submission, unless they are a requested supplement.
_Avoid_: Upload when referring to a completed input revision.

**Requested supplement**:
Hosted roadmap (GRS-28, GRS-135).
Files or passwords that the service team asks for because a submission cannot be processed without them. They join that submission's processing job and leave the submission itself unchanged.
_Avoid_: Resubmission, amendment, new submission, new revision, supplementary input.

**Processing job**:
Hosted roadmap (GRS-135).
The service team's manual processing of one submission, together with any requested supplements linked to it. It is what holds a place in the processing queue.
_Avoid_: Ticket, task, request.

**Processing queue**:
Hosted roadmap (GRS-135).
The service team's shared list of processing jobs awaiting manual processing, across all clients.
_Avoid_: Backlog, inbox.

### Results

**Results package**:
A versioned set of processed case data and its mappings to the originals, identified by its resultsVersion.
_Avoid_: Backup when referring to processing output.

**resultsVersion**:
The content identity of a results package. Any change to its data or to an original it maps gives a new resultsVersion; the same content always gives the same one. Routes and pages call it `vid`, and test code `rv`; both mean the resultsVersion.
_Avoid_: Version number, build id.

**Accepted identity**:
The pair {resultsVersion, diagnosticsSha256} that a reviewed conversion of the v5 sample produced, recorded so that any later change in conversion output or diagnostics is noticed.
_Avoid_: Expected hash.

**Candidate**:
A results version held privately for validation, review and correction before activation or publication. Hosted client isolation, review and sign-off are roadmap contracts (GRS-30, GRS-31, GRS-130). Clients cannot see a hosted candidate. A candidate is identified by its resultsVersion. Review, correction and sign-off are events recorded against that identity and are not versions themselves. Correcting content gives a new resultsVersion, so a fresh candidate that needs its own sign-off. Importing identical content again gives the same resultsVersion, and a sign-off never carries from one resultsVersion to another.
_Avoid_: Published result for an unapproved version; published candidate (say published results version).

**Activation**:
Selection of the results version used by the local workspace.
_Avoid_: Publication when there is no hosted client audience.

**Sign-off**:
Hosted roadmap (GRS-31).
A named person's approval of one exact results version after review.
_Avoid_: Validation when referring to human approval.

**Publication**:
Hosted roadmap (GRS-31).
Making a signed-off results version the one that a client instance's assigned users see; that version is the published results version. Only an authorized person publishes.
_Avoid_: Upload or import when referring to client visibility.

**Reviewer correction**:
Hosted roadmap (GRS-130).
A change an authorized reviewer makes to candidate results before publication. It belongs to the results, distinct from user work and the unchanged originals.
_Avoid_: Overlay, which describes a user's edit to a register seed.

**User work**:
Notes, registers, selections and preparation material entered by people using the workspace. It lives apart from results packages and survives a change of results version.
_Avoid_: Generated analysis for user-entered records.

**Note**:
A person's written remark in user work. Local notes attach to an imported document ref and fingerprint. Location and analysis-section anchors, and assignment-based visibility, are hosted roadmap contracts (GRS-119).
_Avoid_: Annotation, document note, comment.

**Register**:
A list of user work that people maintain in a view, such as deadlines, filings or authorities.
_Avoid_: Register alone for the intentional-differences register.

**Store**:
A local database the app owns. The results store holds the imported results versions; the user-work store holds user work, apart from results, and survives a change of results version. In the hosted roadmap (GRS-115, GRS-117), the equivalents are D1, which holds results and user-work records, and R2, which holds originals, file previews and exports; each client instance has its own D1 and R2. Name D1 or R2 when the hosted boundary is meant.
_Avoid_: Workspace store, local store and case store in user messages; say which store.

**Seed**:
A row that a results package supplies for a register, with an id that stays the same across versions.
_Avoid_: Imported topic, default row.

**Overlay**:
A user's edit or deletion of a seed, kept in user work and keyed by the seed's id. The seed itself is never changed.
_Avoid_: Override, patch.

**Orphaned**:
The state of an overlay whose seed is gone from the active results version. The edit is kept and shown.
_Avoid_: Dangling, deleted.

**Document row**:
One entry in a version's document list: an imported row from the results package, in source order, or a provider row. It is addressed by its ref.
_Avoid_: Document alone for the row.

**Provider row**:
A document row that a registered provider adds after the imported rows, for a document the results package does not list. When a provider row and an imported row share a ref, the imported row wins.
_Avoid_: Extra document.

**Ref**:
The identifier of a document row, unique within a results version. A citation resolves only when its ref names a document row.
_Avoid_: Document id.

### Case work

**Represented client**:
Hosted roadmap (GRS-124).
A person or entity that the law firm acts for in a case. Distinct from the client, which is the firm or individual that uses ClearCase.
_Avoid_: Client, customer when the represented party is meant.

**KYC record**:
Hosted roadmap (GRS-124).
The onboarding documents a law firm keeps for one of its represented clients, with the firm's own manual review of them.
_Avoid_: Identity verification, customer vetting, compliance register.

**Case costs**:
The time, fees and disbursements recorded against a case.
_Avoid_: Billing, fee note and invoice when only recorded costs are meant; invoice ledger, which lists invoices from the case material.

**PDF bundle**:
An ordered compilation of PDFs assembled into one PDF with its index. Distinct from a complete case export, which carries the case's originals, file previews and manifest. Explicit Notes selection and scope review for these outputs are hosted roadmap contracts (GRS-118, GRS-128). Notes are in neither output unless the user explicitly selects them, and the selected scope is shown before download.
_Avoid_: Bundle alone, which v5 also uses for a document category; packet, case packet, packet export.

**Complete case export**:
Hosted roadmap (GRS-118).
The download of one case's originals, published file previews and manifest. It is not a PDF bundle. Notes are absent unless explicitly selected, with the selected scope shown before download.
_Avoid_: Case packet, packet export, backup.

**PDF bundle version**:
Hosted roadmap (GRS-128).
One particular generated PDF bundle with its index, tied to the exact source versions it compiled, in their order. Regenerating a PDF bundle gives a new PDF bundle version and leaves the earlier ones as they were.
_Avoid_: Bundle revision, bundle update, overwritten bundle.

### Matching v5

**v5 sample**:
The supplied v5 workspace HTML, with 1,689 documents and 42 views, that V1 must match first.
_Avoid_: Old app, legacy HTML.

**View**:
One of the 42 navigation destinations of the v5 sample, as the app reproduces it, named by its v5 navigation id.
_Avoid_: Tab, page.

**View owner**:
The ticket that implements a view. The view stays unavailable until that ticket passes its gate.

**View registry**:
The list of all 42 views with their labels, groups, owners and availability.
_Avoid_: Navigation config.

**Parity**:
The app behaving like the v5 sample on the same input, view by view, as a user sees it, not only holding the same data.
_Avoid_: Data match.

**Intentional difference**:
A way the app deliberately differs from the v5 sample, such as a fixed v5 defect, recorded with its reason and an example.
_Avoid_: Known diff, waiver.

**Intentional-differences register (IDR)**:
The record of every intentional difference, each with an `IDR-NNN` id. A parity difference passes only when an entry covers it, and an entry that changes what users see needs the user's approval.
_Avoid_: Allow list.

### Acceptance

**Evidence**:
A check run that counts toward acceptance: complete, unmocked, and on a fresh build of one exact revision.
_Avoid_: Passing run, for a reduced or stale run.

**Release candidate source SHA**:
The Git revision of the app that a release gate accepts. It names the app build and is unrelated to a candidate's resultsVersion, which names results content.
_Avoid_: Candidate SHA.

**Pilot lane**:
One numbered acceptance check in a `verify:pilot:v5` run against the real v5 sample, with its own transcript and screenshot. Only this local pilot check keeps the word. Verification lanes as a way to fan out agents are retired and not used.
_Avoid_: Lane alone; scenario, which runs on a synthetic case.

**Gate**:
A pass or fail decision on one exact revision that must pass before work depending on it proceeds. The checks are scaled to the change: a ticket that touches the app runs `bun run --bun gate`, a hosted ticket also runs `gate:hosted` once it exists, and a documentation or research ticket runs `check` and `test` plus `check-plan`. A milestone ends with an independent gate.
_Avoid_: Review, which is one input to a gate.

### People

**Operator**:
Hosted roadmap (GRS-113, GRS-114, GRS-116).
A person on the service team who prepares and reviews results. Reaches a client instance only through explicitly granted, audited access.
_Avoid_: Firm admin, which is a client's administrator.

**Global Admin**:
Hosted roadmap (GRS-113, GRS-114, GRS-116).
The service team's account and role for managing client instances and their administrators. Reaches case contents only through explicitly granted, audited access.
_Avoid_: Super admin, operator.

**Firm admin**:
Hosted roadmap (GRS-113, GRS-114).
A client's administrator, who manages that client's users and case assignments. The role does not by itself reveal case contents.
_Avoid_: Global Admin, owner.

### Clients

**Client**:
Hosted roadmap (GRS-114).
A law firm, or an individual working alone, that uses the hosted service for its cases. A client has one or more users.
_Avoid_: Tenant, customer, and firm when an individual client is meant.

**Client instance**:
Hosted roadmap (GRS-114).
A hosted ClearCase workspace belonging to one client, isolated from other clients' case material and user work.
_Avoid_: Tenant, workspace, deployment when referring to the client's boundary.

**Case assignment**:
Hosted roadmap (GRS-114).
Granting one of a client's users access to one case as a case viewer or case editor. A user sees only the cases assigned to them. Membership of the client or an admin role does not grant case access.
_Avoid_: Case sharing, firm-wide access.

**Case viewer**:
Hosted roadmap (GRS-113, GRS-114).
A user assigned to a case who can read and download it, but not change it.
_Avoid_: Reader, guest.

**Case editor**:
Hosted roadmap (GRS-113, GRS-114).
A user assigned to a case who can do everything a case viewer can and also maintain user work on it. Neither role edits originals or published results.
_Avoid_: Owner, contributor.
