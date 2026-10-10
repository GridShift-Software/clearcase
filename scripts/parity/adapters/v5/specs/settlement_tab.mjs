// v5 spec: Settlement / BATNA (GRS-16, CC-06). The generic extraction reads the model run on the defaults; this sweep
// changes one assumption at a time and presses Model (scenario 8): the probability near both clamps, zero years, and
// a claim typed with the app's own thousands separator. Synthetic inputs only; it records the three KPIs (label and
// value) and any error line. The app adapter runs the same cases through the app's form.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { domExtract } from '../../../lib/dom.mjs';

export const CASES = { defaults: {}, p95: { p: '95' }, p10: { p: '10' }, y0: { y: '0' }, claim_separated: { claim: '1 000 000' } };
export const FIELD_ID = { claim: 'se_claim', p: 'se_p', y: 'se_y', d: 'se_d', c: 'se_c' };

export function readOutput(raw, error) {
	const out = {};
	(raw?.kpis ?? []).forEach((k, i) => { out[`k${i}.label`] = k.label; out[`k${i}.value`] = k.value; });
	if (error) out.error = error;
	return out;
}
export const fillScript = (values) => `(() => { for (const [id, v] of ${JSON.stringify(values)}) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } })()`;

const model = {
	id: 'model',
	async v5(p) {
		const out = {};
		for (const [name, c] of Object.entries(CASES)) {
			await p.load({});
			await p.go('settlement_tab');
			await p.evaluate(fillScript(Object.entries(c).map(([k, v]) => [FIELD_ID[k], v])));
			await p.evaluate(`[...document.querySelectorAll('#main button')].find((b) => /^\\s*model\\s*$/i.test(b.textContent)).setAttribute('data-parity-model', '1')`);
			await p.click('[data-parity-model]');
			await sleep(20);
			for (const [k, v] of Object.entries(readOutput(await p.evaluate(`(${domExtract.toString()})('#se_out', {})`), null))) out[`${name}.${k}`] = v;
		}
		return out;
	},
};

export default { sweeps: [model] };
