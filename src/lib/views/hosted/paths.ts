// The hosted case routes' addresses, one place for the server loads and the pages. Every segment is encoded.
const enc = encodeURIComponent;
export const caseHref = (caseId: string) => `/cases/${enc(caseId)}`;
export const chronologyHref = (caseId: string, resultsVersion: string) => `${caseHref(caseId)}/views/${enc(resultsVersion)}/chronology`;
export const notesHref = (caseId: string) => `${caseHref(caseId)}/notes`;
export const originalHref = (caseId: string, assetId: string) => `${caseHref(caseId)}/originals/${enc(assetId)}`;
