// The pdf.js adapter for the hosted native viewer. NOT part of the Worker bundle: the parent copies this file next to
// the pinned pdf.js build (docs/acceptance/native-viewer.md, "Parent handoffs") and the viewer component loads it from
// the same origin. It registers window.clearcasePdfReader and nothing else; it opens the PDF with `fetch` (the one
// destination the original route serves inline) and draws one page at a time to a canvas. No scripting, no XFA, no eval,
// no external link is followed, and no byte leaves this origin.
import * as pdfjs from './pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
const base = new URL('./', import.meta.url).href;

window.clearcasePdfReader = {
	/** Opens `src`; resolves { pages, draw(page, scale), destroy() } or rejects when the file cannot be read as a PDF. */
	async open({ src, canvas }) {
		const task = pdfjs.getDocument({
			url: src, withCredentials: false, isEvalSupported: false, enableXfa: false, enableScripting: false, useWasm: false,
			standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, iccUrl: `${base}iccs/`,
		});
		const doc = await task.promise;
		let ticket = 0;
		return {
			pages: doc.numPages,
			async draw(number, scale) {
				const mine = ++ticket;
				const page = await doc.getPage(number);
				if (mine !== ticket) return;
				const viewport = page.getViewport({ scale });
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				await page.render({ canvas, viewport }).promise;
			},
			destroy() { ticket++; void task.destroy(); },
		};
	},
};
window.dispatchEvent(new Event('clearcase:pdf-reader'));
