import { registerActions, registerLoad } from '$lib/views/registers/page.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = registerLoad('disbursements_tab');
export const actions: Actions = registerActions('disbursements_tab');
