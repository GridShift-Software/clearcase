import type { ChronologyListRow } from '../../local-case/model.ts';

/** One searchable document: the list fields search reads, with `cc`. */
export type SearchRow = Pick<ChronologyListRow, 'ref' | 'subject' | 'filename' | 'sender' | 'to' | 'date' | 'bundle' | 'docType' | 'excerpt'> & { cc: string };

/** `search.json` */
export interface SearchShard {
	rows: SearchRow[];
}
