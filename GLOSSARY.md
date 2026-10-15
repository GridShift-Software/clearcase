# ClearCase

ClearCase organizes a legal case's source documents, processed results and working records for review.

## Language

### Case material

**Case**:
A legal matter and its associated documents, results and working records.
_Avoid_: Workspace when referring to the legal matter itself.

**Case folder**:
The local folder that holds a case's originals. The app reads it and never writes into it.
_Avoid_: Data directory, which holds the app's own stores.

**Original**:
A source file supplied for the case, or an extracted attachment whose parent source is recorded.
_Avoid_: Result when referring to source evidence.

**Case pack**:
The `.zip` supplied for a case, or the folder it was extracted to, containing the workspace HTML and originals. The local app converts its processed workspace data into a results package.
_Avoid_: Results package, which is the versioned output of that conversion.

**Citation**:
A reference in results text to an original, optionally to one page, that the reader can follow to that original.
_Avoid_: Link when referring to the case reference itself.

**Submission**:
A finalized set of files supplied for processing as one input revision.
_Avoid_: Upload when referring to a completed input revision.

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
A results version available for internal validation and review before activation or publication.
_Avoid_: Published result for an unapproved version.

**Activation**:
Selection of the results version used by the local workspace.
_Avoid_: Publication when there is no hosted client audience.

**Sign-off**:
A human's approval of a specific results version after review.
_Avoid_: Validation when referring to human approval.

**Publication**:
Making an approved results version available to the hosted client's users.
_Avoid_: Upload when referring to client visibility.

**User work**:
Notes, registers, selections and preparation material entered by people using the workspace. It lives apart from results packages and survives a change of results version.
_Avoid_: Generated analysis for user-entered records.

**Register**:
A list of user work that people maintain in a view, such as deadlines, filings or authorities.
_Avoid_: Register alone for the intentional-differences register.

**Store**:
A local database the app owns. The results store holds the imported results versions; the user-work store holds user work, apart from results, and survives a change of results version.
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

**Lane**:
One numbered acceptance check in a run against the real v5 sample, with its own transcript and screenshot.
_Avoid_: Scenario, which runs on a synthetic case.

**Gate**:
A pass or fail decision on one exact revision that must pass before work depending on it proceeds. Every ticket passes the gate command; a milestone ends with an independent gate.
_Avoid_: Review, which is one input to a gate.

### People

**Operator**:
A person on the service team who prepares and reviews results.
_Avoid_: Firm admin when referring to the current application's unverified operator role.
