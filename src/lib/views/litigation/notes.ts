// Generic scope wording for the litigation views (UI chrome: no case content). Browser-safe.

/** Every `lit-*` dataset is authored analysis supplied with the results package (docs/results-package.md). */
export const ANALYSIS_NOTE = 'Supplied analysis from the imported results package, shown as supplied. ClearCase has not verified it: check each legal assertion and authority before relying on it.';

/** The same, for a register that also holds the user's own entries. */
export const REGISTER_NOTE = `${ANALYSIS_NOTE} Rows you add are your own work, kept on this computer.`;

/** Conflict Check's scope (acceptance): what was searched, with counts from the data, and what a result is not. */
export const conflictScope = (people: number, entities: number) =>
	`Searches only this matter's ${people} ${people === 1 ? 'person' : 'people'} and ${entities} ${entities === 1 ? 'entity' : 'entities'} from the imported results package. A match, or no match, is not a conflict clearance.`;
