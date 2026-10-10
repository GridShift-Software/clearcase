// Browser and store helpers for the bundles suite (local to tests/e2e/bundles; the pilot's lib is not edited).
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { newPage, sleep } from '../pilot/lib/cdp.mjs';

/** Capture Blob-anchor downloads and window.print in the page, as the parity harness does. */
const HOOKS = `(() => { window.__cc = { downloads: [], prints: 0 };
	const C = URL.createObjectURL.bind(URL); const blobs = new Map();
	URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
	const click = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { window.__cc.downloads.push({ name: this.download, blob: o }); return; } return click.call(this); };
	window.print = () => { window.__cc.prints++; };
})();`;

export async function page(b, origin) {
	const p = await newPage(b, { initScript: HOOKS });
	p.origin = origin;
	p.go = async (path, ready) => { await p.navigate(origin + path, { timeout: 30000 }); if (ready) await p.waitFor(`document.querySelector('[data-ready="${ready}"]')`, 30000); };
	p.click = async (sel) => {
		const box = await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
		if (!box) throw new Error(`no element ${sel}`);
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
	};
	p.type = async (sel, value) => {
		await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select?.(); })()`);
		if (value === '') await p.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		else await p.s('Input.insertText', { text: value });
	};
	p.key = async (key) => { await p.s('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0, text: key === 'Enter' ? '\r' : undefined }); await p.s('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }); };
	p.text = (sel) => p.evaluate(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);
	p.count = (sel) => p.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
	/** Downloads since the last call: name and UTF-8 text (or base64 for binary). */
	p.downloads = () => p.evaluate(`Promise.all(window.__cc.downloads.splice(0).map(async (d) => { const u = new Uint8Array(await d.blob.arrayBuffer()); let bin = ''; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000)); return { name: d.name, size: u.length, base64: btoa(bin) }; }))`);
	p.idle = async () => { await sleep(120); return p.waitFor(`document.querySelector('#main')?.dataset.pending !== undefined ? document.querySelector('#main').dataset.pending === '0' : document.querySelector('#main')?.dataset.busy !== '1'`, 30000); };
	return p;
}
export const text = (d) => Buffer.from(d.base64, 'base64').toString('utf8');

/** Document title and heading focus after navigating to the view from the overview with the sidebar (BA-14, BA-16). */
export async function titleAndFocus(p, vbase, view, label) {
	await p.go(`${vbase}/overview`, 'overview');
	await p.click(`#nav-${view}`);
	await p.waitFor(`document.querySelector('[data-ready="${view}"]')`, 30000);
	await sleep(150);
	const r = await p.evaluate(`({ title: document.title, h1: document.querySelector('h1')?.textContent.trim(), focus: document.activeElement?.matches?.('h1[data-page-heading]') ?? false, current: document.querySelector('nav.views a[aria-current="page"]')?.id ?? null })`);
	return { ...r, pass: r.title.startsWith(`${label} · `) && r.title.endsWith(' · ClearCase') && r.h1 === label && r.focus && r.current === `nav-${view}` };
}

/** Hold the work store's write lock from outside the app (BEGIN IMMEDIATE, busy_timeout 0) for `ms`, around `during`. */
export async function withBusyStore(dataDir, ms, during) {
	const d = new Database(join(dataDir, 'work.sqlite'));
	d.exec('PRAGMA busy_timeout=0');
	d.exec('BEGIN IMMEDIATE');
	const t0 = Date.now();
	try { return await during(); }
	finally { const left = ms - (Date.now() - t0); if (left > 0) await sleep(left); d.exec('ROLLBACK'); d.close(); }
}

/** Rows of a work.sqlite table (read-only), for persistence checks. */
export const workRows = (srv, sql, ...args) => srv.work(sql, ...args);
