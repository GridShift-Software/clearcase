// Page drivers for the two sides, on one headless Chromium (tests/e2e/pilot/lib/cdp.mjs: sandboxed, its own
// temporary profile, every non-loopback host mapped to the canary). Runs only inside the offline namespace.
//
// v5: the main HTML opened read-only from the fixture tree as a file: URL, with Date frozen at the run clock and the
// timezone overridden, localStorage seeded per load, and every request that is not file:, data:, blob: or about:
// recorded (the run fails if there is one). Only the page's own UI code runs; no archive processing or build script.
// App: the production build under Bun, CLEARCASE_FIXED_NOW set to the same clock; the tab gets the same timezone.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { newPage, sleep } from '../../../tests/e2e/pilot/lib/cdp.mjs';
import { domExtract } from './dom.mjs';

/** Freeze Date as GRS-9's capture tool does: `new Date()` and Date.now() return the run clock. */
export const clockScript = (iso) => `(() => { const T = Date.parse(${JSON.stringify(iso)}); const R = Date;
  class D extends R { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } }
  D.parse = R.parse; D.UTC = R.UTC; globalThis.Date = D; })();`;

const LOCAL = /^(file|data|blob|about|chrome-error|devtools):/;

async function common(b, p, timezone) {
	await p.s('Emulation.setTimezoneOverride', { timezoneId: timezone });
	await p.s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	await p.s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
	await p.s('Runtime.enable');
	// one browser, two tabs: a background tab's animation frames are throttled, so each side brings its tab forward
	p.front = () => p.s('Page.bringToFront').catch(() => {});
	p.extract = (root, opts = {}) => p.evaluate(`(${domExtract.toString()})(${JSON.stringify(root)}, ${JSON.stringify(opts)})`);
	p.click = async (sel) => {
		const box = await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		if (!box) return false;
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
		return true;
	};
	/** Type into a field like a user (select its text, insert, one input event). */
	p.type = async (sel, value) => {
		const ok = await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); e.select?.(); return true; })()`);
		if (!ok) return false;
		if (value === '') await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		else await p.s('Input.insertText', { text: value });
		return true;
	};
	/** Choose a <select> option as a user agent does: set it and fire input and change. */
	p.select = (sel, value) => p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'missing'; if (![...e.options].some((o) => o.value === ${JSON.stringify(value)})) return 'no-option'; e.focus(); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
	p.key = async (key, code = key, vk = 0) => {
		await p.s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key === 'Enter' ? '\r' : key.length === 1 ? key : undefined });
		await p.s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
	};
	/** Where focus is, as a role: nav-link, heading, main, body or the element's tag (BA-14 comparisons). */
	p.focusRole = () => p.evaluate(`(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; if (a.closest('nav, #nav, .nav')) return 'nav-link'; if (/^H[1-6]$/.test(a.tagName)) return 'heading'; if (a.tagName === 'MAIN' || a.id === 'main') return 'main'; return a.tagName.toLowerCase(); })()`);
	return p;
}

/** The v5 workspace tab. `load(storage)` reloads the HTML with localStorage set to exactly `storage`. */
export async function v5Page(b, { html, clock, timezone }) {
	const p = await common(b, await newPage(b, { initScript: clockScript(clock) }), timezone);
	const url = pathToFileURL(resolve(html)).href;
	p.url = url;
	p.nonFile = [];
	b.on((m) => { if (m.sessionId === p.sessionId && m.method === 'Network.requestWillBeSent' && !LOCAL.test(m.params.request.url)) p.nonFile.push(m.params.request.url); });
	// downloads (Blob anchors) and print are captured in the page: the harness reads content, never bytes on disk
	const hooks = `(() => { window.__parity = { downloads: [], prints: 0, opened: [] };
		const C = URL.createObjectURL.bind(URL); const blobs = new Map();
		URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
		const click = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { window.__parity.downloads.push({ name: this.download, type: o.type, blob: o }); return; } return click.call(this); };
		window.print = () => { window.__parity.prints++; window.__parity.printed = document.body.innerText; };
		window.open = (u) => { window.__parity.opened.push(String(u)); return null; };
		window.confirm = () => true; window.alert = () => {}; window.prompt = (m, d) => (window.__parity.promptAnswers?.shift() ?? d ?? '');
	})();`;
	await p.s('Page.addScriptToEvaluateOnNewDocument', { source: hooks });
	let seedId = null;
	p.load = async (storage = {}) => {
		if (seedId) await p.s('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedId });
		const seed = `try { localStorage.clear(); ${Object.entries(storage).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`).join(' ')} } catch (e) {}`;
		seedId = (await p.s('Page.addScriptToEvaluateOnNewDocument', { source: seed })).identifier;
		await p.front();
		await p.navigate(url, { timeout: 60000 });
		await p.waitFor(`typeof go === 'function' && typeof RENDER === 'object' && !!document.getElementById('main')`, 60000);
	};
	p.go = async (view) => { await p.evaluate(`go(${JSON.stringify(view)})`); await sleep(30); };
	/** Downloads captured since the last call, read as text (CSV, ICS, JSON, TXT) or base64 (DOCX, PDF). */
	p.takeDownloads = () => p.evaluate(`Promise.all(window.__parity.downloads.splice(0).map(async (d) => { const buf = new Uint8Array(await d.blob.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return { name: d.name, type: d.type, size: buf.length, base64: btoa(bin) }; }))`);
	p.takePrint = () => p.evaluate(`(() => { const r = { prints: window.__parity.prints, text: window.__parity.printed ?? null }; window.__parity.prints = 0; window.__parity.printed = null; return r; })()`);
	return p;
}

/** The app tab on one origin. Downloads are captured the same way (the app's download() uses a Blob anchor). */
export async function appPage(b, { origin, timezone }) {
	const p = await common(b, await newPage(b), timezone);
	p.origin = origin;
	p.requests = [];
	b.on((m) => { if (m.sessionId === p.sessionId && m.method === 'Network.requestWillBeSent') p.requests.push(m.params.request.url); });
	const hooks = `(() => { window.__parity = { downloads: [], prints: 0 };
		const C = URL.createObjectURL.bind(URL); const blobs = new Map();
		URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
		const click = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { window.__parity.downloads.push({ name: this.download, type: o.type, blob: o }); return; } return click.call(this); };
		window.print = () => { window.__parity.prints++; window.__parity.printed = document.body.innerText; };
	})();`;
	await p.s('Page.addScriptToEvaluateOnNewDocument', { source: hooks });
	p.goto = async (path, ready) => { await p.front(); await p.navigate(origin + path, { timeout: 60000 }); if (ready) await p.waitFor(ready, 60000); };
	/** Wait until every incremental grid has all its rows, then two frames. */
	p.settled = () => p.evaluate(`new Promise((r) => { const f = () => document.querySelector('[data-complete="false"]') ? requestAnimationFrame(f) : requestAnimationFrame(() => requestAnimationFrame(r)); f(); })`);
	p.takeDownloads = () => p.evaluate(`Promise.all(window.__parity.downloads.splice(0).map(async (d) => { const buf = new Uint8Array(await d.blob.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return { name: d.name, type: d.type, size: buf.length, base64: btoa(bin) }; }))`);
	p.takePrint = () => p.evaluate(`(() => { const r = { prints: window.__parity.prints, text: window.__parity.printed ?? null }; window.__parity.prints = 0; window.__parity.printed = null; return r; })()`);
	return p;
}
