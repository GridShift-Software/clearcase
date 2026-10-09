// Info Required (GRS-15): the imported checklist plus the operator's "done" flags. v5 keyed the flags by array index
// into the imported list (`ess_dcs_info_done_v1` = {"<index>": bool}, S-index-keys / S-info_required_tab-1), so a
// later results version that reorders the list moved them. Here each flag is a register row (store
// `info-required`) whose row id is a stable identity of the item: a digest of its text, plus an occurrence number
// when the same text appears more than once. Status and owner may change between versions without detaching the
// flag; a changed item text detaches it (it is reported, never re-attached by similarity). Imported rows are never
// written.
import { createHash } from 'node:crypto';
import type { UserWork } from '../local-case/user-work.server.ts';

export const INFO_STORE = 'info-required';

export interface InfoItem { item: string; owner: string; status: string }
export interface InfoRow extends InfoItem { key: string; done: boolean }

/** Stable row ids for the imported items, in data order. */
export function itemKeys(items: readonly InfoItem[]): string[] {
	const seen = new Map<string, number>();
	return items.map((it) => {
		const base = `info:${createHash('sha256').update(it.item, 'utf8').digest('hex').slice(0, 32)}`;
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		return n > 1 ? `${base}#${n}` : base;
	});
}

/** The checklist with each item's saved flag, and how many saved flags belong to items not in this version. */
export function infoRows(uw: UserWork, caseId: string, items: readonly InfoItem[]): { rows: InfoRow[]; detached: number } {
	const saved = new Map(uw.listRows(caseId, INFO_STORE).map((r) => [r.rowId, r.fields.done === true]));
	const keys = itemKeys(items);
	const rows = items.map((it, i) => ({ key: keys[i]!, item: it.item, owner: it.owner, status: it.status, done: saved.get(keys[i]!) ?? false }));
	const here = new Set(keys);
	return { rows, detached: [...saved.keys()].filter((k) => !here.has(k)).length };
}

/** Save one item's flag (false is stored, as v5 stores it). Throws what putRow throws (503 when the store is busy). */
export async function saveDone(uw: UserWork, caseId: string, resultsVersion: string, items: readonly InfoItem[], key: string, done: boolean): Promise<boolean> {
	const i = itemKeys(items).indexOf(key);
	if (i < 0) return false;
	await uw.putRow(caseId, INFO_STORE, key, { item: items[i]!.item, done, resultsVersion });
	return true;
}
