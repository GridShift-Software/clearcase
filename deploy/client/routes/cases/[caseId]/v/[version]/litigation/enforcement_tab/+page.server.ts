import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { enforcementMerge } from '$lib/views/litigation/enforcement';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import { registerRows } from '../heads_tab/rows';
import type { RequestEvent } from '@sveltejs/kit';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, rows] = await Promise.all([
    shard<ViewShards['enforcement_tab']>(locals, params, 'view/enforcement_tab.json'),
    locals.userWork.listRows({ caseId: scope.caseId, store: 'enforcement-status' }).catch(refuse),
  ]);
  const data = enforcementMerge(payload, { rows: registerRows(rows) });
  return { ...data, base: scope.base, empty: data.rows.length === 0 };
};
