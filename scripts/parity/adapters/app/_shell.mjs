// Shared app-side helpers for adapters (files starting with '_' are not adapters). Every adapter reads the app the
// way a user sees it: real navigation, the rendered DOM, real clicks; never the database or page data.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';

export const ready = (view) => `document.querySelector('[data-ready="${view}"]')`;

/** Open a view at its route and wait until it is ready and every incremental grid has all rows. */
export async function open(p, ctx, route, view) {
	await p.goto(`${ctx.base}${route}`, ready(view));
	await p.settled();
}

/**
 * Navigation and focus, as on the v5 side: from another view, click the view's sidebar link with the mouse, wait for
 * the destination, then read where focus is and which entry is marked current (the app's equivalent of v5's crumb).
 */
export async function navFocus(p, ctx, { from, fromView, view }) {
	await open(p, ctx, from, fromView);
	await p.click(`#nav-${view}`);
	await p.waitFor(`${ready(view)} && location.pathname.endsWith(${JSON.stringify(ctx.registry[view].route)})`, 60000);
	await sleep(60);
	return { focus: await p.focusRole(), crumb: await p.evaluate(`document.querySelector('nav.views a[aria-current="page"]')?.firstChild?.textContent.trim() ?? ''`) };
}

/** The sidebar as 'Group / Label' entries in order (the screen-reader-only availability note is not part of a label). */
export const navList = (p) => p.evaluate(`[...document.querySelectorAll('nav.views section')].flatMap((s) => [...s.querySelectorAll('a')].map((a) => s.querySelector('h2').textContent.trim() + ' / ' + a.firstChild.textContent.trim()))`);

/** Press a control and return the parsed downloads it produced (content, not bytes). */
export async function pressAndCapture(p, selector, parseDownload) {
	await p.takeDownloads();
	if (!(await p.click(selector))) return null;
	await sleep(80);
	const out = [];
	for (const d of await p.takeDownloads()) out.push(await parseDownload(d));
	return out;
}
