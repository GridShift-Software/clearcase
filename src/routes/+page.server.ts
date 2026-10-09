import { redirect } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { versionPath } from '$lib/local-case/model';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const cur = app().currentActive();
	redirect(307, cur?.vid ? `${versionPath(cur.vid)}/overview` : '/import');
};
