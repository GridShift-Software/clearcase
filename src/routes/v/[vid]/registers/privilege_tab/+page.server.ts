// Privilege Log (GRS-17): the shared register page's load and actions for this view.
import { registerActions, registerLoad } from '$lib/views/registers/page.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = registerLoad('privilege_tab');
export const actions: Actions = registerActions('privilege_tab');
