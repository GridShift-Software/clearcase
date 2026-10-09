// App adapter: Info Required (GRS-15). The generic extraction reads the checklist table; the toggle_done sweep drives
// the done checkbox like v5's spec does, with a real reload in between, and leaves the item unchecked again.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open, ready } from './_shell.mjs';

const VIEW = 'info_required_tab';
const struck = (p) => p.evaluate(`[...document.querySelectorAll('#info-table tbody tr')].map((r, i) => r.cells[1]?.classList.contains('struck') ? i : null).filter((x) => x !== null).join(',')`);
const checked = (p) => p.evaluate(`[...document.querySelectorAll('#info-table tbody tr input[type=checkbox]')].map((c) => (c.checked ? 1 : 0)).join('')`);
const saved = (p) => p.waitFor(`!document.querySelector('#info-table [aria-busy="true"]')`, 30000);
const toggle = async (p, i) => {
	await p.evaluate(`document.querySelectorAll('#info-table tbody tr input[type=checkbox]')[${i}]?.setAttribute('data-parity-toggle', '1')`);
	await p.click('[data-parity-toggle]');
	await sleep(40);
	await saved(p);
};
const state = async (p) => `${await struck(p)}|${await checked(p)}`;

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await open(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		async toggle_done(p, ctx) {
			const route = ctx.registry[VIEW].route;
			const out = {};
			await open(p, ctx, route, VIEW);
			out.initial = await state(p);
			await toggle(p, 1);
			out.check_1 = await state(p);
			await p.goto(`${ctx.base}${route}`, ready(VIEW));
			out.reload = await state(p);
			await toggle(p, 1);
			out.uncheck_1 = await state(p);
			await p.goto(`${ctx.base}${route}`, ready(VIEW));
			out.reload_after_uncheck = await state(p);
			return out;
		},
	},
};
