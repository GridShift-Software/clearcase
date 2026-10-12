// What the UI class suite (GRS-59) cannot find out from the page itself: why a class does not apply to a target the
// app's definitions name (targets.mjs), and the inputs a page needs before its export holds rows. A target missing
// here gets the generic drive; when that drive finds nothing to act on, its scenario fails and names this file.
//
// Keys are route ids (src/routes/...). Classes: inflight, nojs, dialog, csv, narrow, back.

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

/** Exports that are not CSV, with why. */
export const NOT_CSV = {
	'/v/[vid]/registers/deadlines_tab': 'exports an iCalendar file (.ics), not CSV; the registers suite checks its TEXT escaping (SC4, SC18)',
	'/v/[vid]/litigation/heads_tab': 'exports a plain-text outline (text/plain), not CSV',
};

/** The query a page needs before its export holds rows. */
export const QUERY = {};
