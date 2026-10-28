import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { refuse } from '$lib/server/runtime/hosted/http';
import { headsMerge, type HeadsShard } from './payload';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const scope = await publishedVersion(locals, params);
  const [payload, rows] = await Promise.all([
    shard<HeadsShard>(locals, params, 'view/heads_tab.json'),
    locals.userWork.listRows({ caseId: scope.caseId, store: 'heads' }).catch(refuse),
  ]);
  const data = headsMerge(payload, rows, crypto.randomUUID());
  return { ...data, base: scope.base, empty: data.rows.length === 0 };
};
