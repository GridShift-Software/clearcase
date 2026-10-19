// GRS-22 steps 5 and 7 through the real import and the route loaders: the Risk Matrix shows a risk's category, owner
// and documents when the generation carries them and nothing it does not, and the validation report discloses how
// much document text the source export cut short, from the conversion's own diagnostics. v5 renders as before.
// Synthetic cases only; every value is invented.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase, type SynthCase } from '../e2e/pilot/lib/fixtures';
import { writePackageDir } from '../../src/lib/case-package/writer.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { cleanup, tempRoot } from '../../src/lib/local-case/test-support';
import ImportPage from '../../src/routes/import/[id]/+page.svelte';
import RiskPage from '../../src/routes/v/[vid]/analysis/risk_matrix_tab/+page.svelte';
import { resealFiles } from './fixtures/build.ts';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

type J = Record<string, any>;
type Imported = { rv: string; caseId: string; importId: number };
let root: string, lc: LocalCase;
const env = { ...process.env };
const cases: Record<'newer' | 'v5' | 'bare', Imported> = {} as never;

async function importCase(c: SynthCase): Promise<Imported> {
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(imp.kind).toBe('stored');
	return { rv: c.resultsVersion, caseId: lc.store.getVersion(c.resultsVersion)!.case_id, importId: imp.importId };
}

beforeAll(async () => {
	root = await tempRoot('compat-views');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	// the newer builder's risk shape (category, owner, refs) and its DATA.text, one entry at the 4,000-character cap
	const newer = await buildCase(path.join(root, 'newer'), {
		caseId: 'compat-newer',
		edit: (r) => {
			(r.META as J).version = 'V1';
			r.DATA.riskMatrix = [
				{ issue: 'Invented issue', category: 'invented category', likelihood: 'Medium', impact: 'High', mitigation: 'Invented mitigation', owner: 'Invented owner', refs: ['OD-001', 'ZZ-999'] },
				{ issue: 'Bare issue', likelihood: 'Low', impact: 'Low', mitigation: 'Bare mitigation' },
			];
			r.DATA.text = { 'OD-001': 'x'.repeat(4000), 'OD-002': 'Invented text.', 'OD-003': 'y'.repeat(3999) };
		},
	});
	cases.newer = await importCase(newer);
	cases.v5 = await importCase(await buildCase(path.join(root, 'v5'), { caseId: 'compat-v5' }));
	// another producer's package: valid, but without the converter's report
	const bare = await buildCase(path.join(root, 'bare'), { caseId: 'compat-bare' });
	const files = new Map(bare.files);
	files.delete('datasets/conversion-report.json');
	const sealed = resealFiles(files, (m) => { m.files = m.files.filter((f: J) => f.path !== 'datasets/conversion-report.json'); });
	await rm(bare.pkgDir, { recursive: true, force: true });
	await writePackageDir(bare.pkgDir, sealed);
	const rv = (JSON.parse(new TextDecoder().decode(sealed.get('manifest.json')!)) as J).resultsVersion as string;
	cases.bare = await importCase({ ...bare, files: sealed, resultsVersion: rv });
}, 180_000);
afterAll(async () => {
	const g = globalThis as { __clearcase?: { app: LocalCase } };
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = env;
	if (root) await cleanup(root);
});

type Loader = { load: (e: unknown) => Promise<unknown> };
const riskLoad = async (c: Imported) =>
	(await ((await import('../../src/routes/v/[vid]/analysis/risk_matrix_tab/+page.server')) as Loader).load({ params: { vid: c.rv }, parent: async () => ({ version: { id: c.rv, caseId: c.caseId } }) })) as J;
const riskPage = async (c: Imported) => render(RiskPage, { props: { data: { ...(await riskLoad(c)), version: { id: c.rv, caseId: c.caseId, titleName: 'Invented case' } } } as never }).body;
const importLoad = async (c: Imported) =>
	(await ((await import('../../src/routes/import/[id]/+page.server')) as Loader).load({ params: { id: String(c.importId) }, url: new URL(`http://127.0.0.1/import/${c.importId}`) })) as J;
const importPage = async (c: Imported) => render(ImportPage, { props: { data: await importLoad(c), form: null } as never }).body;
const headings = (body: string) => [...body.slice(body.indexOf('<thead'), body.indexOf('</thead>')).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
const cells = (body: string, label: string) => [...body.matchAll(new RegExp(`<td data-label="${label}">(.*?)</td>`, 'g'))].map((m) => m[1]!.replace(/<!--[^>]*-->/g, ''));
const section = (body: string, id: string) => { const at = body.indexOf(`id="${id}"`); return at < 0 ? null : body.slice(at, body.indexOf('</section>', at)); };

describe('step 5: the Risk Matrix renders category, owner and documents only where the generation carries them', () => {
	it('shows the newer builder\'s category, owner and refs in their own columns, linking only refs in the register', async () => {
		const body = await riskPage(cases.newer);
		expect(headings(body)).toEqual(['Issue', 'Category', 'Likelihood', 'Impact', 'Mitigation', 'Owner', 'Documents']);
		expect(cells(body, 'Category')).toEqual(['<span class="badge">invented category</span>', '']);
		expect(cells(body, 'Owner')).toEqual(['Invented owner', '']);
		const docs = cells(body, 'Documents');
		expect(docs[0]).toContain(`href="/v/${cases.newer.rv}/doc/OD-001"`);
		expect(docs[0]).toContain('<span class="cite-broken" title="not in this results version">ZZ-999</span>');
		expect(docs[0]).not.toContain('/doc/ZZ-999');
		expect(docs[1]).toBe('<span class="an-tag">—</span>');
		expect(body).toContain('Issue · category · likelihood · impact · mitigation · owner · documents');
	});

	it('v5 risks carry none of them: the loader adds no field and the page keeps v5\'s four columns and subtitle', async () => {
		const d = await riskLoad(cases.v5);
		expect(d).toEqual({ risks: [{ issue: 'Invented issue', likelihood: 'Low', impact: 'High', mitigation: 'Invented mitigation', likelihoodScore: null, impactScore: null }] });
		const body = await riskPage(cases.v5);
		expect(headings(body)).toEqual(['Issue', 'Likelihood', 'Impact', 'Mitigation']);
		expect(body).toContain('Issue · likelihood · impact · mitigation');
		expect(body).not.toContain('data-label="Category"');
		expect(body).not.toContain('data-label="Owner"');
		expect(body).not.toContain('data-label="Documents"');
	});
});

describe('step 7: the validation report discloses the source export\'s text cap from the conversion diagnostics', () => {
	it('shows the measured coverage of a newer export with text at the cap', async () => {
		const s = section(await importPage(cases.newer), 'text-coverage');
		expect(s).not.toBeNull();
		expect(s).toContain('Source text coverage');
		expect(s).toContain('1 of 3 document texts (DATA.text) stop at the 4,000-character cap');
	});

	it('shows nothing for a generation with no cap hits', async () => {
		const d = await importLoad(cases.v5);
		expect(d.textCoverage).toBeNull();
		expect(section(await importPage(cases.v5), 'text-coverage')).toBeNull();
	});

	it('says the coverage is unknown, rather than nothing, when the package carries no conversion report', async () => {
		const s = section(await importPage(cases.bare), 'text-coverage');
		expect(s).not.toBeNull();
		expect(s).toContain('carries no conversion report');
	});
});
