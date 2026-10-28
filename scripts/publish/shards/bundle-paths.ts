import { bundlePaths } from '../../../src/lib/views/bundles/paths.server.ts';
import type { ShardModule } from '../types.ts';
export default {
	name: 'bundle-paths',
	async build({ store, resultsVersion, json }) {
		return [json('bundle-paths.json', bundlePaths(store, resultsVersion))];
	},
} satisfies ShardModule;
