import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { interestMerge } from '$lib/views/quantum/interest';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { RequestEvent } from '@sveltejs/kit';
import { paymentsWork } from '../payments_tab/work.server';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<ViewShards['interest_calc_tab']>(locals, params, 'view/interest_calc_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: 'payments' }).catch(refuse),
  ]);
  const rows = work.rows;
  const data = interestMerge(payload, { payments: paymentsWork(rows) });
  return { ...data, base: scope.base, empty: !data.headlineDue && !data.headlineDate && !data.note && data.paymentDates.length === 0 };
};
