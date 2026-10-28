// The actions of the filings register over a `FilingsPort` (sprint ticket 17b): the local page passes the local work store
// (`filings.server.ts`), the hosted route the user-work adapter (`filings-hosted.server.ts`). A sibling of `filings.server.ts`
// rather than part of it because that file reaches the local app, which the hosted import graph forbids.
import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { deleteStep } from '../../components/confirm-delete.ts';
import { formAddId, type Fields } from '../litigation/answers.server.ts';
import { SAVE_FAILURES, asFields, formFields, nextSeq, registerEntries, rowVersion, saveFailure, type RegisterEntry, type SaveFailure, type SeedViewLike, type UserRowLike } from './filings.ts';

export interface FilingsRead {
	seeds: readonly SeedViewLike[];
	rows: readonly UserRowLike[];
	/** the overlays kept for this register's seeds, for the base digest of an edit of an imported row that is no longer in the version */
	overlays: readonly { seedId: string; baseSeedSha256: string }[];
}

/** What the register's actions ask of a store. A write answers `null` when it is made, else why it was not. */
export interface FilingsPort {
	caseId: string;
	/** Runs a read-check-write against the register one at a time (the local store); the hosted store's versions refuse the loser instead. */
	queued<T>(fn: () => Promise<T>): Promise<T>;
	rows(): Promise<readonly UserRowLike[]>;
	read(): Promise<FilingsRead>;
	addRow(fields: Fields, addId: string | null): Promise<void>;
	putRow(rowId: string, fields: Fields): Promise<void>;
	putOverlay(seedId: string, baseSeedSha256: string, fields: Fields): Promise<void>;
	deleteRow(rowId: string): Promise<void>;
	/** The version a page names for an entry's Delete: the local fields digest, or the store's version of the row or overlay (`none` for an imported row as imported). */
	deleteVersion(entry: RegisterEntry): string;
	/** The hosted store refuses a delete that names no version; a scripted local post that names none still deletes. */
	requireDeleteVersion: boolean;
	/** Refuses a URL that is not the current publication, for a write that rests on an imported row (a no-op locally). */
	published(): Promise<void>;
	/** The status a failed write answers: 503 when the store is busy or unavailable, 409 when the row changed under the write. */
	statusOf(e: unknown): 503 | 409 | 500;
}
/** A port is made before the form is read, so a hosted one can refuse a viewer first; null is an unknown version. */
export type FilingsPortOf = (event: Pick<RequestEvent, 'params' | 'locals'>) => FilingsPort | null | Promise<FilingsPort | null>;

/** What a save or delete of `key` reads: a row of the register needs the register alone, an imported row needs the seeds as well. */
const readFor = async (port: FilingsPort, key: string): Promise<FilingsRead> => (key.startsWith('row:') ? { seeds: [], rows: await port.rows(), overlays: [] } : port.read());

type Draft = { values: Record<string, string>; editing: string | null; version: string | null; failed: SaveFailure | null };
const draftOf = (fd: FormData): Draft => {
	const key = fd.get('key'), version = fd.get('version');
	return { values: formFields((k) => fd.get(k)).values, editing: typeof key === 'string' && key ? key : null, version: typeof version === 'string' && version ? version : null, failed: saveFailure(fd.get('failed')) };
};
const refuse = (status: number, code: SaveFailure, values: Record<string, string>, editing: string | null, version: string | null = null) =>
	fail(status, { op: 'save' as const, code, values, editing, version, message: SAVE_FAILURES[code].message, retry: SAVE_FAILURES[code].retry });
const DELETE_BUSY = 'The entry could not be deleted: the local store is busy or unavailable. Nothing was changed and the entry is still in the register; try again.';
const DELETE_GONE = 'That register row no longer exists; nothing was deleted.';

async function write(port: FilingsPort, fn: () => Promise<unknown>): Promise<number | null> {
	try {
		await fn();
		return null;
	} catch (e) {
		return port.statusOf(e);
	}
}

