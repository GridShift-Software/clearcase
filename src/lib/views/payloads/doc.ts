import type { PageServerData as DocData } from '../../../routes/v/[vid]/doc/[ref]/$types';

/** How the document's own original can be opened: stored as a file, missing, or carried inside its parent. */
export type OriginalState = 'available' | 'missing' | 'embedded';

/**
 * `doc/<ref>.json`: the document page without original links and notes. Attachments carry `hasDocument`, and asset ids
 * stand in for links, so the page asks for links in one call rather than one per attachment.
 */
export interface DocShard extends Pick<DocData, 'ref' | 'source' | 'fields' | 'state' | 'children' | 'related' | 'parent'> {
	attachments: Omit<DocData['attachments'][number], 'links'>[];
	assetIds: { own: string | null; attachments: string[] };
	mediaType: string | null;
	originalState: OriginalState;
}
