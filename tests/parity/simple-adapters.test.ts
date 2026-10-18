import { describe, expect, it, vi } from 'vitest';

const evidenceHydrated = { expression: `document.querySelector('main#main')?.dataset.hydrated === '1'`, timeout: 60000 };
const analysisHydrated = { expression: `document.querySelector('main#main[data-hydrated]') !== null`, timeout: 30000 };
const quantumHydrated = (view: string) => ({ expression: `!!document.querySelector('main[data-ready="${view}"][data-hydrated]')`, timeout: 30000 });
const cases = [
	{ view: 'people', hydration: evidenceHydrated, control: null },
	{ view: 'entity_ledger_tab', hydration: evidenceHydrated, control: null },
	{ view: 'matter', hydration: null, control: null },
	{ view: 'risk_matrix_tab', hydration: null, control: null },
	{ view: 'witness_tab', hydration: null, control: null },
	{ view: 'contradictions_tab', hydration: analysisHydrated, control: '#export-csv' },
	{ view: 'vdm_matrix_tab', hydration: analysisHydrated, control: '#export-csv' },
	{ view: 'invoice_ledger_tab', hydration: quantumHydrated('invoice_ledger_tab'), control: '#export-invoices' },
	{ view: 'quantum_tab', hydration: quantumHydrated('quantum_tab'), control: '#export-invoices' },
];

describe.each(cases)('$view adapter contract on synthetic extractor input', ({ view, hydration, control }) => {
	it.each([false, true])('keeps its module, snapshot, hydration and export contract (exports=%s)', async (exports) => {
		const module = await import(`../../scripts/parity/adapters/app/${view}.mjs`);
		const adapter = module.default;
		expect(Object.keys(module)).toEqual(['default']);
		expect(Object.keys(adapter).sort()).toEqual(['extract', 'view']);
		expect(adapter.view).toBe(view);
		expect(adapter.extract).toBeTypeOf('function');
		const order: string[] = [];
		const p = {
			goto: vi.fn(async () => {}), settled: vi.fn(async () => {}),
			click: vi.fn(async () => true), focusRole: vi.fn(async () => 'heading'),
			evaluate: vi.fn(async () => 'Synthetic crumb'),
			waitFor: vi.fn(async (expression: string) => { order.push(expression); }),
			extract: vi.fn(async () => {
				order.push('extract');
				return { h1: ['Synthetic title'], kpis: [], tables: [], lists: [], controls: [], paragraphs: [{ cls: '', section: 'Details', text: 'Synthetic content' }] };
			}),
			takeDownloads: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([
				{ name: 'synthetic.csv', type: 'text/csv', base64: Buffer.from('Name,Amount\r\nSynthetic,12.50').toString('base64') },
			]),
		};
		const route = `/synthetic/${view}`;
		const ctx = { base: '/v/synthetic', registry: { [view]: { route } }, exports };
		expect(await adapter.extract(p, ctx)).toEqual({
			view, side: 'app', status: 'ok', title: 'Synthetic title',
			texts: { 'details.1': 'Synthetic content', 'shell.crumb': 'Synthetic crumb' },
			kpis: {}, counts: {}, tables: {}, lists: {}, controls: {}, sweeps: {},
			exports: exports && control ? { export_csv: { name: 'synthetic.csv', columns: ['Name', 'Amount'], rows: [['Synthetic', '12.50']] } } : {},
			focus: { after_nav: 'heading' },
		});
		expect(p.goto.mock.calls).toEqual([
			['/v/synthetic/overview', `document.querySelector('[data-ready="overview"]')`],
			[`/v/synthetic${route}`, `document.querySelector('[data-ready="${view}"]')`],
		]);
		expect(p.extract).toHaveBeenCalledWith('#main');
		if (hydration) {
			expect(p.waitFor).toHaveBeenLastCalledWith(hydration.expression, hydration.timeout);
			expect(order.indexOf(hydration.expression)).toBeLessThan(order.indexOf('extract'));
		} else expect(p.waitFor).toHaveBeenCalledTimes(1);
		expect(p.click.mock.calls).toEqual([[`#nav-${view}`], ...(exports && control ? [[control]] : [])]);
		expect(p.takeDownloads).toHaveBeenCalledTimes(exports && control ? 2 : 0);
	});
});
