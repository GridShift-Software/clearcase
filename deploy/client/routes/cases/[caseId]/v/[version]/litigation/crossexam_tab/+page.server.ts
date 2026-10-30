import type { SeedRow } from '$lib/case-package/user-work';
import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { crossexamActions } from '$lib/views/litigation/actions.server';
import { crossexamMerge, CX_SEED } from '$lib/views/litigation/crossexam';
import { hostedCtx, seedViewsOf } from '$lib/views/litigation/hosted.server';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import { registerRows } from '../heads_tab/rows';
import type { Actions, RequestEvent } from '@sveltejs/kit';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<ViewShards['crossexam_tab'] & { seeds: SeedRow[] }>(locals, params, 'view/crossexam_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: 'crossexam', datasetKey: CX_SEED }).catch(refuse),
  ]);
  // each seed carries the version a delete names: its overlay's, or `none` while it is as imported
  const data = crossexamMerge(payload, { seeds: seedViewsOf(payload.seeds, work.overlays), rows: registerRows(work.rows) }, crypto.randomUUID());
  return { ...data, base: scope.base, empty: data.rows.length === 0 };
};

export const actions: Actions = crossexamActions(hostedCtx);
