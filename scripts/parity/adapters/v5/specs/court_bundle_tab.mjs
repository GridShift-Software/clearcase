// v5 sweeps for Court Bundle (GRS-19): the Word indexes (which match no export pattern, so the first state never
// presses them) and one bundle's Index and Items tabs. Drivers are shared with the app adapter
// (scripts/parity/adapters/app/court_bundle_tab.mjs), which passes its own steps; keys are index-coded.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { docxText, parseDownload, unzip } from '../../../lib/exports.mjs';

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
		builder: (p, ctx) => builder(side, p, ctx),
	};
}

// ---- the builder (v5 CBBLD), on the committed synthetic PDFs only ------------------------------------------------
const CARD = (n) => `[...document.querySelectorAll('.card')].find((c) => (c.querySelector('h3, .chead')?.textContent ?? '').startsWith('${n} ·'))`;
const ITEMS = `[...(${CARD(2)}?.querySelectorAll('tbody tr') ?? [])].filter((r) => r.cells.length > 1)`;
const until = async (p, expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await p.evaluate(expr).catch(() => false)) return true; await sleep(100); } return false; };
/** Tag an element found by an expression, for p.click / p.type. */
const tag = (p, expr) => p.evaluate(`(() => { document.querySelectorAll('[data-parity-pick]').forEach((e) => e.removeAttribute('data-parity-pick')); const e = ${expr}; if (!e) return false; e.setAttribute('data-parity-pick', ''); return true; })()`);
/** Type into a field and commit it as leaving it does (both sides read descriptions and ranges on change). */
async function typeCommit(p, expr, value) {
	if (!(await tag(p, expr))) return false;
	await p.type('[data-parity-pick]', value);
	await p.evaluate(`(() => { const e = document.querySelector('[data-parity-pick]'); e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); })()`);
	await sleep(80);
	return true;
}
async function pickFiles(p, dir, names) {
	const { root } = await p.s('DOM.getDocument');
	const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector: '#cbbfile' });
	await p.s('DOM.setFileInputFiles', { nodeId, files: names.map((n) => join(dir, n)) });
}
/** In-page probes: alerts, revoked object URLs, and v5's PDFKDBG console logging (S-court_bundle_tab-14). */
const PROBES = `(() => { window.__b = { alerts: [], revoked: [], dbg: 0 }; window.alert = (m) => window.__b.alerts.push(String(m));
	const R = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = (u) => { window.__b.revoked.push(String(u)); return R(u); };
	const E = console.error.bind(console); console.error = (...a) => { if (/^DBG/.test(String(a[0]))) window.__b.dbg++; return E(...a); };
	window.PDFKDBG = 1; window.confirm = () => true; return true; })()`;
const OUT_HREF = `[...document.querySelectorAll('a[download]')].find((a) => a.textContent.trim() === 'Download PDF')?.href ?? ''`;
const rawDownloads = async (p, press) => { await p.takeDownloads(); await press(); await sleep(250); return (await p.takeDownloads()).map((d) => ({ name: d.name, buf: Buffer.from(d.base64, 'base64') })); };

/** A PDF as comparable facts: pages, per-page text items (stamps split out, with whether they sit in the visible box), links. */
async function pdfFacts(buf) {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
	const doc = await task.promise;
	const pages = [];
	for (let i = 1; i <= doc.numPages; i++) {
		const pg = await doc.getPage(i);
		const [x0, y0, x1, y1] = pg.view;
		const items = (await pg.getTextContent()).items.filter((x) => x.str.trim()).map((x) => ({ s: x.str.trim(), x: x.transform[4], y: x.transform[5] }));
		const links = [];
		for (const a of await pg.getAnnotations()) {
			if (a.subtype !== 'Link') continue;
			if (Array.isArray(a.dest) && a.dest[0] && typeof a.dest[0] === 'object') links.push('page ' + ((await doc.getPageIndex(a.dest[0])) + 1));
			else links.push(String(a.unsafeUrl ?? a.url ?? a.dest ?? '?'));
		}
		pages.push({ items, links, inView: (it) => it.x >= x0 && it.x <= x1 && it.y >= y0 && it.y <= y1 });
	}
	await task.destroy();
	// the font names each page's resources keep (S-court_bundle_tab-1), read with the engine's parser (imported here:
	// a copy of the parity folder alone must still load this spec)
	const { open: openPdf } = await import('../../../../../src/lib/bundles/pdf/index.ts');
	const d = await openPdf(new Uint8Array(buf));
	const fonts = d.pages().map((e) => { const res = d.get(e.dict.get('Resources') ?? e.inh.Resources); const f = res instanceof Map ? d.get(res.get('Font')) : null; return f instanceof Map ? [...f.keys()].sort().join(', ') : ''; });
	return { pages, fonts };
}
const RANGE = /^\d{3}( [–-] \d{3})?$/;
function pdfKeys(out, k, facts, indexPages) {
	out[`${k}.pages`] = String(facts.pages.length);
	facts.pages.forEach((pg, i) => {
		if (i < indexPages) {
			out[`${k}.index${i}.text`] = pg.items.filter((x) => !RANGE.test(x.s)).map((x) => x.s).join(' | ');
			out[`${k}.index${i}.ranges`] = pg.items.filter((x) => RANGE.test(x.s)).map((x) => x.s).join(' | ');
			out[`${k}.index${i}.links`] = pg.links.join(' | ');
			return;
		}
		const b = `${k}.body${i - indexPages + 1}`;
		const stamp = pg.items.filter((x) => /^\d+$/.test(x.s));
		out[`${b}.text`] = pg.items.filter((x) => !/^\d+$/.test(x.s)).map((x) => x.s).join(' | ');
		out[`${b}.stamp`] = [...new Set(stamp.map((x) => x.s))].join(' | ');
		out[`${b}.stamp_visible`] = stamp.length ? (stamp.every(pg.inView) ? 'inside the visible page' : 'outside the visible page') : 'no stamp on the visible page';
		out[`${b}.fonts`] = facts.fonts[i] ?? '';
	});
}
const docxKeys = (out, k, got) => {
	out[`${k}.name`] = got?.name ?? '';
	if (!got) return;
	docxText(got.buf).split('\n').forEach((l, i) => { out[`${k}.p${i}`] = l; });
	out[`${k}.links`] = [...(unzip(got.buf).get('word/_rels/document.xml.rels')?.toString('utf8') ?? '').matchAll(/Target="([^"]*)" TargetMode="External"/g)].map((m) => m[1]).join(' | ');
};
const LIST_CUSTOM = (rows) => `[...document.querySelectorAll(${JSON.stringify(rows)})].filter((r) => [...r.querySelectorAll('.badge')].some((b) => b.textContent.trim() === 'custom')).map((r) => { const a = r.querySelector('a[href^="blob:"], a[href*="/assembled?id="]'); return [r.cells[0].textContent.trim(), a ? (a.href.startsWith('blob:') ? (window.__b.revoked.includes(a.href) ? 'revoked' : 'live') : 'stored') : 'none']; })`;

