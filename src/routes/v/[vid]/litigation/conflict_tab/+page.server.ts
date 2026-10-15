import { app } from '$lib/local-case/app.server';
import { datasetOf } from '$lib/local-case/results.server';
import type { PageServerLoad } from './$types';

const pick = (rows: unknown, keys: readonly string[]) =>
	(Array.isArray(rows) ? rows : []).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
		.map((r) => Object.fromEntries(keys.filter((k) => Object.hasOwn(r, k)).map((k) => [k, r[k]])));

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const store = app().store;
	return {
		people: pick(datasetOf(store, version.id, 'people'), ['name', 'email', 'org']),
		entities: pick(datasetOf(store, version.id, 'entities'), ['name', 'role', 'note']),
	};
};
