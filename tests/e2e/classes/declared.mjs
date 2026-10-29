// What the UI class suite (GRS-59) cannot find out from the page itself: why a class does not apply to a target the
// app's definitions name (targets.mjs). This file is the only way out of a class. A target the suite cannot drive and
// that is not declared here FAILS its scenario; a declaration the page contradicts (a "no typed field" form that has
// one, a "no leave question" page that has one, a "not CSV" file that builds CSV) fails too, so a reason is checked
// against the app on every run rather than trusted.
//
// Keys are route ids (src/routes/...), `<route> <action>` for a form, or a file path under the repository.
// Classes: inflight, nojs, dialog, csv, narrow, back.

/**
 * Forms whose save leaves none of the typed text in the work store, by form key, with the element the page shows once the
 * save took effect. Every other form must show its typed text in the work store after a successful save (inflight, and the
 * set-up saves of nojs, dialog and csv); a form that satisfies neither fails its scenario.
 */
export const SAVE_SHOWS = {
	'/v/[vid]/system/backup_tab ?/restore': '#restore-done',
};

/** Routes with form actions whose page renders no POST form in the suite's state, with why. */
export const NO_FORM = {
	'/import/[id]': 'the activation form is shown only for a candidate that is not active; the suite views an active version (main-flow and verify-clearcase drive it)',
	'/recovery': 'the adopt form is shown only after an unclean shutdown left a recovery state; the durability suite drives it',
	'/v/[vid]/overview': 'the rollback form is shown only when an earlier version was active',
	'/v/[vid]/bundles/caselines_tab': 'saves through postAction (fetch) without a <form>; the bundles suite drives its in-flight and two-tab input (GRS-19)',
	'/v/[vid]/bundles/court_bundle_tab': 'saves through postAction (fetch) without a <form>; the bundles suite drives its in-flight and two-tab input (GRS-19)',
	'/v/[vid]/bundles/discovery_tab': 'saves through postAction (fetch) without a <form>; the bundles suite drives its in-flight and two-tab input (GRS-19)',
	'/v/[vid]/chronology': 'the original action is posted by the preview pane\'s fetch (LocalOriginal.svelte, `?/original`) when a row is selected, not by a <form>; the page itself renders no POST form (GRS-271)',
};

/** Per route and action (`?/add`): classes that do not apply, with why. */
export const NOT_APPLICABLE = {
	'/import ?/import': {
		inflight: 'Validate opens the report page of the new import; it is a request, not a save of typed work',
		nojs: 'Validate writes no user work, so a busy work store cannot refuse it; a refused path is re-rendered by the pilot suite',
		dialog: 'Validate writes no user work and no question guards the form',
	},
	'/import ?/importCase': {
		inflight: 'Open case opens the report page of the new import; the case name is a label for that import, not a save of typed work',
		nojs: 'Open case writes no user work, so a busy work store cannot refuse it; a refused pack is re-rendered with its message by the page',
		dialog: 'Open case writes no user work and no question guards the form',
	},
	'/v/[vid]/system/backup_tab ?/restore': {
		nojs: 'a restore replaces all of the case\'s user work; there is no other row on the page to act on',
	},
};

/**
 * Forms with no typed field to type into, or no submit button to hold: classes inflight, nojs and dialog do not apply.
 * Checked: the form the suite finds must really have no typed field or no submit button.
 */
export const NO_TYPED_FIELD = {
	'/v/[vid]/analysis/info_required_tab ?/toggle': 'a checkbox per item posts on change; the form has no submit button and no typed field',
	'/v/[vid]/litigation/enforcement_tab ?/status': 'a status select per step saves on change (JavaScript) or through a noscript Save; the form has no submit button and no typed field',
	'/v/[vid]/system/rescan_tab ?/scan': 'the form is one Rescan button; it has no typed field',
};

/**
 * Pages whose forms are not guarded by a question when the user leaves (classes dialog and back's Keep/Stay), by route.
 * Checked: the page's source (and the .svelte components it imports) must hold no LeaveGuard or beforeNavigate.
 */
export const NO_GUARD = {
	'/v/[vid]/doc/[ref]': 'the note form has no leave question (no LeaveGuard or beforeNavigate on the page); a note typed and left is dropped without asking',
	'/v/[vid]/system/backup_tab': 'the restore form (a file, a path, a confirm box) has no leave question; nothing is saved until Restore is pressed and it asks nothing else',
};

