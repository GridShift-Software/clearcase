import { viewSeeds, type SeedRow } from '$lib/case-package/user-work';
import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { filingsMerge, REGISTER_STORE, SEED_DATASET } from '$lib/views/evidence/filings';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { RequestEvent } from '@sveltejs/kit';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<ViewShards['filings_tab'] & { seeds: SeedRow[] }>(locals, params, 'view/filings_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: REGISTER_STORE, datasetKey: SEED_DATASET }).catch(refuse),
  ]);
  const seeds = viewSeeds(payload.seeds, work.overlays), rows = work.rows;
  const data = filingsMerge(payload, { seeds, rows });
  return { ...data, base: scope.base, empty: !data.groups?.some((g) => g.items.length) && data.entries.length === 0 };
};
