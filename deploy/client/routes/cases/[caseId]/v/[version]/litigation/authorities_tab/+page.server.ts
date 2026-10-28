import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { authoritiesMerge } from '$lib/views/litigation/authorities';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const scope = await publishedVersion(locals, params);
  const [payload, rows] = await Promise.all([
    shard<ViewShards['authorities_tab']>(locals, params, 'view/authorities_tab.json'),
    locals.userWork.listRows({ caseId: scope.caseId, store: 'authorities' }).catch(refuse),
  ]);
  const data = authoritiesMerge(payload, { rows }, crypto.randomUUID());
  return { ...data, base: scope.base, empty: data.imported.length === 0 && data.user.length === 0 };
};
