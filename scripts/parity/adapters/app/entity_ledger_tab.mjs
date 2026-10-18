// App adapter: Entities (GRS-14). A read-only table in data order.
import { openHydrated } from '../../../../tests/e2e/evidence/lib/parity-app.mjs';
import { readSimpleView } from './_shell.mjs';

const VIEW = 'entity_ledger_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		return readSimpleView(p, ctx, VIEW, { openView: openHydrated });
	},
};
