// Contracts (v5 contracts_tab, L2584-2607): the imported contract groups with a Signed marker. Browser-safe and pure.
import type { Cell } from '../../components/csv.ts';

export interface ContractItem { ref: string; date: string; title: string; note: string; text_status: string; url: string; doc_type?: string; party?: string; role?: string }
export interface ContractGroup { key: string; items: ContractItem[] }
export interface ContractsData { count: number; groups: ContractGroup[] }

/**
 * The Signed marker, read from the title and note as words (S-contracts_tab-1, corrected). v5 tested 'unsigned' in the
 * note only and /sign|final|execut/ anywhere in title+note glued together, so 'assignment', 'designated', 'signature'
 * or an 'unsigned' title read as signed. It stays a heuristic over imported text, never a verified execution status.
 */
export function signedChip(x: Pick<ContractItem, 'title' | 'note'>): 'signed' | 'unsigned' | '—' {
	const t = `${x.title ?? ''} ${x.note ?? ''}`;
	if (/\bunsigned\b/i.test(t)) return 'unsigned';
	return /\b(signed|final|executed|execution)\b/i.test(t) ? 'signed' : '—';
}

/** v5 ess_dcs_contracts.csv columns (L2605-2607): every item of every group, imported values unchanged. */
export function contractsCsvRows(groups: readonly ContractGroup[]): Cell[][] {
	return [['group', 'ref', 'date', 'title', 'note', 'text_status', 'url'], ...groups.flatMap((g) => g.items.map((x) => [g.key, x.ref, x.date, x.title, x.note, x.text_status, x.url]))];
}
