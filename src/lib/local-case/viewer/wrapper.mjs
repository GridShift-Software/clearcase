// ClearCase PDF viewer WRAPPER (top-level page on the originals site, /view/<version>/<key>). Our only script on
// this origin's top-level page. It fetches the PDF bytes (same origin; the server verifies them against the sha256
// recorded at import), loads the pdf.js frame (sandbox="allow-scripts": an opaque origin, see originals.server.ts)
// and hands a copy of the bytes to it with postMessage each time the frame loads. The ONLY thing it accepts back
// from the frame is a fixed ready/error flag; it never reads anything else from the frame and never navigates.
const body = document.body;
const frame = document.getElementById('viewer');
const status = document.getElementById('wrap-status');
const frameUrl = frame.dataset.frame;

const bytes = fetch(body.dataset.src, { credentials: 'omit', cache: 'no-store', redirect: 'error' }).then((r) => {
	if (!r.ok) throw new Error(`the original is not available (HTTP ${r.status})`);
	return r.arrayBuffer();
});
bytes.catch((err) => { body.dataset.ready = 'error'; status.textContent = `${err?.message ?? err}. Use Download.`; });

frame.addEventListener('load', () => {
	bytes.then((buf) => { frame.contentWindow.postMessage({ pdf: buf.slice(0) }, '*'); }, () => {});
});
frame.src = frameUrl + location.hash;
addEventListener('hashchange', () => { frame.src = frameUrl + location.hash; });

addEventListener('message', (e) => {
	if (e.source !== frame.contentWindow) return;
	const v = e.data && typeof e.data === 'object' ? e.data.ready : undefined;
	if (v === '1' || v === 'error') {
		body.dataset.ready = v;
		// the rendered-page signal: ms since this page's navigation started (read by the measurement runner)
		if (v === '1') body.dataset.readyMs = String(Math.round(performance.now()));
		status.textContent = v === '1' ? '' : 'This file cannot be displayed. Use Download.';
	}
});
