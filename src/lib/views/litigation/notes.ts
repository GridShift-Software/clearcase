
export const ANALYSIS_NOTE = 'Supplied analysis from the imported results package, shown as supplied. ClearCase has not verified it: check each legal assertion and authority before relying on it.';

export const OWN_ROWS_NOTE = 'Rows you add are your own work, kept on this computer.';

export const conflictScope = (people: number, entities: number) =>
	`Searches only this matter's ${people} ${people === 1 ? 'person' : 'people'} and ${entities} ${entities === 1 ? 'entity' : 'entities'} from the imported results package. A match, or no match, is not a conflict clearance.`;

export const CONFLICT_NOTE = 'Parties and correspondents as listed in the imported results package, compared as supplied. ClearCase has not checked that the list is complete: search your firm\'s own conflict records as well.';
