import { AnnotationLayer, AnnotationMode, GlobalWorkerOptions, TextLayer, getDocument } from './pdf.min.mjs';

const BASE = new URL('./', import.meta.url).href;
GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
const OPTIONS = Object.freeze({ enableScripting: false, hasJSActions: false, renderForms: false });

const body = document.body;
const statusEl = document.getElementById('status');
const jsNote = document.getElementById('js-note');
const pagesEl = document.getElementById('pages');
const state = (window.__viewer = { numPages: 0, rendered: 0, current: 0, jsActions: null, options: OPTIONS, error: null });
const publish = () => { body.dataset.state = JSON.stringify(state); };
const ready = (v) => {
	body.dataset.ready = v;
	publish();
	try { parent.postMessage({ ready: v }, location.origin); } catch {   }
};

let pdf = null;
let scale = 1;
const slots = [];

const wantedPage = () => {
	const m = /(?:^#|&)page=(\d+)/.exec(location.hash);
	return m ? Math.min(Math.max(1, +m[1]), state.numPages || 1) : 1;
};
function show(n) {
	const s = slots[n - 1];
	if (!s) return;
	s.div.scrollIntoView({ block: 'start' });
	state.current = n;
	statusEl.textContent = `Page ${n} of ${state.numPages}`;
	render(n);
}

const linkService = {
	externalLinkEnabled: false,
	eventBus: { dispatch() {}, on() {}, off() {}, _on() {}, _off() {} },
	get pagesCount() { return state.numPages; },
	get page() { return state.current; },
	set page(n) { show(n); },
	rotation: 0,
	isInPresentationMode: false,
	addLinkAttributes(link, url) {
		link.removeAttribute('href');
		link.title = `External link, not followed: ${url}`;
		link.dataset.blocked = 'external';
	},
	getDestinationHash: () => '#',
	getAnchorUrl: () => '#',
	async goToDestination(dest) {
		const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
		const ref = Array.isArray(explicit) ? explicit[0] : null;
		const idx = ref && typeof ref === 'object' ? await pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
		if (idx !== null) show(idx + 1);
	},
	goToPage(n) { show(n); },
	executeNamedAction(a) { if (a === 'NextPage') show(state.current + 1); else if (a === 'PrevPage') show(state.current - 1); else if (a === 'FirstPage') show(1); else if (a === 'LastPage') show(state.numPages); },
	executeSetOCGState() {},
	setHash() {}
};

async function render(n) {
	const s = slots[n - 1];
	if (!s || s.state) return;
	s.state = 'rendering';
	const page = await pdf.getPage(n);
	const vp = page.getViewport({ scale });
	const div = s.div;
	div.style.width = `${Math.floor(vp.width)}px`;
	div.style.height = `${Math.floor(vp.height)}px`;
	div.style.setProperty('--scale-factor', String(vp.scale));
	div.style.setProperty('--user-unit', String(vp.userUnit ?? 1));
	div.style.setProperty('--total-scale-factor', String(vp.scale * (vp.userUnit ?? 1)));
	const ratio = window.devicePixelRatio || 1;
	const canvas = document.createElement('canvas');
	canvas.width = Math.floor(vp.width * ratio);
	canvas.height = Math.floor(vp.height * ratio);
	canvas.style.width = `${Math.floor(vp.width)}px`;
	canvas.style.height = `${Math.floor(vp.height)}px`;
	div.append(canvas);
	await page.render({ canvas, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined, annotationMode: AnnotationMode.ENABLE }).promise;
	const text = document.createElement('div');
	text.className = 'textLayer';
	div.append(text);
	await new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp }).render().catch(() => {});
	const annots = await page.getAnnotations({ intent: 'display' }).catch(() => []);
	if (annots.length) {
		const layer = document.createElement('div');
		layer.className = 'annotationLayer';
		div.append(layer);
		await new AnnotationLayer({ div: layer, page, viewport: vp.clone({ dontFlip: true }), linkService })
			.render({ annotations: annots, linkService, ...OPTIONS }).catch((e) => console.warn('annotation layer', e?.message));
	}
	s.state = 'done';
	div.dataset.rendered = '1';
	state.rendered++;
	publish();
	if (n === wantedPage() && body.dataset.ready !== '1') ready('1');
}

async function main(data) {
	const task = getDocument({
		data,
		useWasm: false, // no 'wasm-unsafe-eval' in the CSP either; pdf.js falls back to its JS decoders
		wasmUrl: BASE + 'wasm/',
		standardFontDataUrl: BASE + 'standard_fonts/',
		cMapUrl: BASE + 'cmaps/',
		iccUrl: BASE + 'iccs/',
		enableXfa: false,
		useSystemFonts: false,
		stopAtErrors: false
	});
	try {
		pdf = await task.promise;
	} catch (e) {
		state.error = String(e?.message ?? e);
		statusEl.textContent = `This file cannot be displayed (${state.error}). Use Download.`;
		ready('error');
		return;
	}
	state.numPages = pdf.numPages;
	const docJs = await pdf.getJSActions().catch(() => null);
	const docJsKeys = docJs ? (docJs instanceof Map ? [...docJs.keys()] : Object.keys(docJs)) : [];
	const fieldJs = await pdf.hasJSActions().catch(() => false);
	state.jsActions = { document: docJsKeys, fields: fieldJs };
	publish();
	if (docJsKeys.length || fieldJs) {
		jsNote.hidden = false;
		jsNote.textContent = `This PDF contains JavaScript (${[...docJsKeys, ...(fieldJs ? ['form fields'] : [])].join(', ')}). It was not run.`;
		body.dataset.jsActions = 'present';
	}
	const first = await pdf.getPage(1);
	const vp1 = first.getViewport({ scale: 1 });
	scale = Math.min(2, Math.max(0.5, (pagesEl.clientWidth - 32) / vp1.width));
	const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) render(+e.target.dataset.page); }, { rootMargin: '150% 0px' });
	for (let n = 1; n <= pdf.numPages; n++) {
		const div = document.createElement('div');
		div.className = 'page';
		div.id = `page-${n}`;
		div.dataset.page = String(n);
		div.style.width = `${Math.floor(vp1.width * scale)}px`;
		div.style.height = `${Math.floor(vp1.height * scale)}px`;
		pagesEl.append(div);
		slots.push({ div, state: null });
		io.observe(div);
	}
	show(wantedPage());
	addEventListener('hashchange', () => show(wantedPage()));
}

let started = false;
addEventListener('message', (e) => {
	if (started || e.source !== parent || parent === window || !(e.data?.pdf instanceof ArrayBuffer)) return;
	started = true;
	main(new Uint8Array(e.data.pdf)).catch((err) => { state.error = String(err?.message ?? err); statusEl.textContent = `Viewer error: ${state.error}`; ready('error'); });
});
publish();
