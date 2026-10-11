// App adapter: Conflict Check (GRS-18). The generic extraction over #main, and the conflict_check sweep of
// specs/conflict_tab.mjs through the app's own select, box and Check button. v5 shows no scope line, so its counts are
// checked here against the parties the page offers, per kind (`text.scope_counts`: ok, or the figures).
import { fromRaw } from '../../lib/snapshot.mjs';
import { conflictSweep } from '../v5/specs/conflict_tab.mjs';
import { openHydrated } from '../../../../tests/e2e/litigation/lib/parity.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'conflict_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openHydrated(p, ctx, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		s.texts.scope_counts = await p.evaluate(`(() => {
			const line = document.getElementById('conf-scope')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
			const m = /(\\d+) (?:person|people) and (\\d+) (?:entity|entities)/.exec(line);
			const of = (k) => document.querySelectorAll('#confsel option[data-kind="' + k + '"]').length;
			const want = [of('person'), of('entity')];
			return m && +m[1] === want[0] && +m[2] === want[1] ? 'ok' : 'scope ' + (m ? m[1] + '/' + m[2] : 'missing') + ', offered ' + want.join('/');
		})()`);
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		conflict_check: (p, ctx) => conflictSweep(p, {
			reset: () => openHydrated(p, ctx, VIEW),
			check: async () => { await p.click('#conf-check'); await p.settled(); },
		}),
	},
};
