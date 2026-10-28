// Ticket 17a fix round: the no-JavaScript confirmation of a delete carries the version of the row the page showed.
import type { ComponentProps } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), beforeNavigate: () => {} }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }), applyAction: async () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://127.0.0.1/registers/deadlines_tab') } }));
import RegisterPage from '../../src/lib/views/registers/RegisterPage.svelte';
import { REGISTERS } from '../../src/lib/views/registers/defs';
import { registerHead, type Cell, type ShownRow } from '../../src/lib/views/registers/shown';

const def = REGISTERS.deadlines_tab;
const text = (t: string): Cell => ({ kind: 'text', text: t });
const row = (rowId: string, version: string): ShownRow => ({ rowId, values: { title: `Synthetic ${rowId}`, date: '2026-11-04', cat: 'Filing', note: '' }, cells: ['2026-11-04', 'in 3d', rowId, 'Filing', ''].map(text), version, intact: true });
type Form = ComponentProps<typeof RegisterPage>['form'];
const page = (form: Form) => render(RegisterPage, { props: { form, data: {
	version: { id: 'sha256:' + '1'.repeat(64), titleName: 'Synthetic' }, register: registerHead('deadlines_tab', def),
	rows: [row('row-1', 'version-of-row-1'), row('row-2', 'version-of-row-2')], exportRows: [], exportName: { name: 'deadlines.ics', note: null }, icsProductId: null } } }).body;

describe('the confirmation a delete without JavaScript renders', () => {
	it('carries the displayed version of the row being confirmed, and only that row', () => {
		const html = page({ op: 'delete', rowId: 'row-1', confirm: 'row-1' });
		const tokens = [...html.matchAll(/<input[^>]*name="deleteVersion"[^>]*>/g)].map((m) => m[0]);
		expect(tokens).toHaveLength(1);
		expect(tokens[0]).toContain('value="version-of-row-1"');
		expect(tokens[0]).toContain('form="register-form"');
		expect(html).toContain('name="confirm"');
	});
	it('carries no token while nothing awaits confirmation', () => {
		expect(page(null)).not.toContain('name="deleteVersion"');
	});
});
