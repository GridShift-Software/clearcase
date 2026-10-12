// v5 spec: Interest Recalculator (GRS-16, CC-06). The generic extraction never presses Compute, so this sweep fills
// the form and presses it: the defaults as shown, the expected examples interest-simple and interest-compound
// (synthetic capital 100000, rate 10, 2004-02-03 to 2005-02-03), a capital typed with the app's own separator
// (`100 000`, S-interest_calc_tab-1) and a reversed period (S-interest_calc_tab-3). It records the output KPIs and
// any error line. The app adapter runs the same cases through the app's form.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { domExtract } from '../../../lib/dom.mjs';

const EXAMPLE = { p: '100000', r: '10', from: '2004-02-03', to: '2005-02-03' };
/** Each case: the fields it changes from the defaults (null: keep the default). */
export const CASES = {
	defaults: {},
	simple: { ...EXAMPLE, m: 'Simple' },
	compound: { ...EXAMPLE, m: 'Compound (monthly)' },
	separated: { ...EXAMPLE, p: '100 000', m: 'Simple' },
	reversed: { ...EXAMPLE, from: EXAMPLE.to, to: EXAMPLE.from, m: 'Simple' },
};
/** v5's field ids by case key. */
export const FIELD_ID = { p: 'ic_p', r: 'ic_r', m: 'ic_m', from: 'ic_from', to: 'ic_to' };

/** The output as the sweep records it: each KPI's label, value and caption by position, and the error line. */
export function readOutput(raw, error) {
	const out = {};
	(raw?.kpis ?? []).forEach((k, i) => { out[`k${i}.label`] = k.label; out[`k${i}.value`] = k.value; out[`k${i}.sub`] = k.sub; });
	if (error) out.error = error;
	return out;
}

/** Set fields by id in the page and fire input and change, as a user agent does. */
export const fillScript = (values) => `(() => { for (const [id, v] of ${JSON.stringify(values)}) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } })()`;

const compute = {
	id: 'compute',
	async v5(p) {
		const out = {};
		for (const [name, c] of Object.entries(CASES)) {
			await p.load({});
			await p.go('interest_calc_tab');
			await p.evaluate(fillScript(Object.entries(c).map(([k, v]) => [FIELD_ID[k], v])));
			await p.evaluate(`[...document.querySelectorAll('#main button')].find((b) => /compute/i.test(b.textContent)).setAttribute('data-parity-compute', '1')`);
			await p.click('[data-parity-compute]');
			await sleep(20);
			for (const [k, v] of Object.entries(readOutput(await p.evaluate(`(${domExtract.toString()})('#ic_out', {})`), null))) out[`${name}.${k}`] = v;
		}
		return out;
	},
};

export default { sweeps: [compute] };
