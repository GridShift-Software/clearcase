// App adapter: Contracts (GRS-14). v5's group headers are plain text (page.N) above untitled tables (table_N); the app
// gives each group a heading, so this adapter files the group headers and tables under v5's ids in page order.
import { parseDownload } from '../../lib/exports.mjs';
import { slug } from '../../lib/normalize.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { capture, openHydrated } from '../../../../tests/e2e/evidence/lib/parity-app.mjs';
import { navFocus } from './_shell.mjs';

const VIEW = 'contracts_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openHydrated(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		// the classification disclosure is the app's own first paragraph
		if (s.texts['page.1'] !== undefined) { s.texts['classification_status.1'] = s.texts['page.1']; delete s.texts['page.1']; }
		const heads = await p.evaluate(`[...document.querySelectorAll('#main section.group h2')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim())`);
		const tables = { ...s.tables };
		heads.forEach((h, i) => {
			s.texts[`page.${i + 1}`] = h;
			const own = slug(h), to = `table_${i + 1}`;
			if (tables[own] && own !== to) { s.tables[to] = tables[own]; delete s.tables[own]; }
		});
		if (ctx.exports) s.exports.export_csv = (await capture(p, '#export-contracts', parseDownload))?.[0] ?? { name: '(nothing captured)' };
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
};
