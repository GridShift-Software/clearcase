import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { datasetOf, viewContentOf, viewText } from '$lib/local-case/results.server';
import { locatorPath } from '$lib/views/bundles/links';
import { bundlePathIndex } from '$lib/views/bundles/links.server';
import { MODES, type Caption, type Mode, type ModeMeta, type ScheduleItem } from '$lib/views/bundles/discovery';
import { MODE_STORE, clearSelection, guarded, putSingle, readMarks, readMode, writeMarks } from '$lib/views/bundles/store.server';
import type { Actions, PageServerLoad } from './$types';

type RawFile = { fn?: unknown; url?: unknown; co?: unknown; x?: unknown };
type RawItem = { no?: unknown; date?: unknown; co?: unknown; desc?: unknown; nfiles?: unknown; files?: unknown };
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const a = app();
	const raw = datasetOf<Record<string, unknown>>(a.store, version.id, 'discovery-schedules');
	const index = bundlePathIndex(a.store, version.id);
	const items = (m: Mode): ScheduleItem[] => (Array.isArray(raw?.[m]) ? (raw[m] as RawItem[]) : []).filter((i) => i && typeof i === 'object').map((i) => ({
		no: typeof i.no === 'number' ? i.no : Number(i.no) || 0, date: str(i.date), co: str(i.co), desc: str(i.desc), nfiles: typeof i.nfiles === 'number' ? i.nfiles : 0,
		files: (Array.isArray(i.files) ? (i.files as RawFile[]) : []).filter((f) => f && typeof f === 'object').map((f) => {
			const path = locatorPath(f.url);
			return { fn: str(f.fn), url: str(f.url), co: str(f.co), x: typeof f.x === 'string' && f.x ? f.x : null, key: path ?? `url:${str(f.url)}`, ref: path === null ? null : index.get(path) ?? null };
		}),
	}));
	const vc = viewContentOf(a.store, version.id);
	const t = (field: string) => viewText(vc, 'discovery_tab', field);
	const caption: Caption = {
		court: t('court'), division: t('division'), caseNumber: t('caseNumber'), plaintiff: t('plaintiff'), plaintiffCitation: t('plaintiffCitation'), plaintiffRole: t('plaintiffRole'),
		defendant: t('defendant'), defendantCitation: t('defendantCitation'), defendantRole: t('defendantRole'), bundleIndexName: t('bundleIndexName'),
	};
	const meta = Object.fromEntries(MODES.map((m) => [m, { deed: t(`${m}Deed`), schedule: t(`${m}Schedule`), file: t(`${m}File`), label: t(`${m}ModeLabel`) } satisfies ModeMeta])) as Record<Mode, ModeMeta>;
	const marks = await readMarks(version.caseId);
	return {
		present: raw !== null,
		schedules: { discovery: items('discovery'), supplementary: items('supplementary') } as Record<Mode, ScheduleItem[]>,
		caption, meta,
		mode: readMode(version.caseId),
		selected: marks.filter((m) => m.selected).map((m) => m.locator),
		marks: marks.filter((m) => m.co).map((m) => [m.locator, m.co!] as const),
	};
};

const caseOf = async (vid: string) => app().store.getVersion(vid)?.case_id ?? null;
const keys = (f: FormData) => f.getAll('key').filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 4096);

export const actions: Actions = {
	select: async ({ request, params }) => {
		const c = await caseOf(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const on = f.get('on') === '1', k = keys(f);
		return guarded({ key: k, on }, async () => { await writeMarks(c, k, { selected: on }); return { saved: true }; });
	},
	co: async ({ request, params }) => {
		const c = await caseOf(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const val = f.get('val'), k = keys(f);
		if (val !== 'C' && val !== 'O') return fail(400, { message: 'Copy or Original only' });
		return guarded({ key: k, val }, async () => { await writeMarks(c, k, { co: val }); return { saved: true }; });
	},
	clear: async ({ params }) => {
		const c = await caseOf(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		return guarded({}, async () => { await clearSelection(c); return { saved: true }; });
	},
	mode: async ({ request, params }) => {
		const c = await caseOf(params.vid); if (!c) return fail(404, { message: 'Unknown results version' });
		const m = (await request.formData()).get('mode');
		if (m !== 'discovery' && m !== 'supplementary') return fail(400, { message: 'Unknown schedule' });
		return guarded({ mode: m }, async () => { await putSingle(c, MODE_STORE, { mode: m }); return { saved: true }; });
	},
};