export const filingsActionsOver = (portOf: FilingsPortOf) => ({
	add: async (e: RequestEvent) => {
		const port = await portOf(e);
		const fd = await e.request.formData();
		const typed = formFields((k) => fd.get(k));
		if (!port) return refuse(404, 'version', typed.values, null);
		if (!typed.ok) return refuse(400, 'empty-add', typed.values, null);
		const status = await port.queued(async () => write(port, async () => port.addRow({ seq: nextSeq(await port.rows()), ...typed.values, status: '' }, formAddId(fd))));
		return status ? refuse(status, 'busy', typed.values, null) : { op: 'add' as const, saved: true };
	},
	save: async (e: RequestEvent) => {
		const port = await portOf(e);
		const fd = await e.request.formData();
		const key = String(fd.get('key') ?? '');
		const seen = typeof fd.get('version') === 'string' ? String(fd.get('version')) : null;
		const typed = formFields((k) => fd.get(k));
		if (!port) return refuse(404, 'version', typed.values, key || null, seen);
		if (!typed.ok) return refuse(400, 'empty-edit', typed.values, key, seen);
		if (key.startsWith('seed:')) await port.published();
		const outcome = await port.queued(async () => {
			const { seeds, rows, overlays } = await readFor(port, key);
			const entry = registerEntries(seeds, rows).find((x) => x.key === key);
			if (!entry) return 'gone' as const;
			if (seen !== rowVersion(entry.fields)) return 'stale' as const;
			const kept = { ...typed.values, status: entry.fields.status };
			return write(port, async () => {
				if (key.startsWith('row:')) {
					const row = rows.find((r) => `row:${r.rowId}` === key)!;
					await port.putRow(row.rowId, { ...row.fields, ...kept });
				} else {
					const seedId = key.slice('seed:'.length);
					const s = seeds.find((x) => (x.state === 'orphaned' ? x.overlay.seedId : x.seed.seedId) === seedId)!;
					const base = s.state === 'orphaned' ? (overlays.find((o) => o.seedId === seedId)?.baseSeedSha256 ?? '') : s.seed.seedSha256;
					await port.putOverlay(seedId, base, { ...asFields(kept), deleted: false });
				}
			});
		});
		if (outcome === 'gone') return refuse(404, 'gone', typed.values, key, seen);
		if (outcome === 'stale' || outcome === 409) return refuse(409, 'stale', typed.values, key, seen);
		if (outcome) return refuse(outcome, 'busy', typed.values, key, seen);
		redirect(303, e.url.pathname);
	},
	delete: async (e: RequestEvent) => {
		const port = await portOf(e);
		const fd = await e.request.formData();
		const draft = draftOf(fd);
		const target = String(fd.get('delete') ?? '');
		if (!port) return fail(404, { op: 'delete' as const, target, message: 'Unknown results version: nothing was deleted.', draft });
		// a Delete that is not confirmed deletes nothing: the page asks (or, after Cancel, shows the draft again)
		const step = deleteStep(fd, target);
		if (step !== 'confirm') return fail(400, { op: 'delete' as const, target, confirm: step === 'ask' ? target : null, draft });
		if (target.startsWith('seed:')) await port.published();
		// the version the Delete button showed for this entry, independent of the edit draft's own `version`
		const shown = fd.get(`deleteVersion.${target}`);
		const outcome = await port.queued(async () => {
			const { seeds, rows, overlays } = await readFor(port, target);
			const entry = registerEntries(seeds, rows).find((x) => x.key === target);
			if (!entry) return 'gone' as const;
			if ((typeof shown === 'string' || port.requireDeleteVersion) && shown !== port.deleteVersion(entry)) return 409 as const;
			return write(port, async () => {
				if (target.startsWith('row:')) await port.deleteRow(target.slice('row:'.length));
				else {
					const seedId = target.slice('seed:'.length);
					const s = seeds.find((x) => (x.state === 'orphaned' ? x.overlay.seedId : x.seed.seedId) === seedId)!;
					const base = s.state === 'orphaned' ? (overlays.find((o) => o.seedId === seedId)?.baseSeedSha256 ?? '') : s.seed.seedSha256;
					await port.putOverlay(seedId, base, { ...entry.fields, deleted: true });
				}
			});
		});
		if (outcome === 'gone') return fail(404, { op: 'delete' as const, target, message: DELETE_GONE, draft });
		if (outcome === 409) return fail(409, { op: 'delete' as const, target, message: 'That register row changed elsewhere (in another tab or window) after this page was loaded, so nothing was deleted. The register shows it as it is now; delete it again if you still want it gone.', draft });
		return outcome ? fail(outcome, { op: 'delete' as const, target, message: DELETE_BUSY, draft }) : { op: 'delete' as const, deleted: true, target, draft };
	},
});
