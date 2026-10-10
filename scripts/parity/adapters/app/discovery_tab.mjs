// App adapter: Discovery Schedule (GRS-19). The page keeps v5's structure (mode switch, bars, one table with a
// checkbox, item, document and date column), so the shared extractor reads both sides alike. Exports: the two cover
// controls, pressed with window.open returning null as the v5 harness stubs it, so "Open / print" falls back to a
// download on both sides. Sweeps mirror scripts/parity/adapters/v5/specs/discovery_tab.mjs.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open } from './_shell.mjs';
import { APP, runSweeps, splitFileActions } from '../v5/specs/discovery_tab.mjs';

const VIEW = 'discovery_tab';

export async function openDiscovery(p, ctx) {
	await open(p, ctx, ctx.registry[VIEW].route, VIEW);
	// data-ready is server-rendered; controls work once the page has hydrated
	await p.waitFor(`document.querySelector('main[data-hydrated]')`, 60000);
	await p.evaluate(`window.open = () => null`);
}

/** The clean starting state, through the UI: the discovery schedule, nothing selected, no filter. */
async function appFresh(p, ctx) {
	await openDiscovery(p, ctx);
	if (await p.evaluate(`document.querySelector('#ds-back') !== null`)) { await p.click('#ds-back'); await sleep(40); }
	if (await p.evaluate(`!document.querySelector('#main .ds-switch button[data-mode="discovery"]')?.classList.contains('on')`)) await p.click('#main .ds-switch button[data-mode="discovery"]');
	if (await p.evaluate(`document.querySelector('#ds-count')?.textContent.trim() !== '0'`)) await p.click('#ds-clear');
	if (await p.evaluate(`document.querySelector('#ds-q')?.value !== ''`)) { await p.type('#ds-q', ''); await sleep(300); }
	if (await p.evaluate(`document.querySelector('#ds-missing')?.checked`)) await p.click('#ds-missing');
	await p.waitFor(`document.querySelector('#main')?.dataset.pending === '0'`, 30000);
}

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openDiscovery(p, ctx);
		const raw = await p.extract('#main');
		splitFileActions(raw); // as the v5 spec's postRaw does
		const s = fromRaw(VIEW, 'app', raw);
		if (ctx.exports !== false) {
			for (const [id, sel] of [['open_print_cover_page', '#ds-cover-open'], ['download_cover_page_uncertified', '#ds-cover-dl']]) {
				await openDiscovery(p, ctx);
				await p.takeDownloads();
				await p.click(sel);
				await sleep(60);
				const got = await p.takeDownloads();
				for (const [j, d] of got.entries()) s.exports[j ? `${id}_${j + 1}` : id] = await parseDownload(d);
				if (!got.length) s.exports[id] = { name: '(nothing captured)' };
			}
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: runSweeps(APP, appFresh),
};
