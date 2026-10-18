// App adapter: Risk Matrix (GRS-15). Read-only table; the generic extraction reads it as v5's is read.
import { readSimpleView } from './_shell.mjs';

const VIEW = 'risk_matrix_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		return readSimpleView(p, ctx, VIEW);
	},
};
