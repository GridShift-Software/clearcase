import { datasetOf, viewText } from '../../local-case/results.server.ts';
import type { PureInput } from '../payloads/views.ts';
import { HEADER_FIELDS, headerRaw, bundlesOf } from './court.ts';
import { locatorPath, resolveLocator } from './links.ts';
import {
	MODES,
	type Caption,
	type Mode,
	type ModeMeta,
	type ScheduleItem,
} from './discovery.ts';
import { coverage, type PageText } from './caselines.ts';
import { bundlePaths, availablePaths } from './paths.server.ts';
const str = (v: unknown) => (typeof v === 'string' ? v : '');
type RawFile = { fn?: unknown; url?: unknown; co?: unknown; x?: unknown };
type RawItem = {
	no?: unknown;
	date?: unknown;
	co?: unknown;
	desc?: unknown;
	nfiles?: unknown;
	files?: unknown;
};
type Raw = {
	headerDefaults?: Record<string, unknown>;
	source?: unknown;
	indexSource?: unknown;
	caselinesSrc?: unknown;
};
function pageIndex(raw: unknown): PageText[] {
	const idx = (raw as { index?: unknown } | null)?.index;
	return Array.isArray(idx)
		? idx.filter(
				(e): e is [number, string] =>
					Array.isArray(e) &&
					Number.isInteger(e[0]) &&
					typeof e[1] === 'string',
			)
		: [];
}
export function courtPure({ store, vid, vc }: PureInput) {
	const raw = datasetOf<Raw>(store, vid, 'bundles');
	const shipped = bundlesOf(raw);
	const custom: ReturnType<typeof bundlesOf> = [];
	const pathShard = bundlePaths(store, vid);
	const paths = availablePaths(pathShard);
	const files = {};
	const links = [
		...shipped.map((b) => ({
			file: resolveLocator(paths, b.file),
			indexFile: resolveLocator(paths, b.indexFile),
			rows: b.rows.map((r) => ({
				slice: r.sliceUrl ? resolveLocator(paths, r.sliceUrl) : null,
				parts: r.parts.map((p) =>
					resolveLocator(paths, p.url, p.from > 1 ? p.from : null),
				),
				caselines:
					r.caselines && typeof raw?.caselinesSrc === 'string'
						? resolveLocator(paths, raw.caselinesSrc, r.caselines.from || null)
						: null,
			})),
		})),
		...custom.map((b) => ({
			file: null,
			indexFile: null,
			rows: b.rows.map((r) => ({
				slice: null,
				parts: r.parts.map(() => null),
				caselines: null,
			})),
		})),
	];
	const bundles = [...shipped, ...custom];

	const t = (f: string) => viewText(vc, 'court_bundle_tab', f);
	const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
	const stored = null;
	const refs = links
		.flatMap((l) => [
			l.file,
			l.indexFile,
			...l.rows.flatMap((r) => [r.slice, ...r.parts, r.caselines]),
		])
		.filter((r) => r !== null)
		.map((r) => r.ref);
	return {
		present: raw !== null,
		pathShard,
		bundles,
		links,
		files,
		content: {
			kpiBundlesNote: t('kpiBundlesNote'),
			kpiExtractsValue: vc.number('court_bundle_tab', 'kpiExtractsValue'),
			kpiExtractsNote: t('kpiExtractsNote'),
			extentNarrative: t('extentNarrative'),
			source: str(raw?.source) ?? t('compositionSourceDefault'),
			indexSource: str(raw?.indexSource) ?? t('indexSourceDefault'),
			examples: Object.fromEntries(
				HEADER_FIELDS.filter((f) => f.example).map((f) => [
					f.key,
					t(f.example!),
				]),
			) as Record<string, string | null>,
			docxCreator: t('docxCreator'),
			allIndexesFileName: t('allIndexesFileName'),
		},
		header: headerRaw(raw?.headerDefaults ?? {}, null),
		headerStored: stored !== null,
		headerHash: '',
		downloads: {},
	};
}
export function discoveryPure({ store, vid, vc }: PureInput) {
	const raw = datasetOf<Record<string, unknown>>(
		store,
		vid,
		'discovery-schedules',
	);
	const pathShard = bundlePaths(store, vid);
	const index = availablePaths(pathShard);
	const files = {};
	const items = (m: Mode): ScheduleItem[] =>
		(Array.isArray(raw?.[m]) ? (raw[m] as RawItem[]) : [])
			.filter((i) => i && typeof i === 'object')
			.map((i) => ({
				no: typeof i.no === 'number' ? i.no : Number(i.no) || 0,
				date: str(i.date),
				co: str(i.co),
				desc: str(i.desc),
				nfiles: typeof i.nfiles === 'number' ? i.nfiles : 0,
				files: (Array.isArray(i.files) ? (i.files as RawFile[]) : [])
					.filter((f) => f && typeof f === 'object')
					.map((f) => {
						const path = locatorPath(f.url);
						return {
							fn: str(f.fn),
							url: str(f.url),
							co: str(f.co),
							x: typeof f.x === 'string' && f.x ? f.x : null,
							key: path ?? `url:${str(f.url)}`,
							ref: path === null ? null : (index.get(path) ?? null),
						};
					}),
			}));

	const t = (field: string) => viewText(vc, 'discovery_tab', field);
	const caption: Caption = {
		court: t('court'),
		division: t('division'),
		caseNumber: t('caseNumber'),
		plaintiff: t('plaintiff'),
		plaintiffCitation: t('plaintiffCitation'),
		plaintiffRole: t('plaintiffRole'),
		defendant: t('defendant'),
		defendantCitation: t('defendantCitation'),
		defendantRole: t('defendantRole'),
		bundleIndexName: t('bundleIndexName'),
	};
	const meta = Object.fromEntries(
		MODES.map((m) => [
			m,
			{
				deed: t(`${m}Deed`),
				schedule: t(`${m}Schedule`),
				file: t(`${m}File`),
				label: t(`${m}ModeLabel`),
			} satisfies ModeMeta,
		]),
	) as Record<Mode, ModeMeta>;

	const schedules = {
		discovery: items('discovery'),
		supplementary: items('supplementary'),
	} as Record<Mode, ScheduleItem[]>;
	const refs = MODES.flatMap((m) =>
		schedules[m].flatMap((i) => i.files.map((f) => f.ref)),
	).filter((r): r is string => !!r);
	return {
		present: raw !== null,
		pathShard,
		schedules,
		files,
		downloads: {},
		caption,
		meta,
		mode: 'discovery' as Mode,
		selected: [] as string[],
		marks: [] as (readonly [string, 'C' | 'O'])[],
	};
}
export function caselinesPure({ store, vid, vc }: PureInput) {
	const raw = datasetOf<{ pages?: unknown }>(store, vid, 'caselines-index');
	const index = pageIndex(raw);

	const fallback = vc.number('caselines_tab', 'pageCountFallback');
	const pages =
		typeof raw?.pages === 'number' && raw.pages > 0
			? raw.pages
			: typeof fallback === 'number'
				? fallback
				: null;
	const pathShard = bundlePaths(store, vid);
	const paths = availablePaths(pathShard);
	const src = vc.text('caselines_tab', 'url');
	const bundle = resolveLocator(paths, src, null);
	return {
		present: raw !== null,
		pathShard,
		index,
		pages,
		bundle,
		content: {
			subtitle: viewText(vc, 'caselines_tab', 'subtitle'),
			name: viewText(vc, 'caselines_tab', 'bundleName'),
			note:
				pages === null
					? null
					: viewText(vc, 'caselines_tab', 'heroNote', {
							pages: pages.toLocaleString('en'),
						}),
		},
		cover: coverage(index, pages),
	};
}
