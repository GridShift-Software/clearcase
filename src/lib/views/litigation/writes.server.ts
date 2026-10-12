// Every CC-08 write (GRS-18 r2) runs through one in-process queue per case and store (serial.ts): register Adds, row
// Deletes, cross-exam seed overlays and enforcement status saves. A write that targets a stored row carries the
// version of that row as the page showed it (a hash of its stored fields, sent as a hidden field so it also works
// without JavaScript) and is re-checked inside the queue, just before the write: a row changed since is refused
// ('stale'), a row already gone is reported ('gone') and never re-created. `seq` is computed inside the queue, just
// before the insert. The version is a hash of the fields, never updatedAt, which a fixed clock never changes.
//
// One server process serves a data directory. A write outside this queue (a restore, an import, another process on
// the same directory) can still land between the re-check and the write's own transaction: see the report's
// "remaining window" and the shared-file request for a conditional putRow/deleteRow/putSeedOverlay.
import { createHash } from 'node:crypto';
import type { SeedView } from '../../case-package/browser.ts';
import type { RegisterRow, RegisterValue, UserWork } from '../../local-case/user-work.server.ts';
import { isDeleted } from './crossexam.ts';
import { serialized } from './serial.ts';

export type Work = Pick<UserWork, 'listRows' | 'putRow' | 'deleteRow' | 'seedViews' | 'putSeedOverlay'>;

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
const keyOf = (caseId: string, store: string) => `${caseId}\u0000${store}`;
const seqOf = (r: RegisterRow): number | null => (typeof r.fields.seq === 'number' && Number.isFinite(r.fields.seq) ? r.fields.seq : null);
const text = (v: RegisterValue | undefined) => (v === null || v === undefined ? '' : String(v));
const bySeq = (a: RegisterRow, b: RegisterRow) => (seqOf(a) ?? Number.MAX_SAFE_INTEGER) - (seqOf(b) ?? Number.MAX_SAFE_INTEGER) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.rowId < b.rowId ? -1 : 1);

/** The next `seq` of a store: one more than the largest stored. */
export const nextSeq = (rows: readonly RegisterRow[]) => rows.reduce((m, r) => Math.max(m, seqOf(r) ?? 0), 0) + 1;

/** A register row's version: a hash of its stored fields (seq included), which changes whenever they do. */
export const rowVersion = (r: Pick<RegisterRow, 'fields'>) => digest(['row', r.fields]);

/** An imported topic's version: its seed content and the user's overlay on it (none, or base and fields). */
export const seedVersion = (v: SeedView) => digest(['seed', v.state === 'orphaned' ? null : v.seed.seedSha256, v.state === 'seed' ? null : [v.overlay.baseSeedSha256, v.overlay.fields]]);

/** A step's stored status rows, oldest first by seq (one at most once this round's save has run; older stores may hold more). */
export const stepRows = (rows: readonly RegisterRow[], stepKey: string) => rows.filter((r) => text(r.fields.stepKey) === stepKey).sort(bySeq);

/** A step's version: its stored status rows, or `none` when it has no stored status. */
export const stepVersion = (rows: readonly RegisterRow[]) => (rows.length ? digest(['step', rows.map((r) => [r.rowId, r.fields])]) : 'none');

export type AddResult = { rowId: string; repeated: boolean };
export type DeleteResult = 'deleted' | 'gone' | 'stale';
export type StatusResult = 'saved' | 'stale';

// Adds seen per store, by the form's one-time add id and the fields sent: a second post of the same form (a double
// press without JavaScript, a retry of a request that did arrive) answers with the row the first one stored.
const recent = new WeakMap<object, Map<string, string>>();
const RECENT_MAX = 500;

/** Insert a register row with the next `seq`, computed in the queue. `addId` (the form's) makes a repeat of one post store nothing. */
export function addEntry(w: Work, caseId: string, store: string, fields: Record<string, RegisterValue>, addId: string | null = null): Promise<AddResult> {
	return serialized(keyOf(caseId, store), async () => {
		let seen = recent.get(w);
		if (!seen) recent.set(w, (seen = new Map()));
		const tag = addId ? digest([caseId, store, addId, fields]) : null;
		const prior = tag ? seen.get(tag) : undefined;
		if (prior && w.listRows(caseId, store).some((r) => r.rowId === prior)) return { rowId: prior, repeated: true };
		const rowId = await w.putRow(caseId, store, null, { ...fields, seq: nextSeq(w.listRows(caseId, store)) });
		if (tag) {
			seen.set(tag, rowId);
			if (seen.size > RECENT_MAX) seen.delete(seen.keys().next().value!);
		}
		return { rowId, repeated: false };
	});
}

/** Delete a register row the page showed at `version` (null: no check, a scripted post). */
export function deleteEntry(w: Work, caseId: string, store: string, rowId: string, version: string | null): Promise<DeleteResult> {
	return serialized(keyOf(caseId, store), async () => {
		const cur = w.listRows(caseId, store).find((r) => r.rowId === rowId);
		if (!cur) return 'gone';
		if (version !== null && rowVersion(cur) !== version) return 'stale';
		return (await w.deleteRow(caseId, store, rowId)) ? 'deleted' : 'gone';
	});
}

/**
 * Delete an imported topic: an overlay `{deleted: true}` made against its current content (results are never
 * changed). 'absent' when this version has no such topic; 'gone' when the user's deletion is already in place.
 */
export function deleteSeed(w: Work, caseId: string, resultsVersion: string, datasetKey: string, seedId: string, version: string | null): Promise<DeleteResult | 'absent'> {
	return serialized(keyOf(caseId, `seed\u0000${datasetKey}`), async () => {
		const sv = w.seedViews(caseId, resultsVersion, datasetKey).find((x) => (x.state === 'orphaned' ? x.overlay.seedId : x.seed.seedId) === seedId);
		if (!sv) return 'absent';
		if ((sv.state === 'edited' || sv.state === 'orphaned') && isDeleted(sv.overlay.fields)) return 'gone';
		if (version !== null && seedVersion(sv) !== version) return 'stale';
		await w.putSeedOverlay({ caseId, datasetKey, seedId, baseSeedSha256: sv.state === 'orphaned' ? sv.overlay.baseSeedSha256 : sv.seed.seedSha256, fields: { deleted: true } });
		return 'deleted';
	});
}

/**
 * Save a step's status over the imported one, against the step version the page showed (null: no check). One row per
 * step key whatever its status ('' included): the latest row by seq is replaced, keeping its seq, and any older row
 * for the key (written before this round) is removed; a first save inserts with the next seq.
 */
export function saveStatus(w: Work, caseId: string, store: string, stepKey: string, status: string, version: string | null): Promise<StatusResult> {
	return serialized(keyOf(caseId, store), async () => {
		const all = w.listRows(caseId, store);
		const mine = stepRows(all, stepKey);
		if (version !== null && stepVersion(mine) !== version) return 'stale';
		const keep = mine.at(-1) ?? null;
		await w.putRow(caseId, store, keep?.rowId ?? null, { stepKey, status, seq: (keep && seqOf(keep)) ?? nextSeq(all) });
		for (const r of mine.slice(0, -1)) await w.deleteRow(caseId, store, r.rowId);
		return 'saved';
	});
}
