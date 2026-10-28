import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { filingsMerge, REGISTER_STORE, SEED_DATASET } from '$lib/views/evidence/filings';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { RequestEvent } from '@sveltejs/kit';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, seeds, rows] = await Promise.all([
    shard<ViewShards['filings_tab']>(locals, params, 'view/filings_tab.json'),
    locals.userWork.seedViews({ caseId: scope.caseId, resultsVersion: scope.resultsVersion, datasetKey: SEED_DATASET }).catch(refuse),
    locals.userWork.listRows({ caseId: scope.caseId, store: REGISTER_STORE }).catch(refuse),
  ]);
  const data = filingsMerge(payload, { seeds, rows });
  return { ...data, base: scope.base, empty: !data.groups?.some((g) => g.items.length) && data.entries.length === 0 };
};
