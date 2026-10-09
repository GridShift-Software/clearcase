import { fail, isHttpError } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { datasetOf, viewContentOf, viewText } from '$lib/local-case/results.server';
import { evidenceRows } from '$lib/views/evidence/rows.server';
import { REGISTER_STORE, SEED_DATASET, asFields, formFields, nextSeq, registerEntries, type FilingsData, type SeedViewLike } from '$lib/views/evidence/filings';
import type { Actions, PageServerLoad } from './$types';

/** The register as shown, for one case and the version being viewed. */
function register(caseId: string, rv: string) {
	const a = app();
	const seeds = a.userWork.seedViews(caseId, rv, SEED_DATASET) as SeedViewLike[];
	const rows = a.userWork.listRows(caseId, REGISTER_STORE);
	return { seeds, rows, entries: registerEntries(seeds, rows) };
}

export const load: PageServerLoad = async ({ parent, url }) => {
	const { version } = await parent();
	const a = app();
	const f = datasetOf<FilingsData>(a.store, version.id, 'filings');
	const docs = evidenceRows(a.store, version.id);
	const vc = viewContentOf(a.store, version.id);
	const { entries } = register(version.caseId, version.id);
	const refs = new Set([...(f?.groups ?? []).flatMap((g) => g.items.map((x) => x.ref)), ...entries.map((e) => e.fields.ref)].filter(Boolean));
	// the original's state of every cited document (open ↗ links to its page); a ref not in this version is broken
	const files = [...refs].map((ref) => [ref, docs?.byRef.get(ref)?.file ?? null] as const);
	const edit = url.searchParams.get('edit');
	return {
		groups: f?.groups ?? null,
		files,
		entries,
		editing: edit && entries.some((e) => e.key === edit) ? edit : null,
		content: { subtitle: viewText(vc, 'filings_tab', 'subtitle'), orientation: viewText(vc, 'filings_tab', 'orientation') },
	};
};

/** A failed write (the store busy beyond its retries answers 503) keeps the typed values and says so. */
async function write(values: Record<string, string>, fn: () => Promise<unknown>) {
	try {
		await fn();
		return null;
	} catch (e) {
		const status = isHttpError(e) ? e.status : 500;
		return fail(status === 503 ? 503 : 500, { values, message: 'The register could not be saved: the local store is busy or unavailable. Your entry is kept below; try again.' });
	}
}

export const actions: Actions = {
	add: async ({ params, request }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { values: {}, message: 'Unknown results version' });
		const fd = await request.formData();
		const typed = formFields((k) => fd.get(k));
		if (!typed.ok) return fail(400, { values: typed.values, message: 'Enter a filing to add it to the register.' });
		const rows = a.userWork.listRows(v.case_id, REGISTER_STORE);
		return (await write(typed.values, () => a.userWork.putRow(v.case_id, REGISTER_STORE, null, { seq: nextSeq(rows), ...typed.values, status: '' }))) ?? { saved: true };
	},
	save: async ({ params, request }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { values: {}, message: 'Unknown results version' });
		const fd = await request.formData();
		const key = String(fd.get('key') ?? '');
		const typed = formFields((k) => fd.get(k));
		if (!typed.ok) return fail(400, { values: typed.values, editing: key, message: 'A register row needs a filing.' });
		const { seeds, rows, entries } = register(v.case_id, v.id);
		const e = entries.find((x) => x.key === key);
		if (!e) return fail(404, { values: typed.values, message: 'That register row no longer exists.' });
		const kept = { ...typed.values, status: e.fields.status };
		const res = await write(typed.values, async () => {
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
		return res ?? { saved: true };
	},
	delete: async ({ params, request }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { values: {}, message: 'Unknown results version' });
		const key = String((await request.formData()).get('key') ?? '');
		const { seeds, entries } = register(v.case_id, v.id);
		const e = entries.find((x) => x.key === key);
		if (!e) return fail(404, { values: {}, message: 'That register row no longer exists.' });
		const res = await write({}, async () => {
			if (key.startsWith('row:')) await a.userWork.deleteRow(v.case_id, REGISTER_STORE, key.slice('row:'.length));
			else {
				// an imported seed is never removed: its deletion is an overlay, so a later version still shows its own seed
				const seedId = key.slice('seed:'.length);
				const s = seeds.find((x) => (x.state === 'orphaned' ? x.overlay.seedId : x.seed.seedId) === seedId)!;
				const base = s.state === 'orphaned' ? (a.userWork.overlays(v.case_id, SEED_DATASET).find((o) => o.seedId === seedId)?.baseSeedSha256 ?? '') : s.seed.seedSha256;
				await a.userWork.putSeedOverlay({ caseId: v.case_id, datasetKey: SEED_DATASET, seedId, baseSeedSha256: base, fields: { ...e.fields, deleted: true } });
			}
		});
		return res ?? { deleted: true };
	},
};
