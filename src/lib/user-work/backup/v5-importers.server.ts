// The importers the legacy import hook (legacy.server.ts) runs for a v5 browser backup. Each hands a v5 store's value
// to its owner's storage under stable ids, so importing one file twice writes the same rows. Registered at start-up and, if that did not
// happen (a storage error stopped it), by the first backup page use.
import { importV5CustomBundles } from '../../bundles/builder.ts';
import { importCustom } from '../../views/bundles/store.server.ts';
import { legacyImporters, registerLegacyImporter } from './legacy.server.ts';

const CUSTOM_BUNDLES = 'ess_dcs_custom_bundles_v1';

/** Register the v5 importers once per process (a second call does nothing). */
export function registerV5Importers(): void {
	if (legacyImporters().some((i) => i.id === 'v5-custom-bundles')) return;
	registerLegacyImporter({
		id: 'v5-custom-bundles', owner: 'GRS-19', keys: [CUSTOM_BUNDLES],
		// the bundles keep v5's numbers (id v5-<no>); an entry with no number is dropped and a repeated number keeps its first
		import: async (ctx, values) => ({ rows: await importCustom(ctx.caseId, importV5CustomBundles(values[CUSTOM_BUNDLES])) }),
	});
}
