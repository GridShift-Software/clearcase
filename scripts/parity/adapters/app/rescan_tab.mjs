// App adapter: Rescan & Update (GRS-20). Reached from the overview through the sidebar like v5's tab; the page is read as
// rendered (texts, controls, tables) and compared with v5's snapshot ids.
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open } from './_shell.mjs';

export default {
	view: 'rescan_tab',
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: 'rescan_tab' });
		await open(p, ctx, ctx.registry['rescan_tab'].route, 'rescan_tab');
		const s = fromRaw('rescan_tab', 'app', await p.extract('#main'));
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
};
