// App adapter: Timeline (GRS-15). The generic extraction reads the synopsis, the year chart, the phase notes, the
// trajectory, the correspondents and the evidence notes; Print / PDF is pressed and its capture read as on the v5
// side; the timeline_events sweep reads every phase and event row in order with the v5 spec's own reader.
import { fromRaw } from '../../lib/snapshot.mjs';
import { PHASES_JS, eventValues } from '../v5/specs/timeline.mjs';
import { navFocus, open } from './_shell.mjs';
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';

const VIEW = 'timeline';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await open(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		if (ctx.exports) {
			await p.takePrint();
			await p.click('#print');
			await sleep(60);
			const print = await p.takePrint();
			s.exports['print_pdf.print'] = print.prints ? { name: 'print', text: print.text ?? '' } : { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		async timeline_events(p, ctx) {
			await open(p, ctx, ctx.registry[VIEW].route, VIEW);
			return eventValues(await p.evaluate(PHASES_JS));
		},
	},
};
