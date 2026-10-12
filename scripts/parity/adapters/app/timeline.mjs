// App adapter: Timeline (GRS-15). The generic extraction reads the synopsis, the year chart, the phase notes, the
// trajectory, the correspondents and the evidence notes; Print / PDF is pressed and its capture read from the page's
// main on (the app shell is left out, so the capture holds the printed content); the timeline_events and
// timeline_print sweeps read every phase and event row in order, and the printed content, with the v5 spec's readers.
import { fromRaw } from '../../lib/snapshot.mjs';
import { MAIN_JS, PHASES_JS, eventValues, fromMain, printValues } from '../v5/specs/timeline.mjs';
import { navFocus, open } from './_shell.mjs';
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';

const VIEW = 'timeline';
/** The server-rendered page is ready to read at once; wait for hydration before clicking its controls. */
const hydrated = (p) => p.waitFor(`document.querySelector('main#main[data-hydrated]') !== null`, 30000);

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await open(p, ctx, ctx.registry[VIEW].route, VIEW);
		await hydrated(p);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		if (ctx.exports) {
			await p.takePrint();
			await p.click('#print');
			await sleep(60);
			const print = await p.takePrint();
			s.exports['print_pdf.print'] = print.prints ? { name: 'print', text: fromMain(print.text, await p.evaluate(MAIN_JS)) ?? print.text ?? '' } : { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		async timeline_events(p, ctx) {
			await open(p, ctx, ctx.registry[VIEW].route, VIEW);
			await hydrated(p);
			return eventValues(await p.evaluate(PHASES_JS));
		},
		async timeline_print(p, ctx) {
			await open(p, ctx, ctx.registry[VIEW].route, VIEW);
			await hydrated(p);
			await p.takePrint();
			await p.click('#print');
			await sleep(60);
			const print = await p.takePrint();
			return printValues(print, await p.evaluate(MAIN_JS));
		},
	},
};
