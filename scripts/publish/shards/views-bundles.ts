import {
	courtPure,
	discoveryPure,
	caselinesPure,
} from '../../../src/lib/views/bundles/pure.server.ts';
import type { ShardModule } from '../types.ts';
export default {
	name: 'views-bundles',
	async build({ pure, json }) {
		return [
			json('view/court_bundle_tab.json', courtPure(pure)),
			json('view/discovery_tab.json', discoveryPure(pure)),
			json('view/caselines_tab.json', caselinesPure(pure)),
		];
	},
} satisfies ShardModule;
