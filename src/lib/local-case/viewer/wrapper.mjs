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
		if (v === '1') body.dataset.readyMs = String(Math.round(performance.now()));
		status.textContent = v === '1' ? '' : 'This file cannot be displayed. Use Download.';
	}
});
