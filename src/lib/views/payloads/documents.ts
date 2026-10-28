import type { DocumentsModel } from '../evidence/documents.ts';

/**
 * `documents/default.json`: the documents list as the unfiltered request answers it (first bundle, page 1, no filter),
 * built once at publication so the default page costs one shard read. A bundle, a filter text or another page is
 * answered from the list pages (`list/page-<n>.json`).
 */
export interface DocumentsDefaultShard {
	total: number;
	model: DocumentsModel;
}
