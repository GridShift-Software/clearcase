import { fail, isHttpError, redirect, type RequestEvent } from '@sveltejs/kit';
import { deleteStep } from '../../components/confirm-delete.ts';
import { app } from '../../local-case/app.server.ts';
import { datasetOf, exportFileName, viewContentOf, viewText } from '../../local-case/results.server.ts';
import { inTurn } from '../../local-case/registers.server.ts';
import { evidenceRows } from './rows.server.ts';
import { REGISTER_STORE, SAVE_FAILURES, SEED_DATASET, asFields, formFields, nextSeq, registerEntries, rowVersion, saveFailure, type FilingsData, type SaveFailure, type SeedViewLike } from './filings.ts';

function register(caseId: string, rv: string) {
	const a = app();
	const seeds = a.userWork.seedViews(caseId, rv, SEED_DATASET) as SeedViewLike[];
	const rows = a.userWork.listRows(caseId, REGISTER_STORE);
	return { seeds, rows, entries: registerEntries(seeds, rows) };
}

export const REGISTER_STORAGE = "Saved in this case's local work store; imported rows stay as imported and your changes are kept apart from them.";
export const registerIntro = (imported: string | null) => `${imported ?? 'Log each filing and the responding/replying affidavit.'} ${REGISTER_STORAGE}`;

export const filingsLoad = async ({ parent, url }: { parent: () => Promise<{ version: { id: string; caseId: string } }>; url: URL }) => {
	const { version } = await parent();
	const a = app();
	const f = datasetOf<FilingsData>(a.store, version.id, 'filings');
	const docs = evidenceRows(a.store, version.id);
	const vc = viewContentOf(a.store, version.id);
	const { entries } = register(version.caseId, version.id);
	const refs = new Set([...(f?.groups ?? []).flatMap((g) => g.items.map((x) => x.ref)), ...entries.map((e) => e.fields.ref)].filter(Boolean));
	const files = [...refs].map((ref) => [ref, docs?.byRef.get(ref)?.file ?? null] as const);
	const edit = url.searchParams.get('edit');
	return {
		groups: f?.groups ?? null,
		files,
		entries,
		editing: edit && entries.some((e) => e.key === edit) ? edit : null,
		content: { subtitle: viewText(vc, 'filings_tab', 'subtitle'), orientation: viewText(vc, 'filings_tab', 'orientation'), registerIntro: registerIntro(viewText(vc, 'filings_tab', 'registerIntro')) },
		exportNames: { filings: exportFileName(vc, 'filings_tab', 'filings.csv'), register: exportFileName(vc, 'filings_tab', 'filing-register.csv', 'registerExportFileName') },
	};
};

type Draft = { values: Record<string, string>; editing: string | null; version: string | null; failed: SaveFailure | null };
const draftOf = (fd: FormData): Draft => {
	const key = fd.get('key'), version = fd.get('version');
	return { values: formFields((k) => fd.get(k)).values, editing: typeof key === 'string' && key ? key : null, version: typeof version === 'string' && version ? version : null, failed: saveFailure(fd.get('failed')) };
};
const refuse = (status: number, code: SaveFailure, values: Record<string, string>, editing: string | null, version: string | null = null) =>
	fail(status, { op: 'save' as const, code, values, editing, version, message: SAVE_FAILURES[code].message, retry: SAVE_FAILURES[code].retry });
const DELETE_BUSY = 'The entry could not be deleted: the local store is busy or unavailable. Nothing was changed and the entry is still in the register; try again.';
const DELETE_GONE = 'That register row no longer exists; nothing was deleted.';

const queued = <T>(caseId: string, fn: () => Promise<T>) => inTurn(app().userWork, caseId, REGISTER_STORE, fn);

async function write(fn: () => Promise<unknown>): Promise<number | null> {
	try {
		await fn();
		return null;
	} catch (e) {
		return isHttpError(e) && e.status === 503 ? 503 : 500;
	}
}

