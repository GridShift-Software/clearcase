// The pdf.js adapter for the hosted native viewer. NOT part of the Worker bundle: the parent copies this file next to
// the pinned pdf.js build (docs/acceptance/native-viewer.md, "Parent handoffs") and the viewer component loads it from
// the same origin. It registers window.clearcasePdfReader and nothing else; it opens the PDF with `fetch` (the one
// destination the original route serves inline) and draws one page at a time to a canvas. No scripting, no XFA, no eval,
// no external link is followed, and no byte leaves this origin.
import * as pdfjs from './pdf.min.mjs';

// The viewer's own worker: the pinned pdf.js worker with one reviewed patch (scripts/hosted-pdf-assets.ts, WORKER_PATCH).
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf-viewer-worker.mjs', import.meta.url).href;
const base = new URL('./', import.meta.url).href;
// Every request to the original route costs a round trip of about 300 ms before its first byte, so the reader keeps the
// sequential ones few: 256 KiB chunks (a file up to 512 KiB is one plain GET), and for a larger file of known size the
// last MiB, where a file that is not linearized keeps its cross-reference table, starts with the first byte instead of
// after it. The whole file still streams from the start, as pdf.js does by default.
export const CHUNK = 1 << 18, TAIL = 1 << 20;

/** A pdf.js range transport over one same-origin URL: the file streams from byte 0 and its tail is read at once. */
export class Ranges extends pdfjs.PDFDataRangeTransport {
	#src; #signal; #fail; #tail;
	constructor({ src, size, signal, fail }) {
		super(size, null);
		this.#src = src; this.#signal = signal; this.#fail = fail;
		const start = Math.max(0, Math.floor((size - TAIL) / CHUNK) * CHUNK);
		this.#tail = { start, bytes: this.#get(start, size) };
		this.#tail.bytes.catch(() => {});
	}
	async #get(begin, end) {
		const r = await fetch(this.#src, { headers: { range: `bytes=${begin}-${end - 1}` }, credentials: 'same-origin', signal: this.#signal });
		if (r.status !== 206 || r.headers.get('content-range') !== `bytes ${begin}-${end - 1}/${this.length}`) throw new Error('range refused');
		const bytes = new Uint8Array(await r.arrayBuffer());
		if (bytes.byteLength !== end - begin) throw new Error('short range');
		return bytes;
	}
	async stream() {
		try {
			const r = await fetch(this.#src, { credentials: 'same-origin', signal: this.#signal });
			if (r.status !== 200 || !r.body) throw new Error('stream refused');
			for (const reader = r.body.getReader(); ;) {
				const { value, done } = await reader.read();
				if (done) break;
				this.onDataProgressiveRead(value);
			}
			this.onDataProgressiveDone();
		} catch (error) { this.#fail(error); }
	}
	requestDataRange(begin, end) {
		const { start, bytes } = this.#tail;
		(begin >= start ? bytes.then((b) => b.slice(begin - start, end - start)) : this.#get(begin, end)).then((b) => this.onDataRange(begin, b), this.#fail);
	}
}

/** Whether the drawn page skipped an image pdf.js could not decode. pdf.js only warns and draws the page without it, so a
 *  scan comes out blank; its failed image object resolves to null. A page's own images are in `objs`; an image shared
 *  across pages is in `commonObjs` and counts only when this page paints it. */
async function undecoded(page) {
	for (const [, data] of page.objs) if (data === null) return true;
	const shared = new Set();
	for (const [id, data] of page.commonObjs) if (data === null) shared.add(id);
	if (!shared.size) return false;
	const { argsArray } = await page.getOperatorList();
	return argsArray.some((args) => Array.isArray(args) && shared.has(args[0]));
}

window.clearcasePdfReader = {
	/** Opens `src` (`size`, its byte length, when known); resolves { pages, draw(page, scale), destroy() } or rejects when the file cannot be read as a PDF.
	 *  `pages` is /Count until the worker's deferred last-page check corrects it; `onPages` then receives the real count. */
	async open({ src, size, canvas, signal, onPages }) {
		// A refused or failed read rejects the open and every draw (the viewer then offers the download), never leaves them waiting.
		const reads = new AbortController();
		let failed;
		const failure = new Promise((_, reject) => { failed = reject; });
		failure.catch(() => {});
		const fail = (error) => { if (destroyed) return; failed(error); reads.abort(); void task.destroy().catch(() => {}); };
		const ranges = Number.isSafeInteger(size) && size > 2 * CHUNK ? new Ranges({ src, size, signal: reads.signal, fail }) : null;
		const task = pdfjs.getDocument({
			...(ranges ? { range: ranges } : { url: src, withCredentials: false }), rangeChunkSize: CHUNK,
			isEvalSupported: false, enableXfa: false, enableScripting: false, useWasm: false,
			standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, iccUrl: `${base}iccs/`,
			// pdf.js decodes CCITT fax and JBIG2 (most scans) and JPX through its JBIG2 and OpenJPEG modules; without wasm it
			// imports their JS builds from here (scripts/hosted-pdf-assets.ts, DECODERS). Unset, every such image fails.
			wasmUrl: `${base}wasm/`,
		});
		void ranges?.stream();
		let ticket = 0, destroyed = false, rendering = null;
		let tail = Promise.resolve();
		const destroy = () => {
			if (destroyed) return;
			destroyed = true;
			ticket++;
			signal?.removeEventListener('abort', destroy);
			rendering?.cancel();
			reads.abort();
			void task.destroy().catch(() => {});
		};
		signal?.addEventListener('abort', destroy, { once: true });
		if (signal?.aborted) destroy();
		let doc;
		try {
			doc = await Promise.race([task.promise, failure]);
			if (destroyed) throw new Error('reader cancelled');
		} catch (error) { destroy(); throw error; }
		// The served worker checks the last page only after drawing one (scripts/hosted-pdf-assets.ts, WORKER_PATCH), so a
		// wrong /Count is found after the open. Its added request answers once that check has run: the corrected count, or null.
		// A recount that cannot be asked or answered leaves the count as it was; it never fails a draw.
		let pages = doc.numPages, counted = null;
		const asked = () => doc._transport.messageHandler.sendWithPromise('ClearcasePageCount', null);
		const recount = () => {
			counted ??= Promise.race([Promise.resolve().then(asked), failure]).then((n) => {
				if (destroyed || !Number.isSafeInteger(n) || n < 1 || n === pages) return;
				pages = n;
				onPages?.(n);
			}, () => {});
		};
		return {
			get pages() { return pages; },
			draw(number, scale, fitWidth) {
				const mine = ++ticket;
				rendering?.cancel();
				// Cancel promptly, but do not resize or reuse the canvas until the prior RenderTask settles.
				const drawing = tail.then(async () => {
					if (destroyed || mine !== ticket) return;
					if (number > pages) throw new Error('no such page');
					const page = await Promise.race([doc.getPage(number), failure]);
					if (destroyed || mine !== ticket) return;
					const natural = page.getViewport({ scale: 1 });
					const fit = Number.isFinite(fitWidth) && fitWidth > 0 ? Math.min(1, fitWidth / (natural.width * 1.2)) : 1;
					const viewport = page.getViewport({ scale: scale * fit });
					canvas.width = Math.floor(viewport.width);
					canvas.height = Math.floor(viewport.height);
					const render = rendering = page.render({ canvas, viewport });
					try { await Promise.race([render.promise, failure]); }
					finally { if (rendering === render) rendering = null; }
					if (destroyed || mine !== ticket) return;
					if (await undecoded(page)) throw new Error('image not decoded');
					recount();
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
