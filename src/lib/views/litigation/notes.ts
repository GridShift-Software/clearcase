// Generic scope wording for the litigation views (UI chrome: no case content). Browser-safe.

/** Every `lit-*` dataset is authored analysis supplied with the results package (docs/results-package.md). */
export const ANALYSIS_NOTE = 'Supplied analysis from the imported results package, shown as supplied. ClearCase has not verified it: check each legal assertion and authority before relying on it.';

/** A register's second paragraph: it also holds the user's own entries. */
export const OWN_ROWS_NOTE = 'Rows you add are your own work, kept on this computer.';

/** Conflict Check's scope (acceptance): what was searched, with counts from the data, and what a result is not. */
export const conflictScope = (people: number, entities: number) =>
	`Searches only this matter's ${people} ${people === 1 ? 'person' : 'people'} and ${entities} ${entities === 1 ? 'entity' : 'entities'} from the imported results package. A match, or no match, is not a conflict clearance.`;

/** Conflict Check's source note (GRS-18 r2, D20): where the parties come from, without repeating the scope line. */
export const CONFLICT_NOTE = 'Parties and correspondents as listed in the imported results package, compared as supplied. ClearCase has not checked that the list is complete: search your firm\'s own conflict records as well.';
