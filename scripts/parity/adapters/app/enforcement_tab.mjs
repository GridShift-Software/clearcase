// App adapter: Enforcement Roadmap (GRS-18). The generic extraction over #main, and the status sweep of
// specs/enforcement_tab.mjs through the app's own select: change step 3, wait for "Saved", reload, read. The sweep
// then sets the step back to its imported status, so the run's later readings see the imported roadmap again.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { STEP, TO } from '../v5/specs/enforcement_tab.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'enforcement_tab';
const statuses = (p) => p.evaluate(`[...document.querySelectorAll('#main table tbody select')].map((s) => s.value)`);
const record = (out, step, values) => { out[`${step}.count`] = String(values.length); values.forEach((v, i) => { out[`${step}.${i}`] = v; }); };

/** Choose `value` in step `i`'s select and wait until the row says Saved (or shows an error). */
async function choose(p, i, value) {
	const ok = await p.evaluate(`(() => { const s = [...document.querySelectorAll('#main table tbody select')][${i}]; if (!s) return false; s.setAttribute('data-parity-status', '1'); return true; })()`);
	if (!ok) return false;
	const r = await p.select('[data-parity-status]', value);
	if (r !== 'ok') return false;
	const t0 = Date.now();
	while (Date.now() - t0 < 15000) {
		const st = await p.evaluate(`(() => { const f = document.querySelector('[data-parity-status]')?.closest('form'); return f?.querySelector('[data-saved]') ? 'saved' : f?.querySelector('[data-save-error]') ? 'error' : null; })()`);
		if (st) return st === 'saved';
		await sleep(20);
	}
	return false;
}

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
		async status_edit(p, ctx) {
			const out = {};
			const route = ctx.registry[VIEW].route;
			await open(p, ctx, route, VIEW);
			const initial = await statuses(p);
			record(out, 'initial', initial);
			if (initial.length <= STEP) { out.change = 'no-step'; return out; }
			if (!(await choose(p, STEP, TO))) { out.change = 'not-saved'; return out; }
			await open(p, ctx, '/overview', 'overview');
			await open(p, ctx, route, VIEW);
			record(out, 'after', await statuses(p));
			// back to the imported status (an override equal to it shows nothing extra)
			if (!(await choose(p, STEP, initial[STEP]))) throw new Error('enforcement status sweep: could not restore the imported status');
			return out;
		},
	},
};
