import { registerActions, registerLoad } from '$lib/views/registers/page.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = registerLoad('transcriptions_tab');
export const actions: Actions = registerActions('transcriptions_tab');