/**
 * The builder end to end on both sides: pick (one locked), reorder, a range from page 2, a non-ASCII description,
 * Create, Index only, Word, Save twice, Create again, the list's links, Create then leave, and the saved items after a
 * reload. side.bld: { open(p, ctx), back(p), toList(p), leave(p), reload(p, ctx), listRows, openRow(p, no) }.
 */
async function builder(side, p, ctx) {
	const out = {};
	const { makePdf, SET } = await import('../../../../../tests/bundles/fixtures/make-pdfs.mjs');
	const dir = mkdtempSync(join(tmpdir(), 'parity-cb-'));
	try {
		for (const [n, o] of Object.entries(SET)) writeFileSync(join(dir, n), makePdf(o));
		await side.bld.open(p, ctx);
		await p.evaluate(PROBES);
		await pickFiles(p, dir, ['Alpha_Statement.pdf', 'Beta_Letter.pdf', 'Gamma_Report.pdf']);
		await until(p, `${ITEMS}.length === 3`);
		await pickFiles(p, dir, ['Alpha_Statement.pdf', 'Locked.pdf']);
		await until(p, `window.__b.alerts.length > 0`, 10000);
		await sleep(200);
		out.alerts = (await p.evaluate('window.__b.alerts')).join(' | ');
		out.files = (await p.evaluate(`[...(${CARD(1)}?.querySelectorAll('tbody tr') ?? [])].map((r) => r.cells[0].textContent.trim() + ':' + r.cells[1].textContent.trim()).join(' | ')`));
		// item 2 up; Alpha (now item 2) from page 2; item 1 described in non-ASCII text (S-6)
		await tag(p, `${ITEMS}[1]?.cells[5].querySelector('button')`) && (await p.click('[data-parity-pick]'));
		await sleep(80);
		await typeCommit(p, `${ITEMS}[1]?.cells[2].querySelectorAll('input')[0]`, '2');
		await typeCommit(p, `${ITEMS}[0]?.cells[1].querySelector('input')`, 'Déclaration Łukasz naïve');
		await typeCommit(p, `document.getElementById('cbbname')`, 'Synthetic Sweep');
		(await p.evaluate(`${ITEMS}.map((r) => [r.cells[1].querySelector('input').value, [...r.cells[2].querySelectorAll('select')].map((s) => s.selectedOptions[0]?.textContent.trim()).join('+'), [...r.cells[2].querySelectorAll('input')].map((i) => i.value).join('-'), r.cells[3].textContent.trim(), r.cells[4].textContent.trim()])`)).forEach((r, i) => { out[`items.r${i}`] = r.join(' | '); });
		out.total = await p.evaluate(`(${CARD(2)}?.querySelector('.toolbar .tag')?.textContent ?? '').trim()`);
		// Create Bundle
		await clickText(p, '', 'button', 'Create Bundle');
		await until(p, `!!(${OUT_HREF})`);
		out.output = await p.evaluate(`([...document.querySelectorAll('.badge.b-ok')].find((b) => /index \\+/.test(b.textContent))?.textContent ?? '').trim()`);
		const [full] = await rawDownloads(p, () => p.evaluate(`[...document.querySelectorAll('a[download]')].find((a) => a.textContent.trim() === 'Download PDF').click()`));
		out['pdf.name'] = full?.name ?? '';
		const indexPages = Number(/\((\d+) index/.exec(out.output)?.[1] ?? 1);
		if (full) pdfKeys(out, 'pdf', await pdfFacts(full.buf), indexPages);
		out['debug.console'] = (await p.evaluate('window.__b.dbg')) ? 'DBG lines logged' : 'none';
		// Index only (PDF) and Index (Word)
		const [idx] = await rawDownloads(p, () => clickText(p, '', 'button', 'Index only (PDF)'));
		out['index_only.name'] = idx?.name ?? '';
		if (idx) pdfKeys(out, 'index_only', await pdfFacts(idx.buf), 99);
		const [word] = await rawDownloads(p, () => clickText(p, '', 'button', 'Index (Word)'));
		docxKeys(out, 'word', word);
		// a range edited after Create, then the Word index again (L2352): v5 still links into the bundle, to the old pages
		await typeCommit(p, `${ITEMS}[1]?.cells[2].querySelectorAll('input')[1]`, '2');
		const [edited] = await rawDownloads(p, () => clickText(p, '', 'button', 'Index (Word)'));
		out['word_edited.links'] = edited ? [...(unzip(edited.buf).get('word/_rels/document.xml.rels')?.toString('utf8') ?? '').matchAll(/Target="([^"]*)" TargetMode="External"/g)].map((m) => m[1]).join(' | ') : '';
		await typeCommit(p, `${ITEMS}[1]?.cells[2].querySelectorAll('input')[1]`, '3');
		// Save twice from one output (S-12), then Create again (S-2)
		await clickText(p, '', 'button', 'Save to the bundle list');
		await until(p, `!document.getElementById('cbbname')`);
		await sleep(300);
		out['save.first'] = await side.title(p);
		await side.bld.back(p);
		await clickText(p, '', 'button', 'Save to the bundle list');
		await until(p, `!document.getElementById('cbbname')`);
		await sleep(300);
		out['save.second'] = await side.title(p);
		await side.bld.back(p);
		const before = await p.evaluate(OUT_HREF);
		await clickText(p, '', 'button', 'Create Bundle');
		await until(p, `(${OUT_HREF}) && (${OUT_HREF}) !== ${JSON.stringify(before)}`);
		await side.bld.toList(p);
		const custom = await p.evaluate(LIST_CUSTOM(side.bld.listRows));
		out['list.custom'] = custom.map((c) => c[0]).join(' | ');
		for (const [no, link] of custom) out[`list.custom.${no}.link`] = link;
		// Create, then leave for another view before it finishes (S-5)
		await side.bld.fromList(p);
		await p.evaluate(`(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Create Bundle').click(); ${side.bld.leave} })()`);
		await sleep(1500);
		out['leave_during_create'] = (await p.evaluate(`!!document.getElementById('cbbname')`)) ? 'the builder replaced the other view' : 'the other view stays';
		// after a reload: the saved item list, whose parts have no file (S-3)
		await side.bld.reload(p, ctx);
		await side.bld.openRow(p, custom[0]?.[0] ?? 'C1');
		await side.itemsTab(p);
		(await tableCells(p, side.itemsRows)).forEach((cells, i) => Object.assign(out, Object.fromEntries(Object.entries(itemCells(i, cells)).map(([k, v]) => [`saved.${k}`, v]))));
	} finally {
		rmSync(dir, { recursive: true, force: true });
		await side.bld.cleanup?.(p, ctx);
	}
	return out;
}

/** Click the Open button of the list row numbered `no`. */
export const openRow = async (p, rows, no) => { if (await tag(p, `[...document.querySelectorAll(${JSON.stringify(rows)})].find((r) => r.cells[0]?.textContent.trim() === ${JSON.stringify(no)})?.querySelector('button')`)) await p.click('[data-parity-pick]'); await sleep(300); };
export { until };

const V5_LIST = '#main table.tbl tbody tr';
const V5 = {
	bld: {
		open: async (p) => { await p.load({}); await p.go(VIEW); await clickText(p, '#main', 'button', 'Build a bundle'); await until(p, `!!document.getElementById('cbbfile')`); },
		back: async (p) => { await p.evaluate(`cbGo('build')`); await until(p, `!!document.getElementById('cbbname')`); },
		toList: async (p) => { await p.evaluate(`cbGo('list')`); await sleep(100); },
		fromList: async (p) => { await clickText(p, '#main', 'button', 'Build a bundle'); await until(p, `!!document.getElementById('cbbname')`); },
		leave: `go('overview');`,
		reload: async (p) => { const saved = JSON.parse((await p.evaluate(`localStorage.getItem('ess_dcs_custom_bundles_v1')`)) ?? '[]'); await p.load({ ess_dcs_custom_bundles_v1: saved }); await p.go(VIEW); },
		openRow: (p, no) => openRow(p, V5_LIST, no),
		listRows: V5_LIST,
	},
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
