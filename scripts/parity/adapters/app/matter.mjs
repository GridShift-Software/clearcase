// App adapter: Matter & Strategy (GRS-15). Read-only narrative; the generic extraction reads it as v5's is read.
import { readSimpleView } from './_shell.mjs';

const VIEW = 'matter';

export default {
	view: VIEW,
	async extract(p, ctx) {
		return readSimpleView(p, ctx, VIEW);
	},
};
