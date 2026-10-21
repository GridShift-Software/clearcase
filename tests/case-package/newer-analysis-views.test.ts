// GRS-149 through the real import and the route loaders: the newer export's code-embedded analysis is what the Matter,
// Timeline, Risk Matrix, Defence & Rebuttal and Witnesses views show, and the validation report no longer lists it as
// retained but unshown. Synthetic case only; every value is invented.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import path from 'node:path';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import { docPath } from '../../src/lib/local-case/model';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { cleanup, tempRoot } from '../../src/lib/local-case/test-support';
import ImportPage from '../../src/routes/import/[id]/+page.svelte';
import MatterPage from '../../src/routes/v/[vid]/analysis/matter/+page.svelte';
import RiskPage from '../../src/routes/v/[vid]/analysis/risk_matrix_tab/+page.svelte';
import TimelinePage from '../../src/routes/v/[vid]/analysis/timeline/+page.svelte';
import DefencePage from '../../src/routes/v/[vid]/analysis/vdm_matrix_tab/+page.svelte';
import WitnessPage from '../../src/routes/v/[vid]/analysis/witness_tab/+page.svelte';
import { emptyAnalysisSlots, literal, MODULE, V1_MERGE_LINE, X } from './fixtures/newer-analysis.ts';
import { SYNTH_VIEW_CODE } from './fixtures/synth.ts';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

type J = Record<string, any>;
let root: string, lc: LocalCase, rv: string, caseId: string, importId: number;
const env = { ...process.env };

beforeAll(async () => {
	root = await tempRoot('newer-analysis-views');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	const c = await buildCase(path.join(root, 'newer'), { caseId: 'newer-analysis', viewCode: [SYNTH_VIEW_CODE, MODULE, literal(X), V1_MERGE_LINE].join('\n'), edit: emptyAnalysisSlots });
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(imp.kind).toBe('stored');
	rv = c.resultsVersion;
	caseId = lc.store.getVersion(rv)!.case_id;
	importId = (imp as { importId: number }).importId;
}, 180_000);
afterAll(async () => {
	const g = globalThis as { __clearcase?: { app: LocalCase } };
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = env;
	if (root) await cleanup(root);
});

type Loader = { load: (e: unknown) => Promise<unknown> };
const LOADERS = {
	matter: () => import('../../src/routes/v/[vid]/analysis/matter/+page.server'),
	timeline: () => import('../../src/routes/v/[vid]/analysis/timeline/+page.server'),
	risk_matrix_tab: () => import('../../src/routes/v/[vid]/analysis/risk_matrix_tab/+page.server'),
	vdm_matrix_tab: () => import('../../src/routes/v/[vid]/analysis/vdm_matrix_tab/+page.server'),
	witness_tab: () => import('../../src/routes/v/[vid]/analysis/witness_tab/+page.server'),
};
const view = async (route: keyof typeof LOADERS, Page: unknown) => {
	const data = (await ((await LOADERS[route]()) as unknown as Loader).load({ params: { vid: rv }, parent: async () => ({ version: { id: rv, caseId } }) })) as J;
	return render(Page as never, { props: { data: { ...data, version: { id: rv, caseId, titleName: 'Invented case' } } } as never }).body;
};
const text = (html: string) => html.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the newer export\'s code-embedded analysis in its views (GRS-149)', () => {
	it('Matter & Strategy shows the module\'s headings, not the profile\'s', async () => {
		const t = text(await view('matter', MatterPage));
		for (const s of ['Start', 'The agreement OD-001 began it.', 'Then', 'Plan', 'Rely on SD-001.']) expect(t).toContain(s);
		expect(t).not.toContain('A claim.');
	});

	it('the Timeline lists every event once, by date, outside phases it cannot place', async () => {
		const body = await view('timeline', TimelinePage);
		const unplaced = body.slice(body.indexOf('data-phase="unplaced"'));
		for (const e of X.timeline.events) expect(text(unplaced).split(e.title).length - 1).toBe(1);
		expect(unplaced).toContain(`href="${docPath(rv, 'OD-001')}"`);
	});

	it('the Risk Matrix shows the 2 risks with category, owner and documents', async () => {
		const t = text(await view('risk_matrix_tab', RiskPage));
		for (const s of ['Invented risk', 'Second risk', 'Legal', 'Quantum', 'Counsel', 'Attorney']) expect(t).toContain(s);
	});

	it('Defence & Rebuttal shows the opponent\'s contention and each cited document', async () => {
		const body = await view('vdm_matrix_tab', DefencePage);
		expect(text(body)).toContain('Their contention');
		for (const ref of ['OD-001', 'OD-002']) expect(body).toContain(`href="${docPath(rv, ref)}"`);
	});

	it('Witnesses shows the will-say', async () => {
		const t = text(await view('witness_tab', WitnessPage));
		for (const s of ['Ann Lee', 'Supply', 'Invented will-say']) expect(t).toContain(s);
	});

	it('the validation report no longer lists the analysis as retained but not presented', async () => {
		const d = (await ((await import('../../src/routes/import/[id]/+page.server')) as Loader).load({ params: { id: String(importId) }, url: new URL(`http://127.0.0.1/import/${importId}`) })) as J;
		const body = render(ImportPage, { props: { data: d, form: null } as never }).body;
		expect(body).not.toContain('V5_OVERLAY_UNMAPPED');
		expect(body).not.toContain('v5-residual-analysis-overlay');
		expect(body).toContain('v5-residual-timeline-phases');
	});
});
