import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { hostedCtx } from '$lib/views/litigation/hosted.server';
import { paymentsMerge } from '$lib/views/quantum/payments';
import { paymentsActions } from '$lib/views/quantum/payments-actions.server';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { Actions, RequestEvent } from '@sveltejs/kit';
import { paymentsWork } from '../payments_tab/work.server';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<ViewShards['payments_tab']>(locals, params, 'view/payments_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: 'payments' }).catch(refuse),
  ]);
  const rows = work.rows;
  const data = paymentsMerge(payload, { payments: paymentsWork(rows) });
  return { ...data, base: scope.base, empty: !data.claim && data.recon.length === 0 && data.payments.length === 0, operationId: crypto.randomUUID() };
};

export const actions: Actions = paymentsActions(hostedCtx);
