// v5 sweeps for Discovery Schedule (GRS-19): states the generic adapter does not reach. The drivers are shared with the
// app adapter (scripts/parity/adapters/app/discovery_tab.mjs), which passes its own selectors, so both sides run the
// same steps and encode results the same way. Queries are generic probes, never case values; combo keys are
// index-coded.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { parseDownload } from '../../../lib/exports.mjs';
import { seqValue } from '../../../lib/sweeps.mjs';

const VIEW = 'discovery_tab';
export const QUERIES = ['1', '12', 'letter', 'invoice', '.pdf', 'zzzq'];

export const V5 = {
	side: 'v5', q: '#ds-q', missing: '#main .ds-bar label input[type=checkbox]', rows: '#ds-list tbody tr[data-item]', file: '#ds-list .ds-chip input[type=checkbox]',
	build: '#main [data-act=bundle]', bundleRows: '#main table.ds-tbl tbody tr', dlindex: '#main [data-b=dlindex]', back: '#main [data-b=back]', clear: '#main [data-act=clear]',
	coverDl: '#main [data-act=cover-dl]', markO: '#main [data-act=mark][data-val=O]', markC: '#main [data-act=mark][data-val=C]', count: '#ds-count',
};
export const APP = {
	side: 'app', q: '#ds-q', missing: '#ds-missing', rows: '#ds-list tbody tr[data-item]', file: '#ds-list .ds-chip input[type=checkbox]',
	build: '#ds-build', bundleRows: '#ds-bundle-table tbody tr', dlindex: '#ds-dlindex', back: '#ds-back', clear: '#ds-clear',
	coverDl: '#ds-cover-dl', markO: '#ds-mark-o', markC: '#ds-mark-c', count: '#ds-count',
};
const modeSel = (m) => `#main .ds-switch button[data-mode="${m}"]`;