const OFF_WHILE_REFUSED = 'Edit and Delete stay off, without JavaScript, while a refused save is pending: the refusal\'s text lives only in the page and a row action would reload it without the text (RegisterPage header)';
/**
 * Forms where no enabled action on another row exists once a save is refused (nojs): the page has no row action, or
 * switches them off until the refusal is retried or discarded. Checked: after the refusal every other action is disabled
 * or absent; an enabled one fails the declaration, since the scenario must then click it.
 */
export const OTHER_ACTION_OFF = {
	'/v/[vid]/litigation/authorities_tab ?/add': 'v5 has no edit or delete for authorities (S-authorities_tab-1); the table has no row action',
	'/v/[vid]/doc/[ref] ?/note': 'Delete note is off until a refused note is saved or discarded (the refused text lives only in the page)',
	'/v/[vid]/registers/annotations_tab ?/save': OFF_WHILE_REFUSED,
	'/v/[vid]/registers/deadlines_tab ?/save': OFF_WHILE_REFUSED,
	'/v/[vid]/registers/disbursements_tab ?/save': OFF_WHILE_REFUSED,
	'/v/[vid]/registers/popia_tab ?/save': OFF_WHILE_REFUSED,
	'/v/[vid]/registers/privilege_tab ?/save': OFF_WHILE_REFUSED,
	'/v/[vid]/registers/timesheet_tab ?/save': OFF_WHILE_REFUSED,
	'/v/[vid]/registers/transcriptions_tab ?/save': OFF_WHILE_REFUSED,
};

/** Pages outside a case version: there is no case navigation to leave by and come back (class back). Checked: the url is not under /v/. */
export const NO_BACK = {
	'/cases': 'outside a case version there is no case navigation to leave by and come back',
	'/import': 'outside a case version there is no case navigation to leave by and come back',
	'/import/[id]': 'outside a case version there is no case navigation to leave by and come back',
	'/recovery': 'outside a case version there is no case navigation to leave by and come back',
};

/** Files that hand content to the user (download, Content-Disposition, an object URL, <a download>) but that are CSV helpers, not producers. */
export const HELPERS = {
	'src/lib/components/csv.ts': 'the CSV helper itself: toCSV, userCell and `download`',
	'src/lib/components/download.ts': 'shared browser download helper for CSV and binary or HTML exports',
	'src/lib/case-package/media.ts': 'a table of media types for package files',
};

/** Files that hand content to the user and do not produce CSV, with what they do. Checked: none may carry a CSV mark. */
export const NOT_PRODUCERS = {
	'src/lib/components/OriginalOpen.svelte': 'links to an original (bytes of the case file)',
	'src/lib/local-case/originals.server.ts': 'serves original bytes with Content-Disposition',
	'src/lib/server/runtime/memory-assets.ts': 'the contract test double serves original bytes with Content-Disposition',
	'src/lib/server/runtime/hosted/gate/assets.ts': 'the hosted-gate test double serves original bytes with Content-Disposition',
	'src/lib/views/bundles/Builder.svelte': 'bundle index as PDF and DOCX',
	'src/lib/views/bundles/caselines.ts': 'a link to a bundle file',
	'src/lib/views/bundles/links.server.ts': 'download links to bundle files',
	'src/routes/v/[vid]/bundles/caselines_tab/+page.svelte': 'downloads of bundle files and session uploads',
	'src/routes/v/[vid]/bundles/court_bundle_tab/+page.svelte': 'bundle indexes as DOCX',
	'src/routes/v/[vid]/bundles/discovery_tab/+page.svelte': 'cover and index as HTML',
	'src/routes/v/[vid]/doc/[ref]/+page.svelte': 'download links to the document\'s original and its attachments',
	'src/routes/v/[vid]/system/backup_tab/+page.svelte': 'link to the JSON backup',
	'src/routes/v/[vid]/system/backup_tab/download/+server.ts': 'the JSON backup (application/json)',
	'src/routes/v/[vid]/system/rescan_tab/+page.svelte': 'link to the JSON index',
	'src/routes/v/[vid]/system/rescan_tab/index.json/+server.ts': 'the JSON index (application/json)',
	'src/lib/views/hosted/OperatorWorkbench.svelte': 'hosted operator workbench: links to the exact submission manifest (JSON) and the submitted PDF',
	'src/lib/results/hosted/assets.ts': 'hosted result assets served with Content-Disposition from the media policy (original bytes, never CSV)',
	'src/lib/submissions/download/controller.ts': 'hosted operator download: the submission manifest (attachment, JSON) and the submitted PDF bytes',
	'src/lib/viewer/hosted/PdfViewer.svelte': 'hosted viewer: Download links to the original PDF',
	'src/lib/viewer/hosted/delivery.ts': 'hosted viewer delivery: original PDF bytes with Content-Disposition from the serve policy',
	'src/lib/viewer/hosted/native-render-check.ts': 'builds an object URL for the PDF worker script (text/javascript) in the native render check; a script, not a download',
	'src/lib/viewer/hosted/original-delivery.ts': 'hosted viewer delivery of a stored original: its bytes inline or as an attachment (download=1) with the serve policy\'s Content-Disposition, never CSV',
	'src/lib/viewer/hosted/presign.ts': 'signs a short-lived R2 URL that downloads the stored original as application/octet-stream (response-content-disposition=attachment); it builds a link, not CSV',
	'src/lib/views/evidence/LocalOriginal.svelte': 'the local original pane: Download links to the original file\'s bytes (<a download>), never CSV',
	'src/routes/v/[vid]/bundles/court_bundle_tab/assembled/+server.ts': 'the assembled court bundle PDF (application/pdf, attachment; filename="Bundle.pdf")',
};

