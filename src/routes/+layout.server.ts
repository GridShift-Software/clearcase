import { app, stateStamp } from '$lib/local-case/app.server';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	const a = app();
	return { recovery: a.anyRecovery() ?? null, warnings: [...a.warnings].map(([key, message]) => ({ key, message })), stamp: stateStamp() };
};
