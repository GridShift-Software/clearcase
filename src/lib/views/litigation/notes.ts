
export const ANALYSIS_NOTE = 'Supplied analysis from the imported results package, shown as supplied. ClearCase has not verified it: check each legal assertion and authority before relying on it.';

export const OWN_ROWS_NOTE = 'Rows you add are your own work, kept on this computer.';
/** OWN_ROWS_NOTE on hosted, where the case's added rows are kept in its store on the server. */
export const HOSTED_ROWS_NOTE = 'Rows added here are your own work on this case, saved on the server.';

export const conflictScope = (people: number, entities: number) =>
	`Searches only this matter's ${people} ${people === 1 ? 'person' : 'people'} and ${entities} ${entities === 1 ? 'entity' : 'entities'} from the imported results package. A match, or no match, is not a conflict clearance.`;

export const CONFLICT_NOTE = 'Parties and correspondents as listed in the imported results package, compared as supplied. ClearCase has not checked that the list is complete: search your firm\'s own conflict records as well.';
