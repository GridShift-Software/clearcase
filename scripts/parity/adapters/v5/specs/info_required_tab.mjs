// Info Required (GRS-15): the done checkbox, which v5 persists in ess_dcs_info_done_v1 and re-renders with the Item
// struck through. The sweep checks the second item, reads the struck rows, renders the view again from storage (v5's
// equivalent of a reload), unchecks it and reads again. Values are row positions, never case text.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';

const struck = (p) => p.evaluate(`[...document.querySelectorAll('#main tbody tr')].map((r, i) => /line-through/.test(r.cells[1]?.getAttribute('style') ?? '') ? i : null).filter((x) => x !== null).join(',')`);
const checked = (p) => p.evaluate(`[...document.querySelectorAll('#main tbody tr input[type=checkbox]')].map((c) => (c.checked ? 1 : 0)).join('')`);
const toggle = async (p, i) => {
	await p.evaluate(`document.querySelectorAll('#main tbody tr input[type=checkbox]')[${i}]?.setAttribute('data-parity-toggle', '1')`);
	await p.click('[data-parity-toggle]');
	await sleep(40);
};

export default {
	sweeps: [{
		id: 'toggle_done',
		async v5(p) {
			const out = {};
			await p.load({});
			await p.go('info_required_tab');
			out.initial = `${await struck(p)}|${await checked(p)}`;
			await toggle(p, 1);
			out.check_1 = `${await struck(p)}|${await checked(p)}`;
			await p.go('info_required_tab');
			out.reload = `${await struck(p)}|${await checked(p)}`;
			await toggle(p, 1);
			out.uncheck_1 = `${await struck(p)}|${await checked(p)}`;
			await p.go('info_required_tab');
			out.reload_after_uncheck = `${await struck(p)}|${await checked(p)}`;
			return out;
		},
	}],
};
