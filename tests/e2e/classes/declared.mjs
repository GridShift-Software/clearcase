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
};

/** Per route and action (`?/add`): classes that do not apply, with why. */
export const NOT_APPLICABLE = {
	'/import ?/import': {
		inflight: 'Validate opens the report page of the new import; it is a request, not a save of typed work',
		nojs: 'Validate writes no user work, so a busy work store cannot refuse it; a refused path is re-rendered by the pilot suite',
		dialog: 'Validate writes no user work and no question guards the form',
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
	'/import': 'outside a case version there is no case navigation to leave by and come back',
	'/import/[id]': 'outside a case version there is no case navigation to leave by and come back',
	'/recovery': 'outside a case version there is no case navigation to leave by and come back',
};

/** Files that hand content to the user (download, Content-Disposition, an object URL, <a download>) but that are CSV helpers, not producers. */
export const HELPERS = {
	'src/lib/components/csv.ts': 'the CSV helper itself: toCSV, userCell and `download`',
	'src/lib/case-package/media.ts': 'a table of media types for package files',
};

/** Files that hand content to the user and do not produce CSV, with what they do. Checked: none may carry a CSV mark. */
export const NOT_PRODUCERS = {
	'src/lib/components/OriginalOpen.svelte': 'links to an original (bytes of the case file)',
	'src/lib/local-case/originals.server.ts': 'serves original bytes with Content-Disposition',
	'src/lib/views/bundles/Builder.svelte': 'bundle index as PDF and DOCX',
	'src/lib/views/bundles/caselines.ts': 'a link to a bundle file',
	'src/lib/views/bundles/download.ts': 'the blob download helper of the bundles (HTML, DOCX, PDF)',
	'src/lib/views/bundles/links.server.ts': 'download links to bundle files',
	'src/routes/v/[vid]/bundles/caselines_tab/+page.svelte': 'downloads of bundle files and session uploads',
	'src/routes/v/[vid]/bundles/court_bundle_tab/+page.svelte': 'bundle indexes as DOCX',
	'src/routes/v/[vid]/bundles/discovery_tab/+page.svelte': 'cover and index as HTML',
	'src/routes/v/[vid]/doc/[ref]/+page.svelte': 'download links to the document\'s original and its attachments',
	'src/routes/v/[vid]/system/backup_tab/+page.svelte': 'link to the JSON backup',
	'src/routes/v/[vid]/system/backup_tab/download/+server.ts': 'the JSON backup (application/json)',
	'src/routes/v/[vid]/system/rescan_tab/+page.svelte': 'link to the JSON index',
	'src/routes/v/[vid]/system/rescan_tab/index.json/+server.ts': 'the JSON index (application/json)',
};

/**
 * Downloads a CSV page makes that are not CSV, by the downloaded file's name. A page that also exports a .csv is still
 * checked on that file; a page whose only downloads are these is checked for none.
 */
export const NON_CSV_DOWNLOADS = {
	'.ics': 'an iCalendar file, not CSV; the registers suite checks its TEXT escaping (SC4, SC18)',
	'.txt': 'a plain-text outline (the Heads of Argument export), not CSV',
};
