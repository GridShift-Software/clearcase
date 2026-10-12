// App adapter: Backup / Restore (GRS-20). Reached from the overview through the sidebar like v5's tab; the page is read as
// rendered (texts, controls, tables) and compared with v5's snapshot ids.
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open } from './_shell.mjs';

export default {
	view: 'backup_tab',
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: 'backup_tab' });
		await open(p, ctx, ctx.registry['backup_tab'].route, 'backup_tab');
		const s = fromRaw('backup_tab', 'app', await p.extract('#main'));
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
};
