// App adapter: Cause of Action (GRS-18). The generic extraction over #main; the columns come from view-content.
import { fromRaw } from '../../lib/snapshot.mjs';
import { openHydrated } from '../../../../tests/e2e/litigation/lib/parity.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'elements_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openHydrated(p, ctx, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
};
