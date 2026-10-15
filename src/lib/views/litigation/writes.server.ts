import { registers, type VersionedRow, type Work } from '../../local-case/registers.server.ts';
import type { RegisterValue } from '../../local-case/user-work.server.ts';

export type { Work };
export type StatusResult = 'saved' | 'stale';

const text = (v: RegisterValue | undefined) => (v === null || v === undefined ? '' : String(v));

export const stepRows = (rows: readonly VersionedRow[], stepKey: string) => rows.filter((r) => text(r.fields.stepKey) === stepKey);

export const stepVersion = (rows: readonly VersionedRow[]) => (rows.length ? rows.map((r) => `${r.rowId}.${r.version}`).join(' ') : 'none');

export function saveStatus(w: Work, caseId: string, store: string, stepKey: string, status: string, version: string | null): Promise<StatusResult> {
	return registers(w).open(caseId, store).batch(async (tx) => {
		const mine = stepRows(tx.rows(), stepKey);
		if (version !== null && stepVersion(mine) !== version) return 'stale';
		const keep = mine.at(-1);
		if (keep) await tx.replace(keep.rowId, null, { stepKey, status }); else await tx.add({ stepKey, status });
		for (const r of mine.slice(0, -1)) await tx.remove(r.rowId, null);
		return 'saved';
	});
}