export const filingsActions = {
	add: async ({ params, request }: RequestEvent) => {
		const a = app();
		const fd = await request.formData();
		const typed = formFields((k) => fd.get(k));
		const v = a.store.getVersion(params.vid ?? '');
		if (!v) return refuse(404, 'version', typed.values, null);
		if (!typed.ok) return refuse(400, 'empty-add', typed.values, null);
		const status = await queued(v.case_id, () => write(() => a.userWork.putRow(v.case_id, REGISTER_STORE, null, { seq: nextSeq(a.userWork.listRows(v.case_id, REGISTER_STORE)), ...typed.values, status: '' })));
		return status ? refuse(status, 'busy', typed.values, null) : { op: 'add' as const, saved: true };
	},
	save: async ({ params, request, url }: RequestEvent) => {
		const a = app();
		const fd = await request.formData();
		const key = String(fd.get('key') ?? '');
		const seen = typeof fd.get('version') === 'string' ? String(fd.get('version')) : null;
		const typed = formFields((k) => fd.get(k));
		const v = a.store.getVersion(params.vid ?? '');
		if (!v) return refuse(404, 'version', typed.values, key || null, seen);
		if (!typed.ok) return refuse(400, 'empty-edit', typed.values, key, seen);
		const outcome = await queued(v.case_id, async () => {
			const { seeds, rows, entries } = register(v.case_id, v.id);
			const e = entries.find((x) => x.key === key);
			if (!e) return 'gone' as const;
			if (seen !== rowVersion(e.fields)) return 'stale' as const;
			const kept = { ...typed.values, status: e.fields.status };
			return write(async () => {
				if (key.startsWith('row:')) {
					const row = rows.find((r) => `row:${r.rowId}` === key)!;
					await a.userWork.putRow(v.case_id, REGISTER_STORE, row.rowId, { ...row.fields, ...kept });
				} else {
					const seedId = key.slice('seed:'.length);
					const s = seeds.find((x) => (x.state === 'orphaned' ? x.overlay.seedId : x.seed.seedId) === seedId)!;
					const base = s.state === 'orphaned' ? (a.userWork.overlays(v.case_id, SEED_DATASET).find((o) => o.seedId === seedId)?.baseSeedSha256 ?? '') : s.seed.seedSha256;
					await a.userWork.putSeedOverlay({ caseId: v.case_id, datasetKey: SEED_DATASET, seedId, baseSeedSha256: base, fields: { ...asFields(kept), deleted: false } });
				}
			});
		});
		if (outcome === 'gone') return refuse(404, 'gone', typed.values, key, seen);
		if (outcome === 'stale') return refuse(409, 'stale', typed.values, key, seen);
		if (outcome) return refuse(outcome, 'busy', typed.values, key, seen);
		redirect(303, url.pathname);
	},
	delete: async ({ params, request }: RequestEvent) => {
		const a = app();
		const fd = await request.formData();
		const draft = draftOf(fd);
		const target = String(fd.get('delete') ?? '');
		const v = a.store.getVersion(params.vid ?? '');
		if (!v) return fail(404, { op: 'delete' as const, target, message: 'Unknown results version: nothing was deleted.', draft });
		// a Delete that is not confirmed deletes nothing: the page asks (or, after Cancel, shows the draft again)
		const step = deleteStep(fd, target);
		if (step !== 'confirm') return fail(400, { op: 'delete' as const, target, confirm: step === 'ask' ? target : null, draft });
		const outcome = await queued(v.case_id, async () => {
			const { seeds, entries } = register(v.case_id, v.id);
			const e = entries.find((x) => x.key === target);
			if (!e) return 'gone' as const;
			return write(async () => {
				if (target.startsWith('row:')) await a.userWork.deleteRow(v.case_id, REGISTER_STORE, target.slice('row:'.length));
				else {
					const seedId = target.slice('seed:'.length);
					const s = seeds.find((x) => (x.state === 'orphaned' ? x.overlay.seedId : x.seed.seedId) === seedId)!;
					const base = s.state === 'orphaned' ? (a.userWork.overlays(v.case_id, SEED_DATASET).find((o) => o.seedId === seedId)?.baseSeedSha256 ?? '') : s.seed.seedSha256;
					await a.userWork.putSeedOverlay({ caseId: v.case_id, datasetKey: SEED_DATASET, seedId, baseSeedSha256: base, fields: { ...e.fields, deleted: true } });
				}
			});
		});
		if (outcome === 'gone') return fail(404, { op: 'delete' as const, target, message: DELETE_GONE, draft });
		return outcome ? fail(outcome, { op: 'delete' as const, target, message: DELETE_BUSY, draft }) : { op: 'delete' as const, deleted: true, target, draft };
	},
};
