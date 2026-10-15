import type { Cell } from '../../components/csv.ts';

export interface ContractItem { ref: string; date: string; title: string; note: string; text_status: string; url: string; doc_type?: string; party?: string; role?: string }
export interface ContractGroup { key: string; items: ContractItem[] }
export interface ContractsData { count: number; groups: ContractGroup[] }

const SIGNED = '(?:counter)?signed|executed|finali[sz]ed';
const NEGATED = new RegExp(`(?:\\b(?:not|never|no|without)|n['’]t|\\byet\\s+to)(?:[\\s-]+[a-z]+){0,3}?[\\s-]+(?:${SIGNED}|final|execution)\\b`, 'i');
const POSITIVE = new RegExp(`\\b(?:${SIGNED}|final|execution)\\b`, 'i');
export function signedChip(x: Pick<ContractItem, 'title' | 'note'>): 'signed' | 'unsigned' | '—' {
	const t = `${x.title ?? ''} ${x.note ?? ''}`;
	if (/\bunsigned\b/i.test(t)) return 'unsigned';
	if (NEGATED.test(t)) return '—';
	return POSITIVE.test(t) ? 'signed' : '—';
}

export function contractsCsvRows(groups: readonly ContractGroup[]): Cell[][] {
	return [['group', 'ref', 'date', 'title', 'note', 'text_status', 'url'], ...groups.flatMap((g) => g.items.map((x) => [g.key, x.ref, x.date, x.title, x.note, x.text_status, x.url]))];
}
