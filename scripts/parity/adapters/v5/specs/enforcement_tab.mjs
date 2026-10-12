// v5 spec: Enforcement Roadmap (GRS-18). The generic extraction does not read a select's value, so this sweep reads
// every step's shown status, changes the status of step 3 (the checklist's example) to "Done", reloads the view and
// reads them again: the imported statuses and the saved override, compared value by value (index-coded keys only).
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';

export const STEP = 3;
export const TO = 'Done';
const statuses = (p) => p.evaluate(`[...document.querySelectorAll('#main table tbody select')].map((s) => s.value)`);
const record = (out, step, values) => { out[`${step}.count`] = String(values.length); values.forEach((v, i) => { out[`${step}.${i}`] = v; }); };

export default {
	sweeps: [{
		id: 'status_edit',
		async v5(p) {
			const out = {};
			await p.load({});
			await p.go('enforcement_tab');
			record(out, 'initial', await statuses(p));
			const ok = await p.evaluate(`(() => { const s = [...document.querySelectorAll('#main table tbody select')][${STEP}]; if (!s) return false; s.value = ${JSON.stringify(TO)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
			if (!ok) { out.change = 'no-step'; return out; }
			await sleep(20);
			await p.go('overview');
			await p.go('enforcement_tab');
			record(out, 'after', await statuses(p));
			return out;
		},
	}],
};