/**
 * Downloads a CSV page makes that are not CSV, by the downloaded file's name. A page that also exports a .csv is still
 * checked on that file; a page whose only downloads are these is checked for none.
 */
export const NON_CSV_DOWNLOADS = {
	'.ics': 'an iCalendar file, not CSV; the registers suite checks its TEXT escaping (SC4, SC18)',
	'.txt': 'a plain-text outline (the Heads of Argument export), not CSV',
};

/** Pages that show their table only for a query in the URL (class narrow): the suite opens them with it, and the table must then show. */
export const TABLE_QUERY = {
	'/v/[vid]/evidence/search': { query: '?q=synthetic', why: 'the results table shows only for a submitted search' },
	'/v/[vid]/system/manual': { query: '?list=ocr', why: 'the list of scanned documents needing OCR shows only when asked for' },
};

/**
 * Pages whose source renders a table (class narrow) but that show none in the suite's state, with why. Checked: the
 * page must show no table at 320 and 390 px; one it shows fails the declaration, since it must then be measured.
 */
export const NO_TABLE = {
	'/v/[vid]/litigation/conflict_tab': 'the matches table shows only after Check is pressed in the browser; the conflict suite (GRS-18) drives it',
	'/v/[vid]/system/rescan_tab': 'the additions and changes tables show only after a scan finds files the version did not index; the suite\'s case folder has none',
};

/**
 * Pages whose main sets no data-ready marker (class narrow), with why. Every other page must show a ready marker that is
 * not an error before narrow counts it rendered; a declared page must show content in its main instead, and a marker it
 * does set fails the declaration.
 */
export const NO_READY = {
	'/cases': 'the cases list is server-rendered with no client step to wait for; its main holds the page header and the case cards',
};

/**
 * Page states that appear only after a choice (class narrow) and that the suite opens as well as the page's default
 * state: `query` is the URL the choice makes (every such choice in the app is a query, a GET form or a link), `expect`
 * a selector that must then be on the page (a state that did not come up fails). Each state is measured at 320 and
 * 390 px under both ids, like the page itself. Opened `<details>` are not listed: the check opens them all.
 */
export const CHOICE_STATES = {
	'/v/[vid]/evidence/hoa_diff_tab': [{ name: 'two-documents', query: '?a=OD-001&b=OD-002', expect: '#diff-body', why: 'the diff shows only once two documents are chosen; its text is user data (a URL in an excerpt)' }],
	'/v/[vid]/evidence/search': [{ name: 'action-items', query: '?actions=1', expect: '#action-items', why: 'Extract action items replaces the results by the action-item table' }],
	'/v/[vid]/evidence/documents': [{ name: 'filtered', query: '?bundle=Original&q=Synthetic', expect: 'main table, main [role=table]', why: 'a bundle and a filter change the rows' }],
	'/v/[vid]/bundles/caselines_tab': [{ name: 'searched', query: '?q=Invented', expect: '#cl-summary', why: 'a search lists the matching bundle pages' }],
	'/v/[vid]/bundles/court_bundle_tab': [
		{ name: 'bundle-index', query: '?b=1', expect: '#cb-index', why: 'a chosen bundle opens on its index' },
		{ name: 'bundle-items', query: '?b=1&tab=items', expect: '#cb-items', why: 'the Items tab holds the page-number table' },
		{ name: 'bundle-view', query: '?b=1&tab=view', expect: '#cb-tab-view[aria-selected=true]', why: 'the View tab shows the bundle file' },
		{ name: 'builder', query: '?view=build', expect: '#cbb-create', why: 'the builder lists the items to choose' },
	],
	'/import': [
		{ name: 'add-documents', query: '?pick=case', expect: '#case-browser [aria-current=location]', why: 'Add documents opens the folder browser for the case pack in a modal dialog' },
		{ name: 'store-in', query: '?pick=destination', expect: '#destination-browser [aria-current=location]', why: 'Change opens the folder browser for the storage folder in the same dialog' },
	],
	'/import/[id]': [{ name: 'noop-repaired', query: '?noop=1&repaired=1', expect: '#noop-msg', why: 'the notices an import shows after a repeat or a repair' }],
};

