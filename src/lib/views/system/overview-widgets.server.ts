// The overview's Freshness slot, server side (GRS-20): the stamp's figures through the document-row read contract
// (so additions a rescan found count, as v5's allRows() counted them) and the last rescan of this version.
import type { OverviewWidgetLoader } from '$lib/components/overview-slots';
import { viewHref, viewById } from '$lib/components/views';
import { documentRows } from '$lib/local-case/documents.server';
import type { OverviewModel } from '$lib/local-case/model';
import { ensureRescanProvider, lastRun, PROVIDER_ID } from '$lib/local-case/rescan/rescan.server';
import type { LocalCase } from '$lib/local-case/service.server';
import type { FreshnessData } from './freshness';

export const loaders: OverviewWidgetLoader<FreshnessData, LocalCase>[] = [{
	slot: 'rescan-freshness',
	load({ app, caseId, resultsVersion }) {
		ensureRescanProvider(app, caseId);
		const v = app.store.getVersion(resultsVersion);
		const o = v ? (JSON.parse(v.overview) as OverviewModel) : null;
		const rows = documentRows(app.store, resultsVersion).rows;
		const run = lastRun(app, caseId, resultsVersion);
		const built = o?.sourceClaims.builtAt;
		return {
			builtAt: typeof built === 'string' && built ? built : (o?.created ?? ''),
			documents: rows.length,
			viaRescan: rows.filter((r) => r.source === `provider:${PROVIDER_ID}`).length,
			lastScan: run ? { at: run.at, mode: run.mode, current: run.current, verdict: run.verdict } : null,
			href: viewHref(resultsVersion, viewById('rescan_tab')!),
		};
	},
}];
