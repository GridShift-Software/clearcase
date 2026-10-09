// Page helpers for the browser suite: real keyboard and mouse input through CDP Input.*, a hydration signal and
// ready waits. Pages come from lib/cdp.mjs newPage (browser-level auto-attach, events recorded on the browser).
import { newPage, sleep } from '../lib/cdp.mjs';

const J = JSON.stringify;
/**
 * Test instrumentation installed before any page script: counts the root layout's 'pageshow' listener (added in its
 * onMount, i.e. after the whole page hydrated) and stamps each new document, so a client-side navigation (same
 * document) can be told apart from a full load. It never changes behaviour.
 */
export const INIT = `(() => {
	const add = EventTarget.prototype.addEventListener;
	EventTarget.prototype.addEventListener = function (type, ...rest) {
		if (this === window && type === 'pageshow') window.__ccMounted = (window.__ccMounted || 0) + 1;
		return add.call(this, type, ...rest);
	};
	window.__ccDoc = Math.random().toString(36).slice(2);
})()`;

const KEYS = {
	Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
	Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
	Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
	Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
};

export async function openPage(b, opts = {}) {
	const p = await newPage(b, { initScript: INIT, ...opts });
	p.key = async (name, { shift = false } = {}) => {
		const k = KEYS[name];
		const modifiers = shift ? 8 : 0;
		await p.s('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...k });
		await p.s('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
	};
	/** A real mouse click at the centre of the element (scrolled into view first). */
	p.click = async (sel) => {
		const r = await p.evaluate(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; })()`);
		if (!r || !r.w || !r.h) throw new Error(`click: no visible element ${sel}`);
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
	};
	/** Focus by clicking, select the current value and type `text` (input events as from a keyboard/IME). */
	p.type = async (sel, text) => {
		await p.click(sel);
		await p.evaluate(`document.querySelector(${J(sel)}).select?.(); true`);
		await p.s('Input.insertText', { text });
	};
	p.active = () => p.evaluate(`(() => { const e = document.activeElement; return e ? { tag: e.tagName, id: e.id || null, cls: e.className || null, heading: e.hasAttribute('data-page-heading'), text: (e.textContent || '').trim().slice(0, 80), href: e.getAttribute('href') } : null; })()`);
	/** Navigate (full load) and wait until the page hydrated and `ready` holds. */
	p.goto = async (url, ready = 'true', timeout = 20000) => {
		const r = await p.navigate(url);
		if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
		await p.waitFor(`(window.__ccMounted >= 1) && !!document.querySelector('main#main') && (${ready})`, timeout);
	};
	p.hydrated = () => p.waitFor('window.__ccMounted >= 1 && !!document.querySelector("main#main")');
	return p;
}

/** Wait for a new top-level tab opened by `p` (window.open / target=_blank) and attach helpers to it. */
export function nextPopup(b, timeout = 10000) {
	return b.once((m) => m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'page' && !!m.params.targetInfo.openerId, timeout)
		.then((m) => popupHelpers(b, m.params.sessionId, m.params.targetInfo));
}
/** The popups created since a b.mark(), including ones opened without an opener (noopener links). */
export function popupHelpers(b, sessionId, info) {
	const ev = async (expression) => {
		const r = await b.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	};
	const waitFor = async (expr, timeout = 15000) => {
		const t0 = Date.now();
		let last;
		for (;;) {
			try { const v = await ev(expr); if (v) return v; last = v; } catch (e) { last = String(e); }
			if (Date.now() - t0 > timeout) throw new Error(`popup timeout (${timeout} ms): ${expr.slice(0, 160)} last=${String(last).slice(0, 160)}`);
			await sleep(25);
		}
	};
	return { sessionId, targetId: info.targetId, info, ev, waitFor, close: () => b.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {}) };
}
export { sleep };
