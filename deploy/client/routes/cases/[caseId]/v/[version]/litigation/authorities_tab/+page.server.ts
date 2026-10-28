import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { authoritiesMerge } from '$lib/views/litigation/authorities';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import { registerRows } from '../heads_tab/rows';
import type { RequestEvent } from '@sveltejs/kit';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<ViewShards['authorities_tab']>(locals, params, 'view/authorities_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: 'authorities' }).catch(refuse),
  ]);
  const rows = work.rows;
  const data = authoritiesMerge(payload, { rows: registerRows(rows) }, crypto.randomUUID());
  return { ...data, base: scope.base, empty: data.imported.length === 0 && data.user.length === 0 };
};
