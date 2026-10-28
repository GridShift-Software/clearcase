// The navigation drawer of the case shell at 390 px (GRS-254 review): while it is open it is modal. Real Chromium, real
// key and mouse input through CDP (the browser suite's openPage): Tab and Shift+Tab wrap inside the drawer, the top bar and
// main are inert (not even a script can focus their search box), Escape and the backdrop close it with focus back on the
// toggle, and Ctrl+K closes it first and then focuses the search box. Synthetic package only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { outDir } from '../lib/record.mjs';
import { openPage, sleep } from './browser.mjs';
import { ready } from './main-flow.mjs';

const STATE = `(() => {
	const q = (s) => document.querySelector(s), a = document.activeElement, links = [...document.querySelectorAll('.side a[href]')];
	return { open: q('.case-shell').classList.contains('nav-open'), active: a?.id || a?.getAttribute('data-testid') || a?.tagName || null,
		inSide: q('.side').contains(a), index: links.indexOf(a), last: links.length - 1, barInert: q('.top-bar').inert, mainInert: q('main#main').inert,
		expanded: q('#nav-toggle').getAttribute('aria-expanded') };
})()`;

/** The drawer's focus containment, inertness, Escape, backdrop and Ctrl+K at 390 px, and Ctrl+K on a desktop-wide page. */
export async function drawerFocus(ctx) {
	const { A, b, main } = ctx;
	const url = `${A.v(main.resultsVersion)}/overview`;
	const screens = join(outDir(), 'screens');
	mkdirSync(screens, { recursive: true });
	const p = await openPage(b);
	const ev = {};
	const open = async () => { await p.click('#nav-toggle'); await p.waitFor(`document.querySelector('.case-shell.nav-open') && document.querySelector('.side').contains(document.activeElement)`, 5000); };
	const closed = () => p.waitFor(`!document.querySelector('.case-shell.nav-open')`, 5000);
	try {
		await p.s('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
		await p.goto(url, ready('overview'));

		// open: focus goes into the drawer, the covered regions are inert and not even a script can focus the search box
		await open();
		const opened = await p.evaluate(STATE);
		await p.evaluate(`document.querySelector('[data-testid="search-input"]').focus(); true`);
		const scripted = await p.evaluate(STATE);
		writeFileSync(join(screens, 'drawer-focus-open.png'), Buffer.from((await p.s('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
		ev.opened = { ...opened, scriptedFocusStaysInside: scripted.inSide, ok: opened.open && opened.inSide && opened.barInert && opened.mainInert && opened.expanded === 'true' && scripted.inSide };

		// forward: Tab through the whole drawer; at the last link it wraps to the first, and focus is never outside it
		const outside = [];
		let steps = 0;
		for (; steps < opened.last + 6; steps++) {
			const s = await p.evaluate(STATE);
			if (!s.inSide) outside.push(s);
			if (s.index === s.last) break;
			await p.key('Tab');
		}
		const atLast = await p.evaluate(STATE);
		await p.key('Tab');
		const wrappedForward = await p.evaluate(STATE);
		ev.forward = { steps, atLast, wrappedForward, outside, ok: atLast.index === atLast.last && outside.length === 0 && wrappedForward.inSide && wrappedForward.index === 0 };

		// backward: Shift+Tab on the first link wraps to the last
		await p.key('Tab', { shift: true });
		const wrappedBack = await p.evaluate(STATE);
		await p.key('Tab', { shift: true });
		const oneBack = await p.evaluate(STATE);
		ev.backward = { wrappedBack, oneBack, ok: wrappedBack.inSide && wrappedBack.index === wrappedBack.last && oneBack.inSide && oneBack.index === oneBack.last - 1 };

		// Escape: closes, focus back on the toggle, nothing inert
		await p.key('Escape');
		await closed();
		const esc = await p.evaluate(STATE);
		ev.escape = { ...esc, ok: !esc.open && esc.active === 'nav-toggle' && !esc.barInert && !esc.mainInert && esc.expanded === 'false' };

		// the backdrop: a click right of the drawer closes it, focus back on the toggle
		await open();
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x: 386, y: 400, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
		await closed();
		const bd = await p.evaluate(STATE);
		ev.backdrop = { ...bd, ok: !bd.open && bd.active === 'nav-toggle' && !bd.barInert && !bd.mainInert };

		// Ctrl+K with the drawer open: it closes, and the search box (no longer inert) has the focus
		await open();
		await p.key('k', { ctrl: true });
		await closed();
		await p.waitFor(`document.activeElement?.getAttribute('data-testid') === 'search-input'`, 5000);
		const ck = await p.evaluate(STATE);
		ev.ctrlKOpen = { ...ck, ok: !ck.open && ck.active === 'search-input' && !ck.barInert && !ck.mainInert && ck.expanded === 'false' };

		// Ctrl+K with the drawer closed, at 390 and at 1280 px: the search box takes the focus as before
		await p.goto(url, ready('overview'));
		await p.key('k', { ctrl: true });
		await sleep(100);
		const ckClosed = await p.evaluate(STATE);
		await p.s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
		await p.goto(url, ready('overview'));
		await p.key('k', { ctrl: true });
		await sleep(100);
		const ckWide = await p.evaluate(STATE);
		ev.ctrlKClosed = { narrow: ckClosed.active, wide: ckWide.active, ok: ckClosed.active === 'search-input' && ckWide.active === 'search-input' };
	} finally {
		await p.s('Emulation.clearDeviceMetricsOverride').catch(() => {});
		await p.close();
	}
	return { pass: Object.values(ev).every((x) => x.ok), evidence: ev };
}
