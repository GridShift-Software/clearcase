// Info Required (GRS-15): the imported checklist plus the operator's "done" flags. v5 keyed the flags by array index
// into the imported list (`ess_dcs_info_done_v1` = {"<index>": bool}, S-index-keys / S-info_required_tab-1), so a
// later results version that reorders the list moved them. Here each flag is a register row (store
// `info-required`) whose row id is a stable identity of the item: a digest of its text (NFC). Status and owner may
// change between versions without detaching the flag of a text that appears once; a changed item text detaches it (it
// is reported, never re-attached by similarity). A text that appears more than once is told apart by its owner, then
// by owner and status; repeats that still match in all three are numbered within that count. So a flag never moves to
// another item: when the repeats of a text change (one reworded, removed or added, or an owner changed), their keys
// change and their flags detach. Imported rows are never written.
import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { UserWorkError, type UserWork } from '../local-case/user-work.server.ts';

export const INFO_STORE = 'info-required';

export interface InfoItem { item: string; owner: string; status: string }
export interface InfoRow extends InfoItem { key: string; done: boolean }

const digest = (parts: readonly string[], n: number) => createHash('sha256').update(JSON.stringify(parts.map((p) => p.normalize('NFC'))), 'utf8').digest('hex').slice(0, n);
const textKey = (it: InfoItem) => `info:${createHash('sha256').update(it.item.normalize('NFC'), 'utf8').digest('hex').slice(0, 32)}`;

/** Stable row ids for the imported items, in data order. */
export function itemKeys(items: readonly InfoItem[]): string[] {
	const byText = new Map<string, number[]>();
	items.forEach((it, i) => { const k = textKey(it); byText.set(k, [...(byText.get(k) ?? []), i]); });
	const keys = items.map(textKey);
	for (const [base, at] of byText) {
		if (at.length < 2) continue;
		// the coarsest identity that tells every repeat of this text apart; otherwise number the identical ones
		const ownerOnly = at.map((i) => digest([items[i]!.owner], 16));
		const ownerStatus = at.map((i) => digest([items[i]!.owner, items[i]!.status], 16));
		const distinct = (ids: string[]) => new Set(ids).size === ids.length;
		const ids = distinct(ownerOnly) ? ownerOnly : distinct(ownerStatus) ? ownerStatus.map((d) => `s${d}`) : null;
		if (ids) { at.forEach((i, j) => { keys[i] = `${base}@${ids[j]}`; }); continue; }
		const seen = new Map<string, number>();
		const count = new Map<string, number>();
		for (const d of ownerStatus) count.set(d, (count.get(d) ?? 0) + 1);
		at.forEach((i, j) => {
			const d = ownerStatus[j]!;
			const n = (seen.get(d) ?? 0) + 1;
			seen.set(d, n);
			keys[i] = count.get(d)! > 1 ? `${base}@s${d}#${n}of${count.get(d)}` : `${base}@s${d}`;
		});
	}
	return keys;
}

/** The checklist with each item's saved flag, and how many saved checks (done) belong to items not in this version. */
export function infoRows(uw: UserWork, caseId: string, items: readonly InfoItem[]): { rows: InfoRow[]; detached: number } {
	const saved = new Map(uw.listRows(caseId, INFO_STORE).map((r) => [r.rowId, r.fields.done === true]));
	const keys = itemKeys(items);
	const rows = items.map((it, i) => ({ key: keys[i]!, item: it.item, owner: it.owner, status: it.status, done: saved.get(keys[i]!) ?? false }));
	const here = new Set(keys);
	return { rows, detached: [...saved].filter(([k, done]) => done && !here.has(k)).length };
}

/**
 * Save one item's flag (false is stored, as v5 stores it). Throws what putRow throws (503 when the store is busy), and
 * 413 when the item's text is too long to store with its flag.
 */
export async function saveDone(uw: UserWork, caseId: string, resultsVersion: string, items: readonly InfoItem[], key: string, done: boolean): Promise<boolean> {
	const i = itemKeys(items).indexOf(key);
	if (i < 0) return false;
	try {
		await uw.putRow(caseId, INFO_STORE, key, { item: items[i]!.item, done, resultsVersion });
	} catch (e) {
		if (e instanceof UserWorkError) error(413, 'this item’s text is too long to store its check (over 64 KiB).');
		throw e;
	}
	return true;
}
