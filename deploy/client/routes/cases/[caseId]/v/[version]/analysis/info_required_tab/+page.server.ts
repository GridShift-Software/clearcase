import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { infoRequiredMerge } from '$lib/views/payloads/info-required';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { RequestEvent } from '@sveltejs/kit';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, rows] = await Promise.all([
    shard<ViewShards['info_required_tab']>(locals, params, 'view/info_required_tab.json'),
    locals.userWork.listRows({ caseId: scope.caseId, store: 'info-required' }).catch(refuse),
  ]);
  const data = infoRequiredMerge(payload, { rows });
  return { ...data, base: scope.base, empty: data.rows.length === 0 && rows.length === 0 };
};