/**
 * Page states that exist only when a generation's data carries a field (class narrow), not after a choice: the suite imports
 * a newer-generation case (suite.mjs withNewer: risks with category, owner and documents, and document text cut at the
 * builder's cap) and opens each page in it, measured at 320 and 390 px like the page's default state. `expect` is a selector
 * that must then be on the page, so a state the data did not bring up fails.
 */
export const DATA_STATES = {
	'/v/[vid]/analysis/risk_matrix_tab': [
		{ name: 'risk-category', expect: '#risk-table td[data-label=Category]', why: 'the Category column appears when a risk carries a category' },
		{ name: 'risk-owner', expect: '#risk-table td[data-label=Owner]', why: 'the Owner column appears when a risk carries an owner' },
		{ name: 'risk-documents', expect: '#risk-table td[data-label=Documents]', why: 'the Documents column appears when a risk cites documents' },
	],
	'/import/[id]': [
		{ name: 'text-coverage', expect: '#text-coverage', why: 'the Source text coverage section appears when the conversion reported text cut short by the source export' },
		{ name: 'source-coverage', expect: '#source-coverage', why: 'the Source coverage section appears when the conversion recorded source data it kept but does not present' },
	],
};

/** Page states that appear after a choice and that the suite does not open, with why (reported as N/A in the narrow class). */
export const NO_CHOICE_STATE = {
	'/v/[vid]/bundles/discovery_tab: supplementary': 'a client-side switch that saves the mode to the case; it shows the same items table in the same TableScroll box as the default mode (discovery_tab: one {#each items} block), and driving it would change the case for the later scenarios',
	'edit rows and add forms (registers, filings, litigation)': 'inline forms open inside the table\'s TableScroll box or in the page flow, whose width the other states fix; the inflight and dialog classes drive them',
	'alertdialog (the question before leaving with typed input)': 'RegisterPage, filings and payments show it in flow with flex-wrap, and LeaveGuard as position:fixed with a max-width inside the viewport; the dialog class drives it',
};


export const UI_CLASSES = ['inflight', 'nojs', 'dialog', 'csv', 'narrow', 'back'];

/** Ask-then-save targets that cancel the existing question at save start; the suite must observe it closed in flight. */
const SAVE_CLOSES_QUESTION = 'Save clears the pending edit/leave question at submit start; the held request must leave no visible question.';
export const DIALOG_CLOSED_BY_SAVE = {
	'/v/[vid]/evidence/filings_tab ?/add': SAVE_CLOSES_QUESTION,
	'/v/[vid]/registers/annotations_tab ?/save': SAVE_CLOSES_QUESTION,
	'/v/[vid]/registers/deadlines_tab ?/save': SAVE_CLOSES_QUESTION,
	'/v/[vid]/registers/disbursements_tab ?/save': SAVE_CLOSES_QUESTION,
	'/v/[vid]/registers/popia_tab ?/save': SAVE_CLOSES_QUESTION,
	'/v/[vid]/registers/privilege_tab ?/save': SAVE_CLOSES_QUESTION,
	'/v/[vid]/registers/timesheet_tab ?/save': SAVE_CLOSES_QUESTION,
	'/v/[vid]/registers/transcriptions_tab ?/save': SAVE_CLOSES_QUESTION,
};


/** Pages reached through the shared download helper that intentionally export no CSV; checked against their downloads. */
export const NON_CSV_PAGES = {
	'/v/[vid]/registers/deadlines_tab': 'Export calendar produces only an ICS file; the registers suite checks its TEXT escaping.',
	'/v/[vid]/litigation/heads_tab': 'Export outline produces only a plain-text outline; the litigation suite checks it.',
};

