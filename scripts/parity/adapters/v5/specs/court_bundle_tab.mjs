// v5 sweeps for Court Bundle (GRS-19): the Word indexes (which match no export pattern, so the first state never
// presses them) and one bundle's Index and Items tabs. Drivers are shared with the app adapter
// (scripts/parity/adapters/app/court_bundle_tab.mjs), which passes its own steps; keys are index-coded.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { parseDownload } from '../../../lib/exports.mjs';

const VIEW = 'court_bundle_tab';

/** Tag the first visible element under `scope` matching `sel` whose text is `text`, and click it. */
export async function clickText(p, scope, sel, text) {
	const ok = await p.evaluate(`(() => { document.querySelectorAll('[data-parity-pick]').forEach((e) => e.removeAttribute('data-parity-pick')); const e = [...document.querySelectorAll(${JSON.stringify(`${scope} ${sel}`)})].find((x) => x.getClientRects().length && x.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)}); if (!e) return false; e.setAttribute('data-parity-pick', '1'); return true; })()`);
	return ok && p.click('[data-parity-pick]');
}
/** Cell text with block elements as separate parts joined ' / ', as the shared extractor reads table cells. */
const CELL = `(c) => { let out = ''; const walk = (n) => { if (n.nodeType === 3) { out += n.nodeValue; return; } if (n.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(n.tagName)) return; const b = /^(DIV|P|BR|LI|TR)$/.test(n.tagName); if (b) out += '\\u0001'; for (const x of n.childNodes) walk(x); if (b) out += '\\u0001'; }; walk(c); return out.split('\\u0001').map((s) => s.replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' / '); }`;
export const tableRows = (p, sel) => p.evaluate(`(() => { const cell = ${CELL}; return [...document.querySelectorAll(${JSON.stringify(sel)})].map((r) => [...r.cells].map(cell).join(' | ')); })()`);
export const tableCells = (p, sel) => p.evaluate(`(() => { const cell = ${CELL}; return [...document.querySelectorAll(${JSON.stringify(sel)})].map((r) => [...r.cells].map(cell)); })()`);
const NS = ' (not in the verified index; not served)';
const ITEM_CELLS = ['item', 'ref', 'desc', 'from', 'pages', 'page_nos', 'actions'];
/**
 * One items row as its own keys (items.r<i>.<cell>), so each cell compares exactly. The Extracted-from cell's link
 * state per part (v5's ↗, the app's not-served marker, or '-') is split from its text (items.r<i>.from_link.<k>).
 */
export function itemCells(i, cells) {
	const out = {};
	cells.forEach((c, j) => {
		const k = `items.r${i}.${ITEM_CELLS[j] ?? `c${j}`}`;
		if (ITEM_CELLS[j] !== 'from') { out[k] = c; return; }
		const parts = c.split(' / ');
		out[k] = parts.map((x) => x.replace(NS, '').replace(' ↗', '')).join(' / ');
		parts.forEach((x, n) => { out[`items.r${i}.from_link.${n}`] = x.includes(NS) ? NS.trim().slice(1, -1) : x.includes(' ↗') ? '↗' : '-'; });
	});
	return out;
}
const texts = (p, sel) => p.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);

async function capture(p, press) {
	await p.takeDownloads();
	await press();
	await sleep(150);
	return Promise.all((await p.takeDownloads()).map(parseDownload));
}
const docxCombos = (out, k, got) => {
	out[`${k}.count`] = String(got.length);
	out[`${k}.name`] = got[0]?.name ?? '';
	(got[0]?.text ?? '').split('\n').forEach((l, i) => { out[`${k}.p${i}`] = l; });
};

/** side: { fresh(p, ctx), wordAll(p), openFirst(p), wordOne(p), itemsTab(p), title(p), sub(p), indexHead, indexRows, itemsRows } */
export function runSweeps(side) {
	return {
		async docx(p, ctx) {
			const out = {};
			await side.fresh(p, ctx);
			docxCombos(out, 'all', await capture(p, () => side.wordAll(p)));
			await side.fresh(p, ctx);
			await side.openFirst(p);
			docxCombos(out, 'b0', await capture(p, () => side.wordOne(p)));
			return out;
		},
		async bundle_tabs(p, ctx) {
			const out = {};
			await side.fresh(p, ctx);
			await side.openFirst(p);
			out.title = await side.title(p);
			out.sub = await side.sub(p);
			out['index.head'] = (await texts(p, side.indexHead)).join(' | ');
			(await tableRows(p, side.indexRows)).forEach((r, i) => { out[`index.r${i}`] = r; });
			await side.itemsTab(p);
			(await tableCells(p, side.itemsRows)).forEach((cells, i) => Object.assign(out, itemCells(i, cells)));
			return out;
		},
	};
}

const V5 = {
	fresh: async (p) => { await p.load({}); await p.go(VIEW); },
	wordAll: (p) => clickText(p, '#main', 'button', 'All indexes (Word)'),
	openFirst: async (p) => { await clickText(p, '#main table tbody tr', 'button', 'Open'); await sleep(60); },
	wordOne: (p) => clickText(p, '#main', 'button', 'Download Word (.docx)'),
	itemsTab: async (p) => { await clickText(p, '#main .toolbar', 'button', 'Items & page numbers'); await sleep(60); },
	title: (p) => p.evaluate(`document.querySelector('#main .pagehead h1')?.textContent.trim() ?? ''`),
	sub: (p) => p.evaluate(`(document.querySelector('#main .pagehead .meta')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`),
	indexHead: '#cbindexdoc > p',
	indexRows: '#cbindexdoc table.cbixt tr',
	itemsRows: '#main table.tbl tbody tr',
};
export default { sweeps: Object.entries(runSweeps(V5)).map(([id, fn]) => ({ id, v5: (p, ctx) => fn(p, ctx) })) };
