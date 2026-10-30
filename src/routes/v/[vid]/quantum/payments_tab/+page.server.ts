import { app } from '$lib/local-case/app.server';
import { localCtx } from '$lib/views/litigation/register.server';
import { content, payments, paymentsPure } from '$lib/views/quantum/data.server';
import { paymentsMerge } from '$lib/views/quantum/payments';
import { paymentsActions } from '$lib/views/quantum/payments-actions.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return paymentsMerge(paymentsPure({ store: app().store, vid: version.id, vc: content(version.id) }), { payments: payments(version.caseId) });
};

export const actions: Actions = paymentsActions(localCtx);
