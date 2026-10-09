// Helpers of the analysis browser suite (GRS-15): synthetic packages for the seven analysis views and a page driver
// over the pilot's CDP browser. Synthetic data only; nothing here comes from a case.
import { mkdir, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newPage, sleep } from '../pilot/lib/cdp.mjs';
import { buildCase, url } from '../pilot/lib/fixtures.ts';
import { convertV5 } from '../../../src/lib/case-package/v5/adapter.ts';
import { writePackageDir } from '../../../src/lib/case-package/writer.ts';
import { synthHtml, synthOriginals, synthRoots, writeCaseFolder } from '../../case-package/fixtures/synth.ts';

const OD1 = url('DISCOVERY A/OD-001 Supply agreement.pdf');
const OD2 = url('DISCOVERY A/OD-002 Invoice 1001.pdf');
/** A long unbroken token and long sentences: the narrow-screen checks need text that cannot fit by luck. */
export const TOKEN = 'Unbrokensyntheticidentifier'.repeat(3);
const long = (s, n) => Array.from({ length: n }, (_, i) => `${s} ${i + 1}`).join(' ');

/** The analysis datasets of the main synthetic case: every view populated, with citations, missing refs and long text. */
export function analysisData(r) {
	const D = r.DATA;
	D.matter.storyline = [{ h: 'Start', t: 'The agreement [[OD-001]] began the relationship; see also [[ZZ-404]].' }, { h: 'Second step', t: 'A second invented paragraph.' }];
	D.matter.strategy = [{ h: 'Plan', t: 'Rely on [[OD-002#p2]].' }];
	D.riskMatrix = [
		{ issue: `Invented issue with a long identifier ${TOKEN}`, likelihood: 'High', impact: 'Medium', mitigation: long('Invented mitigation step', 30) },
		{ issue: 'Second invented issue', likelihood: 'high', impact: 'Low', mitigation: 'Short invented mitigation' },
	];
	const doc = (ref, u) => ({ date: '2001-02-03', doc_type: 'SLA', filename: `${ref} invented.pdf`, ref, url: u });
	D.defenceMatrix = [
		{ point: 'Invented point', dcs: long('Invented defence', 20), evidence: long('Invented evidence', 20), rebuttal: `${long('Invented rebuttal', 25)} ${TOKEN}`, refs: 'OD-001 – OD-002', docs: [doc('OD-001', OD1), doc('OD-002', OD2)] },
		{ point: 'Point without documents', dcs: 'Invented case', evidence: 'Invented evidence', rebuttal: 'Invented rebuttal', refs: '', docs: [] },
	];
	D.infoRequired = [
		{ item: 'Invented item A', owner: 'Ann', status: 'Outstanding' },
		{ item: 'Invented item B', owner: 'Ben', status: 'In progress' },
		{ item: 'Invented item C', owner: 'Cal', status: 'To verify' },
	];
	D.witnesses = [
		{ name: 'Ann Lee', role: 'Supply', willsay: 'States that the agreement [[OD-001]] was signed; see also [[ZZ-404]].' },
		{ name: 'Ben Ode', role: 'Finance', willsay: 'A plain invented statement naming Ann Lee and OD-002 without citation tokens.' },
	];
	D.timeline.phases = [['2001', 'Phase one', 'Invented note one'], ['2002–2003', 'Phase two', 'Invented note two'], ['2004', 'Quiet phase', 'Invented quiet note']];
	D.timeline.events = [
		{ date: '2001-02-03', kind: 'Contract', note: 'Invented note', ref: 'OD-001', title: 'Agreement & schedule <signed>', url: OD1 },
		{ date: '2001-03-01', kind: 'Invoice', note: '', ref: 'OD-002', title: '(3) First invoice.pdf', url: OD2 },
		{ date: '2002-05-05', kind: 'Letter', note: '', ref: 'OD-001', title: "Second 'letter'", url: OD1 },
		{ date: '', kind: 'Note', note: '', ref: 'OD-002', title: 'Undated invented event', url: OD2 },
	];
	D.timeline.yearCounts = { 2001: 7, 2002: 3, 2003: 1 };
	D.contradictions = {
		byCat: { rate: 2, units: 1 },
		categories: [
			{ key: 'rate', title: 'Invented rate conflict', severity: 'high', explain: 'Invented explanation', items: [
				{ label: `Invented month ${TOKEN}`, detail: '', rates: { 'BID RATE': '10', 'OLD RATE': '12', 'NEW/STANDARD': '15' }, spread: '5', refs: [{ amount: '100', filename: 'OD-002 Invoice 1001.pdf', ref: 'OD-002', url: OD2 }] },
				{ label: 'Second invented month', detail: '', rates: { 'BID RATE': '20', 'NEW RATE': '25' }, spread: '5', refs: [{ amount: '', filename: 'OD-001 Supply agreement.pdf', ref: 'OD-001', url: OD1 }] },
			] },
			{ key: 'units', title: 'Invented units divergence', severity: 'high', explain: long('Invented units explanation', 10), items: [{ label: 'Invented set', detail: long('Invented detail', 15), refs: [{ amount: '7', filename: 'OD-002 Invoice 1001.pdf', ref: 'OD-002', url: OD2 }] }] },
			{ key: 'dupamt', title: 'Invented duplicate', severity: 'low', explain: 'Invented', items: [{ label: 'INV-1', detail: 'Same number', spread: '3', refs: [{ amount: '', filename: 'OD-001 Supply agreement.pdf', ref: 'OD-001', url: OD1 }] }] },
			{ key: 'odd', title: 'Invented unknown severity', severity: 'critical', explain: 'Invented', items: [] },
		],
		checks: [{ check: 'Invented check passes', n: 1, result: 'PASS' }, { check: 'Invented check flags', n: 2, result: '2 FLAGGED' }, { check: 'Invented count', n: 3, result: '3 invented items' }],
		highCount: 3, total: 4,
	};
}

