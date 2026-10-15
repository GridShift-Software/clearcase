import { registerActions, registerLoad } from '$lib/views/registers/page.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = registerLoad('privilege_tab');
export const actions: Actions = registerActions('privilege_tab');
