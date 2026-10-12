import { filingsActions, filingsLoad } from '$lib/views/evidence/filings.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = filingsLoad;
export const actions: Actions = filingsActions;
