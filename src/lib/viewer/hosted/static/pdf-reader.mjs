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
	async open({ src, canvas, signal }) {
		const task = pdfjs.getDocument({
			url: src, withCredentials: false, isEvalSupported: false, enableXfa: false, enableScripting: false, useWasm: false,
			standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, iccUrl: `${base}iccs/`,
		});
		let ticket = 0, destroyed = false, rendering = null;
		let tail = Promise.resolve();
		const destroy = () => {
			if (destroyed) return;
			destroyed = true;
			ticket++;
			signal?.removeEventListener('abort', destroy);
			rendering?.cancel();
			void task.destroy().catch(() => {});
		};
		signal?.addEventListener('abort', destroy, { once: true });
		if (signal?.aborted) destroy();
		let doc;
		try {
			doc = await task.promise;
			if (destroyed) throw new Error('reader cancelled');
		} catch (error) { destroy(); throw error; }
		return {
			pages: doc.numPages,
			draw(number, scale) {
				const mine = ++ticket;
				rendering?.cancel();
				// Cancel promptly, but do not resize or reuse the canvas until the prior RenderTask settles.
				const drawing = tail.then(async () => {
					if (destroyed || mine !== ticket) return;
					const page = await doc.getPage(number);
					if (destroyed || mine !== ticket) return;
					const viewport = page.getViewport({ scale });
					canvas.width = Math.floor(viewport.width);
					canvas.height = Math.floor(viewport.height);
					const render = rendering = page.render({ canvas, viewport });
					try { await render.promise; }
					finally { if (rendering === render) rendering = null; }
				}).catch((error) => {
					// A superseded/destroyed draw has no UI to report to. Current PDF failures still reject.
					if (!destroyed && mine === ticket) throw error;
				});
				// A current failure must not poison the queue for a later attempt.
				tail = drawing.catch(() => {});
				return drawing;
			},
			destroy,
		};
	},
};
window.dispatchEvent(new Event('clearcase:pdf-reader'));
