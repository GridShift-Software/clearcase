import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { refuse } from '$lib/server/runtime/hosted/http';
import { registerRows } from './rows';
import { headsMerge, type HeadsShard } from './payload';
import { headsActions } from '$lib/views/litigation/actions.server';
import { hostedCtx } from '$lib/views/litigation/hosted.server';
import type { Actions, RequestEvent } from '@sveltejs/kit';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<HeadsShard>(locals, params, 'view/heads_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: 'heads' }).catch(refuse),
  ]);
  const rows = work.rows;
  const data = headsMerge(payload, registerRows(rows), crypto.randomUUID());
  return { ...data, base: scope.base, empty: data.rows.length === 0 };
};

export const actions: Actions = headsActions(hostedCtx);
