import { viewSeeds, type SeedRow } from '$lib/case-package/user-work';
import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { filingsMerge, REGISTER_STORE, SEED_DATASET } from '$lib/views/evidence/filings';
import { filingsActionsOver } from '$lib/views/evidence/filings-actions.server';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { Actions, RequestEvent } from '@sveltejs/kit';
import { hostedFilingsPort } from './port.server';

export const load = async ({ locals, params, url }: Pick<RequestEvent, 'locals' | 'params'> & Partial<Pick<RequestEvent, 'url'>>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<ViewShards['filings_tab'] & { seeds: SeedRow[] }>(locals, params, 'view/filings_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: REGISTER_STORE, datasetKey: SEED_DATASET }).catch(refuse),
  ]);
  const seeds = viewSeeds(payload.seeds, work.overlays), rows = work.rows;
  const data = filingsMerge(payload, { seeds, rows }, url?.searchParams.get('edit') ?? null);
  // the version each entry's Delete names: the store's version of its row or overlay, `none` for an imported row as imported
  const deleteVersions = Object.fromEntries(data.entries.map((e) => [e.key, (e.key.startsWith('row:') ? rows.find((r) => r.rowId === e.key.slice(4))?.version : work.overlays.find((o) => o.seedId === e.key.slice(5))?.version) ?? 'none']));
  return { ...data, deleteVersions, base: scope.base, empty: !data.groups?.some((g) => g.items.length) && data.entries.length === 0, operationId: crypto.randomUUID() };
};

export const actions: Actions = filingsActionsOver(hostedFilingsPort);