/** Every optional analysis dataset empty (the scenario 10 package). */
export function emptyAnalysis(r) {
	const D = r.DATA;
	D.matter.storyline = [];
	D.matter.strategy = [];
	D.riskMatrix = [];
	D.defenceMatrix = [];
	D.infoRequired = [];
	D.witnesses = [];
	D.timeline.events = [];
	D.timeline.phases = [];
	D.timeline.yearCounts = {};
	D.quantum.amountDueSeries = [];
	D.contradictions = { byCat: {}, categories: [], checks: [], highCount: 0, total: 0 };
}

/** A case like buildCase's, converted from a workspace without viewer code: its package has no view-content. */
export async function buildCaseWithoutViewContent(root, { caseId, edit }) {
	await mkdir(root, { recursive: true });
	const caseDir = join(root, 'case'), pkgDir = join(root, 'pkg');
	await rm(pkgDir, { recursive: true, force: true });
	await rm(caseDir, { recursive: true, force: true });
	await writeCaseFolder(caseDir, synthOriginals());
	const roots = synthRoots();
	edit?.(roots);
	const result = await convertV5({ html: synthHtml(roots, [], { viewCode: false }), htmlName: 'workspace.html', caseFolder: caseDir, caseId });
	if (!result.files || !result.manifest) throw new Error('synthetic conversion failed: ' + result.diagnostics.map((d) => d.code).join(','));
	await writePackageDir(pkgDir, result.files);
	return { root, caseDir, pkgDir, resultsVersion: result.manifest.resultsVersion, files: result.files };
}
export { buildCase };

/** One plain-text field of a package's view-content dataset, or null. */
export function viewContentText(sc, view, field) {
	const f = sc.files.get('datasets/view-content.json');
	const v = f ? JSON.parse(new TextDecoder().decode(f)).data?.[view]?.[field] : undefined;
	return typeof v === 'string' && v.trim() ? v : null;
}

/** A view is ready when its main says so; an analysis view (data-analysis) also after hydration, so clicks are handled. */
export const ready = (view) => `(() => { const m = document.querySelector('main#main'); return m?.dataset.ready === ${JSON.stringify(view)} && (!m.hasAttribute('data-analysis') || m.hasAttribute('data-hydrated')); })()`;

/**
 * A page on the app origin with the parity harness's capture hooks: Blob downloads and window.print are recorded in
 * the page, never written to disk or shown.
 */
export async function appPage(b, origin) {
	const p = await newPage(b);
	await p.s('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__an = { downloads: [], prints: 0 };
		const C = URL.createObjectURL.bind(URL); const blobs = new Map();
		URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
		const click = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { window.__an.downloads.push({ name: this.download, blob: o }); return; } return click.call(this); };
		window.print = () => { window.__an.prints++; }; })();` });
	p.origin = origin;
	p.goto = async (path, readyExpr, timeout = 30000) => { await p.navigate(origin + path, { timeout: 60000 }); if (readyExpr) await p.waitFor(readyExpr, timeout); };
	/** A real mouse click at the element's centre (scrolled into view); false when the selector matches nothing. */
	p.click = async (sel) => {
		const box = await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		if (!box) return false;
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
		return true;
	};
	p.viewport = (width, height = 900) => p.s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
	p.media = (media) => p.s('Emulation.setEmulatedMedia', { media });
	/** A full-page PNG (synthetic data only). */
	p.shot = async (file) => {
		const m = await p.s('Page.getLayoutMetrics');
		const { width, height } = m.cssContentSize ?? m.contentSize;
		const r = await p.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(width), height: Math.min(Math.ceil(height), 12000), scale: 1 } });
		writeFileSync(file, Buffer.from(r.data, 'base64'));
	};
	p.downloads = () => p.evaluate(`Promise.all(window.__an.downloads.splice(0).map(async (d) => ({ name: d.name, text: await d.blob.text() })))`);
	p.prints = () => p.evaluate(`(() => { const n = window.__an.prints; window.__an.prints = 0; return n; })()`);
	p.settle = () => sleep(60);
	return p;
}