/**
 * Hosted pages with a form, by route id under deploy/client/routes, with why the class suite does not drive them. The suite
 * drives the local pilot (src/routes) over its work store, so it drives none of these. Checked (classes-targets.test.ts):
 * discovery finds exactly these routes, and each is bound to evidence of the kind HOSTED_FORM_EVIDENCE declares, so a
 * reason cannot outlive the evidence it cites. The three test-identity routes are driven by the hosted smoke run
 * (test:hosted, on workerd); the others only by unit or component tests, over doubles, which are not browser or workerd proof.
 */
export const HOSTED_FORMS = {
	'/sign-in': 'the test-identity sign-in form saves no user work and has no typed field (one select); test:hosted posts it on workerd (origin check, unknown identity, redirect, cookie)',
	'/sign-out': 'the sign-out action revokes the session and saves no user work; test:hosted posts it on workerd and checks the revoked session is refused at once',
	'/cases': 'the case list is a read page whose only form is the sign-out POST; there is no typed field or user work, and test:hosted reads it for the signed-in, anonymous and wrong-client sessions',
	'/sign-in/operator': 'the ClearCase staff sign-in is one submit button that redirects to the staff Clerk instance; it has no typed field and saves no user work, and the identity operator-route unit tests call its load and action',
	'/cases/[caseId]/notes': 'the hosted case notes route (add and delete note forms) is not the local pilot work store and the suite does not drive it; the case-overview unit tests call its load and actions over doubles, with no browser or workerd run',
	'/cases/[caseId]/views/[resultsVersion]/chronology': 'the only form is a GET filter (search, bundle, type, text status); it saves no user work, and the case-overview unit tests call its load over doubles, with no browser or workerd run',
	'/operator/cases/[caseId]/preview/[candidateId]': 'the private candidate page has only a GET chronology filter and saves no user work; the preview route unit tests call its exact-request load over doubles, with no browser or workerd run',
	'/client/intake/[caseId]': 'the intake form picks one PDF, or several sent as one sealed set, and uploads them through the submissions and sets APIs (no <form> POST, no typed field); the intake component tests dispatch the real route handlers over doubles for the uploads and their adverse cases, and the page itself is not driven',
	'/cases/[caseId]/v/[version]/analysis/info_required_tab': 'the Information Required checklist tick form saves one done flag per item as user work on the hosted work store, not the local pilot store; the route actions unit test calls its toggle action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/bundles/caselines_tab': 'the Caselines page\'s link and unlink forms save and remove a linked case-folder path as user work on the hosted work store; the route actions unit test calls its link and unlink actions over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/bundles/court_bundle_tab': 'the Court Bundle header, restore, clear, builder save and delete forms store the header fields and custom bundles as user work on the hosted work store; the route actions unit test calls its header, clear, save and delete actions over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/bundles/discovery_tab': 'the Discovery schedule\'s select, C/O mark and schedule-mode forms save the marks per file as user work on the hosted work store; the route actions unit test calls its select, co and mode actions over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/doc/[ref]': 'the document page\'s add-note and delete-note forms save case notes anchored to the document on the hosted work store; the notes unit tests call the route\'s note and delnote actions over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/evidence/filings_tab': 'the Filings register\'s add, save and delete forms save filing rows and seed overlays as user work on the hosted work store; the route actions unit test calls its add action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/litigation/authorities_tab': 'the Authorities add form saves authority rows as user work on the hosted work store; the route actions unit test calls its add action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/litigation/crossexam_tab': 'the Cross-examination add and delete forms save question rows (and seed overlays) as user work on the hosted work store; the route actions unit test calls its add and delete actions over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/litigation/enforcement_tab': 'the Enforcement Roadmap status form saves the step status and note per step as user work on the hosted work store; the route actions unit test calls its status action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/litigation/heads_tab': 'the Heads of Argument add and delete forms save head rows as user work on the hosted work store; the route actions unit test calls its add action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/quantum/payments_tab': 'the Payments add and delete forms save payment rows as user work on the hosted work store; the route actions unit test calls its add action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/registers/annotations_tab': 'the Annotations register\'s save and delete forms store private notes against a document as user work on the hosted work store; the route actions unit test calls its save action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/registers/deadlines_tab': 'the Deadlines register\'s save and delete forms store dated deadlines as user work on the hosted work store; the route actions unit test calls its save action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/registers/disbursements_tab': 'the Disbursements register\'s save and delete forms store dated payee amounts as user work on the hosted work store; the route actions unit test calls its save action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/registers/popia_tab': 'the POPIA register\'s save and delete forms store records of personal-information processing as user work on the hosted work store; the route actions unit test calls its save and delete actions over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/registers/privilege_tab': 'the Privilege register\'s save and delete forms store withheld or redacted documents and their basis as user work on the hosted work store; the route actions unit test calls its save action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/registers/timesheet_tab': 'the Timesheet register\'s save and delete forms store time entries with hours and rate as user work on the hosted work store; the route actions unit test calls its save action over the synthetic D1 double, with no browser or workerd run',
	'/cases/[caseId]/v/[version]/registers/transcriptions_tab': 'the Transcriptions register\'s save and delete forms store hearing transcript text as user work on the hosted work store; the route actions unit test calls its save action over the synthetic D1 double, with no browser or workerd run',
};

