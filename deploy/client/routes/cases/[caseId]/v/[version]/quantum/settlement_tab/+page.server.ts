import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { settlementMerge } from '$lib/views/quantum/settlement';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { RequestEvent } from '@sveltejs/kit';
import { paymentsWork } from '../payments_tab/work.server';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<ViewShards['settlement_tab']>(locals, params, 'view/settlement_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: 'payments' }).catch(refuse),
  ]);
  const rows = work.rows;
  const data = settlementMerge(payload, { payments: paymentsWork(rows) });
  return { ...data, base: scope.base, empty: payload.importedClaim === null && !data.narrative && data.payments.count === 0 };
};
