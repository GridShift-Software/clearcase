import { importV5CustomBundles } from '../../bundles/builder.ts';
import { importCustom } from '../../views/bundles/store.server.ts';
import { legacyImporters, registerLegacyImporter } from './legacy.server.ts';

const CUSTOM_BUNDLES = 'ess_dcs_custom_bundles_v1';

export function registerV5Importers(): void {
	if (legacyImporters().some((i) => i.id === 'v5-custom-bundles')) return;
	registerLegacyImporter({
		id: 'v5-custom-bundles', owner: 'GRS-19', keys: [CUSTOM_BUNDLES],
		import: async (ctx, values) => ({ rows: await importCustom(ctx.caseId, importV5CustomBundles(values[CUSTOM_BUNDLES])) }),
	});
}
