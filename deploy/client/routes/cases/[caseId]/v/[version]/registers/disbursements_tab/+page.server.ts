import type { Actions, RequestEvent } from '@sveltejs/kit';
import { hostedRegisterActions, hostedRegisterLoad } from '$lib/views/registers/hosted.server';

const read = hostedRegisterLoad('disbursements_tab');
export const load = (event: RequestEvent) => read(event);
export const actions: Actions = hostedRegisterActions('disbursements_tab');
