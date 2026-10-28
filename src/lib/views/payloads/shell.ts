import type { LayoutServerData } from '../../../routes/v/[vid]/$types';

/** `shell.json`: the `[vid]` layout's version record and the document count. */
export interface ShellShard {
	version: LayoutServerData['version'];
	documents: number;
}
