import type { Actions, RequestEvent } from '@sveltejs/kit';
import { hostedRegisterActions, hostedRegisterLoad } from '$lib/views/registers/hosted.server';

const read = hostedRegisterLoad('transcriptions_tab');
export const load = (event: RequestEvent) => read(event);
export const actions: Actions = hostedRegisterActions('transcriptions_tab');
