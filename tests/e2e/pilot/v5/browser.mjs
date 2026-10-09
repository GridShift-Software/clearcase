// Browser and originals-site helpers for the real-v5 runners, on top of the harness (tests/e2e/pilot/lib/cdp.mjs):
// keyboard input, screenshots, popups opened by target=_blank links, download events, and a raw HTTP client for the
// originals site that sends its exact Host header (the site is addressed as clearcase-originals.localhost:<port>).
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { crc32 } from 'node:zlib';
import { newPage, sleep } from '../lib/cdp.mjs';

const KEYS = {
	Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
	Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
	Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};

/** A tab with focus emulation on, so keyboard focus behaves as in a focused window. */
export async function openPage(b, opts = {}) {
	const p = await newPage(b, opts);
	await p.s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
	await p.s('Runtime.enable').catch(() => {});
	p.key = async (name, modifiers = 0) => {
		const k = KEYS[name];
		await p.s('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', modifiers, ...k });
		await p.s('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k, text: undefined });
	};
	p.shot = (file) => shot(b, p.sessionId, file);
	/** A real mouse click (pressed + released) at the centre of the element; returns false if it is not there. */
	p.click = async (sel) => {
		const box = await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		if (!box) return false;
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
		return true;
	};
	/** Focus an input and type into it (Input.insertText fires one input event, like a paste). */
	p.type = async (sel, text) => {
		const ok = await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); if (e.select) e.select(); return true; })()`);
		if (ok) await p.s('Input.insertText', { text });
		return ok;
	};
	/** Choose an option of a <select> the way a form-filling user agent does: set it and fire change. */
	p.select = (sel, value) => p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'missing'; if (![...e.options].some((o) => o.value === ${JSON.stringify(value)})) return 'no-option'; e.focus(); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
	p.back = async () => {
		const h = await p.s('Page.getNavigationHistory');
		if (h.currentIndex < 1) throw new Error('no history entry to go back to');
		await p.s('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
		return h;
	};
	p.goto = async (url, ready, timeout = 30000) => { await p.navigate(url, { timeout }); if (ready) await p.waitFor(ready, timeout); };
	/** Wait two animation frames, then evaluate: reads state after Svelte's update and the next paint. */
	// after every grid has rendered all its rows (DataGrid grows long lists over a few frames) and two more frames
	p.settled = (expr) => p.evaluate(`new Promise((r) => { const f = () => document.querySelector('[data-complete="false"]') ? requestAnimationFrame(f) : requestAnimationFrame(() => requestAnimationFrame(r)); f(); }).then(() => (${expr}))`);
	return p;
}

export async function shot(b, sessionId, file) {
	const r = await b.send('Page.captureScreenshot', { format: 'png' }, sessionId);
	writeFileSync(file, Buffer.from(r.data, 'base64'));
	return file;
}

/** Live page targets right now (to tell a popup from tabs that already existed). */
export const pageTargets = (b) => new Set([...b.sessions.values()].filter((i) => i.type === 'page').map((i) => i.targetId));

/** The page target that appeared after `before` and reached a URL starting with `prefix`. */
export async function popup(b, before, prefix, timeout = 20000) {
	const t0 = Date.now();
	for (;;) {
		for (const [sid, inf] of b.sessions) {
			if (inf.type !== 'page' || before.has(inf.targetId) || !String(inf.url).startsWith(prefix)) continue;
			const evaluate = async (expression) => {
				const r = await b.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
				if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
				return r.result.value;
			};
			const waitFor = async (expr, to = 20000) => {
				const s = Date.now();
				let last;
				for (;;) { try { const v = await evaluate(expr); if (v) return v; last = v; } catch (e) { last = String(e); } if (Date.now() - s > to) throw new Error(`popup timeout (${to} ms): ${expr} last=${String(last).slice(0, 200)}`); await sleep(15); }
			};
			return { sessionId: sid, targetId: inf.targetId, url: inf.url, evaluate, waitFor, shot: (f) => shot(b, sid, f), close: () => b.send('Target.closeTarget', { targetId: inf.targetId }).catch(() => {}) };
		}
		if (Date.now() - t0 > timeout) throw new Error(`no new page target with URL ${prefix}… within ${timeout} ms`);
		await sleep(20);
	}
}

/** Resolve with the next Browser.downloadWillBegin whose URL matches, stamped with performance.now(). */
export function nextDownload(b, match = () => true, timeout = 20000) {
	let off;
	const p = new Promise((res, rej) => {
		const t = setTimeout(() => { off(); rej(new Error('no Browser.downloadWillBegin')); }, timeout);
		off = b.on((m) => { if (m.method === 'Browser.downloadWillBegin' && match(m.params.url)) { const at = performance.now(); clearTimeout(t); off(); res({ at, ...m.params }); } });
	});
	p.catch(() => {});
	return p;
}

/**
 * GET (or HEAD) a path on the originals site, sending its exact Host header. The body is streamed through sha256
 * and CRC-32; nothing is kept unless keepBody. No Sec-Fetch-Site header: a direct, top-level style request.
 */
export function originalsGet(origin, path, { method = 'GET', headers = {}, keepBody = false } = {}) {
	const u = new URL(origin);
	return new Promise((res, rej) => {
		const t0 = performance.now();
		const req = http.request({ host: '127.0.0.1', port: Number(u.port), path, method, headers: { host: u.host, ...headers } }, (r) => {
			const h = createHash('sha256');
			let c = 0, n = 0;
			const chunks = [];
			const firstByte = performance.now() - t0;
			r.on('data', (d) => { h.update(d); c = crc32(d, c); n += d.length; if (keepBody) chunks.push(d); });
			r.on('end', () => res({ status: r.statusCode, headers: r.headers, sha256: h.digest('hex'), crc32: (c >>> 0).toString(16).padStart(8, '0'), size: n, body: keepBody ? Buffer.concat(chunks) : null, firstByteMs: firstByte, ms: performance.now() - t0 }));
			r.on('error', rej);
		});
		req.on('error', rej);
		req.end();
	});
}

/** Split an absolute originals-site href into the path+query to request. */
export const pathOf = (href) => { const u = new URL(href); return u.pathname + u.search; };
export const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** Attribute value of the element with the given id in server-rendered HTML. */
export const attrById = (html, id, attr) => { const m = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`).exec(html); const a = m && new RegExp(`\\b${attr}="([^"]*)"`).exec(m[0]); return a ? decode(a[1]) : null; };
