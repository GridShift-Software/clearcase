import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { settlementMerge } from '$lib/views/quantum/settlement';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { PageServerLoad } from './$types';
import { paymentsWork } from '../payments_tab/work.server';

export const load: PageServerLoad = async ({ locals, params }) => {
  const scope = await publishedVersion(locals, params);
  const [payload, rows] = await Promise.all([
    shard<ViewShards['settlement_tab']>(locals, params, 'view/settlement_tab.json'),
    locals.userWork.listRows({ caseId: scope.caseId, store: 'payments' }).catch(refuse),
  ]);
  const data = settlementMerge(payload, { payments: paymentsWork(rows) });
  return { ...data, base: scope.base, empty: payload.importedClaim === null && !data.narrative && data.payments.count === 0 };
};