/** Wait until the app has saved every write (v5 writes synchronously). */
const settle = async (p, S) => { if (S.side === 'app') await p.waitFor(`document.querySelector('#main')?.dataset.pending === '0'`, 30000); await sleep(30); };
const pick = async (p, sel, n) => (await p.evaluate(`(() => { document.querySelectorAll('[data-parity-pick]').forEach((e) => e.removeAttribute('data-parity-pick')); const e = document.querySelectorAll(${JSON.stringify(sel)})[${n}]; if (!e) return false; e.setAttribute('data-parity-pick', '1'); return true; })()`)) && p.click('[data-parity-pick]');
const itemNos = (p, S) => p.evaluate(`[...document.querySelectorAll(${JSON.stringify(S.rows)})].map((r) => (r.querySelector('.ds-no')?.textContent ?? '').trim())`);
const text = (p, sel) => p.evaluate(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);
const missingLabel = (p, S) => p.evaluate(`(document.querySelector(${JSON.stringify(S.missing)})?.closest('label')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);
async function capture(p, S, sel) {
	await p.takeDownloads();
	await p.click(sel);
	await sleep(120);
	const got = await p.takeDownloads();
	return Promise.all(got.map(parseDownload));
}
async function state(p, S) {
	const nos = await itemNos(p, S);
	return `rows=${nos.length}|first=${nos[0] ?? ''}|last=${nos.at(-1) ?? ''}|${await missingLabel(p, S)}|filter=${await p.evaluate(`document.querySelector(${JSON.stringify(S.q)})?.value ?? ''`)}`;
}

/** The bundle index without its INCOMPLETE SELECTION line, and that line as `index_incomplete` when present. */
export function splitIncomplete(html) {
	const m = /<div class="cap"><b>INCOMPLETE SELECTION<\/b>: [^<]*<\/div>/.exec(html);
	return m ? { index_text: html.replace(m[0], ''), index_incomplete: m[0] } : { index_text: html };
}
/** The cover page with its C/O cells emptied, and each item's C/O as `cover_co.<i>` (row order). */
export function splitCoverCo(html) {
	const out = {};
	let i = 0;
	out.cover_text = html.replace(/<td class="co">([^<]*)<\/td>/g, (_, v) => { out[`cover_co.${i++}`] = v; return '<td class="co"></td>'; });
	return out;
}
/**
 * The schedule table's file actions as their own column (both sides): each file chip's text ends with its C and O
 * buttons and then its actions (v5 "OpenDownload"; the app "OpenDownload", or the not-served marker), so the
 * description and file names compare exactly and only the actions column can differ.
 */
const CHIP_ACTIONS = /CO(OpenDownload|Open|not in the verified index; not served)?$/;
export function splitFileActions(raw) {
	for (const t of raw.tables ?? []) {
		const at = t.header.findIndex((h) => /^Document\(s\)/.test(h));
		if (at < 0) continue;
		t.header.splice(at + 1, 0, 'File actions');
		t.rows = t.rows.map((cells) => {
			const [desc, ...chips] = cells[at] ?? [];
			const keep = [], acts = [];
			for (const c of chips) { const m = CHIP_ACTIONS.exec(c); if (m) { keep.push(c.slice(0, m.index + 2)); acts.push(m[1] ?? ''); } else keep.push(c); }
			return [...cells.slice(0, at), desc === undefined ? [] : [desc, ...keep], acts.length ? [acts.join(' / ')] : [], ...cells.slice(at + 1)];
		});
	}
}

/** The sweeps, given a side's selectors and a function that opens the view in its clean starting state. */
export function runSweeps(S, fresh) {
	return {
		/** Mode switches: each schedule's rows and unmatched count; then one cover download after three switches (S-discovery_tab-1). */
		async modes(p, ctx) {
			const out = {};
			await fresh(p, ctx);
			let i = 0;
			for (const m of ['supplementary', 'discovery', 'supplementary']) { await p.click(modeSel(m)); await settle(p, S); out[`${i++}.${m}`] = await state(p, S); }
			const got = await capture(p, S, S.coverDl);
			out.cover_after_switches = String(got.length);
			out.cover_after_switches_name = got[0]?.name ?? '';
			await p.click(modeSel('discovery'));
			await settle(p, S);
			return out;
		},
		/** Filter probes and the only-unmatched box, per schedule: the item numbers shown. */
		async filter(p, ctx) {
			const out = {};
			for (const m of ['discovery', 'supplementary']) {
				await fresh(p, ctx);
				await p.click(modeSel(m));
				await settle(p, S);
				for (const [k, q] of QUERIES.entries()) { await p.type(S.q, q); await sleep(320); out[`${m}.q${k}`] = seqValue(await itemNos(p, S)); }
				await p.type(S.q, '');
				await sleep(320);
				await p.click(S.missing);
				await sleep(60);
				out[`${m}.only_unmatched`] = seqValue(await itemNos(p, S));
			}
			await fresh(p, ctx);
			return out;
		},
		/** Two files from different schedules, the bundle view and its index download (order: schedule, item, file). */
		async bundle(p, ctx) {
			const out = {};
			await fresh(p, ctx);
			await pick(p, S.file, 0);
			await settle(p, S);
			await p.click(modeSel('supplementary'));
			await settle(p, S);
			await pick(p, S.file, 0);
			await settle(p, S);
			out.count = await text(p, S.count);
			await p.click(S.build);
			await sleep(80);
			out.rows = (await p.evaluate(`[...document.querySelectorAll(${JSON.stringify(S.bundleRows)})].map((r) => { const c = r.cells; const t = (e) => (e?.textContent ?? '').replace(/\\s+/g, ' ').trim(); return [t(c[0]), t(c[1]), t(c[2]), t(c[3]?.querySelector('.fn')), t(c[4]), t(c[5])].join(' | '); })`)).join('\n');
			const got = await capture(p, S, S.dlindex);
			out.index_count = String(got.length);
			out.index_name = got[0]?.name ?? '';
			// the INCOMPLETE SELECTION line is its own key (absent when complete), so the rest of the index compares exactly
			Object.assign(out, splitIncomplete(got[0]?.text ?? ''));
			await p.click(S.back);
			await sleep(60);
			await p.click(modeSel('discovery'));
			await settle(p, S);
			await p.click(S.clear);
			await settle(p, S);
			out.after_clear = await text(p, S.count);
			return out;
		},
		/** Mark one selected file Original: its chip and the cover page's C/O (S-discovery_tab-2); then restored to Copy. */
		async marks(p, ctx) {
			const out = {};
			await fresh(p, ctx);
			await pick(p, S.file, 0);
			await settle(p, S);
			await p.click(S.markO);
			await settle(p, S);
			out.chip = await p.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(S.file)})?.closest('.ds-chip'); return [...(c?.querySelectorAll('.ds-co button') ?? [])].map((b) => b.textContent.trim() + (b.className.includes('on-') ? '*' : '')).join(' '); })()`);
			const got = await capture(p, S, S.coverDl);
			out.cover_name = got[0]?.name ?? '';
			// the C/O column per item is its own key (cover_co.<i>), so the rest of the cover compares exactly
			Object.assign(out, splitCoverCo(got[0]?.text ?? ''));
			await p.click(S.markC);
			await settle(p, S);
			await p.click(S.clear);
			await settle(p, S);
			return out;
		},
	};
}

const v5Fresh = async (p) => { await p.load({}); await p.go(VIEW); };
const sweeps = runSweeps(V5, v5Fresh);
export default { postRaw: splitFileActions, sweeps: Object.entries(sweeps).map(([id, fn]) => ({ id, v5: (p, ctx) => fn(p, ctx) })) };
