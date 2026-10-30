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
// sequential ones few: 256 KiB chunks, a file up to 512 KiB is one plain GET, and a larger one reads its first 512 KiB
// and its last MiB (where a file that is not linearized keeps its cross-reference table) at once. After that pdf.js reads
// only the ranges a page or its page-count check needs, with no unconditional stream or auto-fetch. The deferred count
// check can still touch many chunks of a large original while page 1 is open (GRS-281, GRS-288).
export const CHUNK = 1 << 18, HEAD = 2 * CHUNK, TAIL = 1 << 20;
// The backing store follows devicePixelRatio, as src/lib/local-case/viewer/viewer.mjs does, up to the canvas area pdf.js's
// own viewer allows on a phone, and never below one pixel per CSS pixel.
const MAX_CANVAS_PIXELS = 5_242_880;

/** A pdf.js range transport over one same-origin URL: the head and the tail are read at once, then what pdf.js asks for. */
export class Ranges extends pdfjs.PDFDataRangeTransport {
	#src; #session; #signal; #fail; #held;
	/** `head`, when the reader already has it, is the file's first HEAD bytes. */
	constructor({ src, size, head, signal, fail }) {
		super(size, null);
		this.#src = src; this.#signal = signal; this.#fail = fail;
		// The asset ticket in `t` lasts 15 minutes. A page turned after that reads through the session instead, which the
		// route authorizes like any request without a ticket.
		const session = new URL(src, base);
		if (session.searchParams.has('t')) { session.searchParams.delete('t'); this.#session = session.href; }
		const start = Math.max(HEAD, Math.floor((size - TAIL) / CHUNK) * CHUNK);
		this.#held = [{ begin: 0, end: HEAD, bytes: head ? Promise.resolve(head) : this.#get(0, HEAD) }, { begin: start, end: size, bytes: this.#get(start, size) }];
		for (const { bytes } of this.#held) bytes.catch(() => {});
	}
	async #get(begin, end) {
		const src = this.#src;
		const r = await fetch(src, { headers: { range: `bytes=${begin}-${end - 1}` }, credentials: 'same-origin', signal: this.#signal });
		if (r.status === 404 && this.#session && src !== this.#session) { this.#src = this.#session; return this.#get(begin, end); }
		if (r.status !== 206 || r.headers.get('content-range') !== `bytes ${begin}-${end - 1}/${this.length}`) throw new Error('range refused');
		const bytes = new Uint8Array(await r.arrayBuffer());
		if (bytes.byteLength !== end - begin) throw new Error('short range');
		return bytes;
	}
	requestDataRange(begin, end) {
		const held = this.#held.find((h) => h.begin <= begin && end <= h.end);
		(held ? held.bytes.then((b) => b.slice(begin - held.begin, end - held.begin)) : this.#get(begin, end)).then((b) => this.onDataRange(begin, b), this.#fail);
	}
}

/** The first HEAD bytes of an original whose size the page did not give, and its size, from the answer's Content-Range. */
async function readHead(src, signal) {
	const r = await fetch(src, { headers: { range: `bytes=0-${HEAD - 1}` }, credentials: 'same-origin', signal });
	const range = r.status === 206 && /^bytes 0-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
	if (!range) throw new Error('range refused');
	const bytes = new Uint8Array(await r.arrayBuffer()), size = Number(range[2]);
	if (!Number.isSafeInteger(size) || bytes.byteLength !== Math.min(HEAD, size) || Number(range[1]) !== bytes.byteLength - 1) throw new Error('short range');
	return { bytes, size };
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
		let task = null, destroyed = false;
		const fail = (error) => { if (destroyed) return; failed(error); reads.abort(); void task?.destroy().catch(() => {}); };
		const load = (source) => pdfjs.getDocument({
			...source, rangeChunkSize: CHUNK, disableStream: true, disableAutoFetch: true,
			isEvalSupported: false, enableXfa: false, enableScripting: false, useWasm: false,
			standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, iccUrl: `${base}iccs/`,
			// pdf.js decodes CCITT fax and JBIG2 (most scans) and JPX through its JBIG2 and OpenJPEG modules; without wasm it
			// imports their JS builds from here (scripts/hosted-pdf-assets.ts, DECODERS). Unset, every such image fails.
			wasmUrl: `${base}wasm/`,
		});
		// With the size known, pdf.js starts at once; without it, the head is read first and its answer gives the size.
		if (Number.isSafeInteger(size)) task = load(size <= HEAD ? { url: src, withCredentials: false } : { range: new Ranges({ src, size, signal: reads.signal, fail }) });
		let ticket = 0, rendering = null;
		let tail = Promise.resolve();
		const destroy = () => {
			if (destroyed) return;
			destroyed = true;
			ticket++;
			signal?.removeEventListener('abort', destroy);
			rendering?.cancel();
			reads.abort();
			void task?.destroy().catch(() => {});
		};
		signal?.addEventListener('abort', destroy, { once: true });
		if (signal?.aborted) destroy();
		let doc;
		try {
			if (!task) {
				const head = await readHead(src, reads.signal);
				if (destroyed) throw new Error('reader cancelled');
				task = load(head.size <= HEAD ? { data: head.bytes } : { range: new Ranges({ src, size: head.size, head: head.bytes, signal: reads.signal, fail }) });
			}
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
					const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))));
					canvas.width = Math.floor(viewport.width * ratio);
					canvas.height = Math.floor(viewport.height * ratio);
					canvas.style.width = `${Math.floor(viewport.width)}px`;
					canvas.style.height = `${Math.floor(viewport.height)}px`;
					const render = rendering = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
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
