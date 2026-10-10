// The version's path -> ref index for bundle links, from the document-row contract (imported rows and providers).
import { documentRows } from '../../local-case/documents.server.ts';
import type { CaseStore } from '../../local-case/store.server.ts';
import { pathIndex } from './links.ts';

export function bundlePathIndex(store: CaseStore, resultsVersion: string): Map<string, string> {
	return pathIndex(documentRows(store, resultsVersion).rows.map((r) => ({ ref: r.ref, ord: r.ord, originalPath: r.state.original?.path ?? null, url: typeof r.row.url === 'string' ? r.row.url : null })));
}
