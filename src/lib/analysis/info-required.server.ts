import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { UserWorkError, type UserWork } from '../local-case/user-work.server.ts';
import { inTurn } from '../local-case/registers.server.ts';

export const INFO_STORE = 'info-required';

export interface InfoItem { item: string; owner: string; status: string }
export interface InfoRow extends InfoItem { key: string; done: boolean }

const digest = (parts: readonly string[], n: number) => createHash('sha256').update(JSON.stringify(parts.map((p) => p.normalize('NFC'))), 'utf8').digest('hex').slice(0, n);
const textKey = (it: InfoItem) => `info:${createHash('sha256').update(it.item.normalize('NFC'), 'utf8').digest('hex').slice(0, 32)}`;

export function itemKeys(items: readonly InfoItem[]): string[] {
	const byText = new Map<string, number[]>();
	items.forEach((it, i) => { const k = textKey(it); byText.set(k, [...(byText.get(k) ?? []), i]); });
	const keys = items.map(textKey);
	for (const [base, at] of byText) {
		if (at.length < 2) continue;
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

export function infoRows(uw: UserWork, caseId: string, items: readonly InfoItem[]): { rows: InfoRow[]; detached: number } {
	const saved = new Map(uw.listRows(caseId, INFO_STORE).map((r) => [r.rowId, r.fields.done === true]));
	const keys = itemKeys(items);
	const rows = items.map((it, i) => ({ key: keys[i]!, item: it.item, owner: it.owner, status: it.status, done: saved.get(keys[i]!) ?? false }));
	const here = new Set(keys);
	return { rows, detached: [...saved].filter(([k, done]) => done && !here.has(k)).length };
}

export async function saveDone(uw: UserWork, caseId: string, resultsVersion: string, items: readonly InfoItem[], key: string, done: boolean): Promise<boolean> {
	const i = itemKeys(items).indexOf(key);
	if (i < 0) return false;
	try {
		await inTurn(uw, caseId, INFO_STORE, () => uw.putRow(caseId, INFO_STORE, key, { item: items[i]!.item, done, resultsVersion }));
	} catch (e) {
		if (e instanceof UserWorkError) error(413, 'this item’s text is too long to store its check (over 64 KiB).');
		throw e;
	}
	return true;
}
