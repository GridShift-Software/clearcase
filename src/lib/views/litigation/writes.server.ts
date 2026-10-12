// The enforcement status save of CC-08 (GRS-18 r2), on the register store (local-case/registers.server.ts, GRS-52),
// which also takes every other litigation write: register Adds, row Deletes and cross-exam seed deletions. A save
// carries the version of the step as the page showed it (sent as a hidden field, so it also works without JavaScript)
// and is re-checked in the store's queue, just before the write: a step changed since is refused ('stale').
import { registers, type VersionedRow, type Work } from '../../local-case/registers.server.ts';
import type { RegisterValue } from '../../local-case/user-work.server.ts';

export type { Work };
export type StatusResult = 'saved' | 'stale';

const text = (v: RegisterValue | undefined) => (v === null || v === undefined ? '' : String(v));

/** A step's stored status rows of a store's rows (in insertion order): one at most once this round's save has run; older stores may hold more. */
export const stepRows = (rows: readonly VersionedRow[], stepKey: string) => rows.filter((r) => text(r.fields.stepKey) === stepKey);

/** A step's version: its stored status rows and their versions, or `none` when it has no stored status. */
export const stepVersion = (rows: readonly VersionedRow[]) => (rows.length ? rows.map((r) => `${r.rowId}.${r.version}`).join(' ') : 'none');

/**
 * Save a step's status over the imported one, against the step version the page showed (null: no check). One row per
 * step key whatever its status ('' included): the latest row is replaced, keeping its place, and any older row for the
 * key (written before this round) is removed; a first save adds a row. One step of the store's queue.
 */
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