/**
 * What drives each HOSTED_FORMS route, by kind, so a reason cannot outlive its evidence (classes-targets.test.ts parses the
 * cited files; a comment, a harness file, a skipped test or a call no enabled test reaches is not evidence):
 *   smoke:     the hosted smoke run names the route in code. The three test-identity routes only, pinned in the test;
 *   unit:      a tracked *.test.ts imports the route `module`, and an enabled test reaches a call of it;
 *   component: as unit, through `via`, a harness whose exported function reaches a call of a `module` handler (through
 *              its handler table), and an enabled test in the test file reaches a call of that export.
 * unit and component run in Vitest over doubles; they are never browser or workerd proof.
 */
const SMOKE_RUN = 'tests/hosted-foundation/runtime/smoke.ts';
export const HOSTED_FORM_EVIDENCE = {
	'/sign-in': { kind: 'smoke', test: SMOKE_RUN },
	'/sign-out': { kind: 'smoke', test: SMOKE_RUN },
	'/cases': { kind: 'smoke', test: SMOKE_RUN },
	'/sign-in/operator': { kind: 'unit', test: 'tests/hosted-foundation/identity/operator-route.test.ts', module: 'deploy/client/routes/sign-in/operator/+page.server.ts' },
	'/cases/[caseId]/notes': { kind: 'unit', test: 'tests/hosted-smoke/case-overview/views-notes.test.ts', module: 'deploy/client/routes/cases/[caseId]/notes/+page.server.ts' },
	'/cases/[caseId]/views/[resultsVersion]/chronology': { kind: 'unit', test: 'tests/hosted-smoke/case-overview/views-notes.test.ts', module: 'deploy/client/routes/cases/[caseId]/views/[resultsVersion]/chronology/+page.server.ts' },
	'/operator/cases/[caseId]/preview/[candidateId]': { kind: 'unit', test: 'tests/hosted-foundation/preview/route.test.ts', module: 'deploy/client/routes/operator/cases/[caseId]/preview/[candidateId]/+page.server.ts' },
	'/cases/[caseId]/v/[version]/analysis/info_required_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/analysis/info_required_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/bundles/caselines_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/bundles/caselines_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/bundles/court_bundle_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/bundles/discovery_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/bundles/discovery_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/doc/[ref]': { kind: 'unit', test: 'tests/hosted-foundation/budget/16-notes.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts' },
	'/cases/[caseId]/v/[version]/evidence/filings_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/evidence/filings_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/litigation/authorities_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/litigation/authorities_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/litigation/crossexam_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/litigation/crossexam_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/litigation/enforcement_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/litigation/enforcement_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/litigation/heads_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/litigation/heads_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/quantum/payments_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/quantum/payments_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/registers/annotations_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/registers/annotations_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/registers/deadlines_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/registers/deadlines_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/registers/disbursements_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/registers/disbursements_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/registers/popia_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/registers/popia_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/registers/privilege_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/registers/privilege_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/registers/timesheet_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/registers/timesheet_tab/+page.server.ts' },
	'/cases/[caseId]/v/[version]/registers/transcriptions_tab': { kind: 'unit', test: 'tests/hosted-foundation/user-work/275-route-actions.test.ts', module: 'deploy/client/routes/cases/[caseId]/v/[version]/registers/transcriptions_tab/+page.server.ts' },
	'/client/intake/[caseId]': {
		kind: 'component',
		test: 'tests/hosted-smoke/intake/adverse.test.ts',
		via: { file: 'tests/hosted-smoke/intake/harness.ts', export: 'dispatch' },
		module: 'deploy/client/routes/client/intake/[caseId]/submissions/+server.ts',
	},
};
