// The item-2 additions follow CLEARCASE_ANALYSIS_ADDITIONS through the real import and the route loaders (GRS-48,
// ADR 0003): unset or 0 is v5's behaviour (v5's headings, no Refs display, no refs CSV column), 1 shows all three.
// Timeline titles are a correctness fix, escaped once in both states. Synthetic case only.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import path from 'node:path';
import { render } from 'svelte/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { ackFor, cleanup, tempRoot } from '../../src/lib/local-case/test-support';
import { defenceCsv, REFS_HEADING, refsShown, type DefenceRow } from '../../src/lib/views/analysis/defence';
import { V5_HEADINGS } from '../../src/lib/views/analysis/headings';
import InfoRequiredPage from '../../src/routes/v/[vid]/analysis/info_required_tab/+page.svelte';
import TimelinePage from '../../src/routes/v/[vid]/analysis/timeline/+page.svelte';
import DefencePage from '../../src/routes/v/[vid]/analysis/vdm_matrix_tab/+page.svelte';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const TITLE = 'Agreement & schedule <signed>';
let root: string, lc: LocalCase, rv: string, caseId: string;
const env = { ...process.env };

beforeAll(async () => {
	root = await tempRoot('analysis-flag-states');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	const c = await buildCase(path.join(root, 'case'), { caseId: 'analysis-flag-states', edit: (r) => { (r.DATA as { timeline: { events: { title: string }[] } }).timeline.events[0].title = TITLE; } });
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	rv = c.resultsVersion;
	caseId = lc.store.getVersion(rv)!.case_id;
}, 120_000);
afterAll(async () => {
	const g = globalThis as { __clearcase?: { app: LocalCase } };
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = env;
	if (root) await cleanup(root);
});
afterEach(() => vi.unstubAllEnvs());

type Loader = { load: (e: unknown) => Promise<unknown> };
const ROUTES: Record<string, () => Promise<unknown>> = {
	timeline: () => import('../../src/routes/v/[vid]/analysis/timeline/+page.server'),
	vdm_matrix_tab: () => import('../../src/routes/v/[vid]/analysis/vdm_matrix_tab/+page.server'),
	info_required_tab: () => import('../../src/routes/v/[vid]/analysis/info_required_tab/+page.server'),
};
const load = async (view: string) => (await ((await ROUTES[view]!()) as Loader).load({ params: { vid: rv }, parent: async () => ({ version: { id: rv, caseId } }) })) as Record<string, any>;

describe.each([
	['unset', undefined, false],
	['0', '0', false],
	['1', '1', true],
] as const)('CLEARCASE_ANALYSIS_ADDITIONS %s', (_name, value, on) => {
	const stub = () => vi.stubEnv('CLEARCASE_ANALYSIS_ADDITIONS', value);

	it(on ? 'heads the three views with their navigation labels' : 'heads the three views with v5\'s headings', async () => {
		stub();
		expect((await load('timeline')).heading).toBe(on ? 'Timeline' : 'Chronology & Timeline');
		expect((await load('vdm_matrix_tab')).heading).toBe(on ? 'Defence & Rebuttal' : 'Defence & Rebuttal Matrix');
		expect((await load('info_required_tab')).heading).toBe(on ? 'Info Required' : 'Information & Documents Required');
	});

	it(on ? 'shows the defence Refs column and exports refs last' : 'hides the defence Refs column and exports v5\'s five columns', async () => {
		stub();
		const d = await load('vdm_matrix_tab');
		const rows = d.rows as DefenceRow[];
		expect(rows[0]!.refs).toBe('OD-001 – OD-002');
		expect(d.analysisAdditions).toBe(on);
		expect(refsShown(rows, d.analysisAdditions)).toBe(on);
		const lines = defenceCsv(d.exportColumns.keys, rows, d.analysisAdditions).split('\r\n');
		expect(lines[0]!.split(',')).toEqual(on ? [...d.exportColumns.keys, 'refs'] : d.exportColumns.keys);
		expect(d.exportColumns.keys).toHaveLength(5);
		expect(lines[1]!.includes('OD-001 – OD-002')).toBe(on);
	});

	it(on ? 'renders the defence page with a sixth Refs column and the refs cell' : 'renders the defence page with v5\'s five columns and no refs cell', async () => {
		stub();
		const d = await load('vdm_matrix_tab');
		const body = render(DefencePage, { props: { data: { ...d, version: { id: rv, caseId, titleName: 'Invented case' } } } as never }).body;
		const head = body.slice(body.indexOf('<thead'), body.indexOf('</thead>'));
		expect(head.match(/<th[ >]/g)).toHaveLength(on ? 6 : 5);
		expect(head.includes(`>${REFS_HEADING}</th>`)).toBe(on);
		expect(body.includes('OD-001 – OD-002')).toBe(on);
		expect(body.includes(`data-label="${REFS_HEADING}"`)).toBe(on);
	});

	it(on ? 'renders Info Required under its navigation label' : 'renders Info Required under v5\'s heading', async () => {
		stub();
		const d = await load('info_required_tab');
		const body = render(InfoRequiredPage, { props: { data: { ...d, version: { id: rv, caseId, titleName: 'Invented case' } }, form: null } as never }).body;
		const h1 = /<h1[^>]*data-page-heading[^>]*>([^<]*)<\/h1>/.exec(body)?.[1];
		expect(h1).toBe((on ? 'Info Required' : V5_HEADINGS.info_required_tab!).replaceAll('&', '&amp;'));
	});

	it('passes timeline titles raw and escapes them once on the page, never twice', async () => {
		stub();
		const d = await load('timeline');
		const events = [...d.phases.flatMap((p: { events: { title: string }[] }) => p.events), ...d.unplaced] as { title: string }[];
		expect(events.map((e) => e.title)).toContain(TITLE);
		const body = render(TimelinePage, { props: { data: { ...d, version: { id: rv, caseId, titleName: 'Invented case' } } } as never }).body;
		expect(body).toContain('Agreement &amp; schedule &lt;signed>');
		expect(body).not.toContain('&amp;amp;');
		expect(body).not.toContain('<signed>');
		expect(body).toMatch(new RegExp(`<h1[^>]*data-page-heading[^>]*>${on ? 'Timeline' : 'Chronology &amp; Timeline'}</h1>`));
	});
});
