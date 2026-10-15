import { app } from '$lib/local-case/app.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ cases: app().listCases() });
