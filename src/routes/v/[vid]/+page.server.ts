import { redirect } from '@sveltejs/kit';
import { versionPath } from '$lib/local-case/model';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => redirect(307, `${versionPath(params.vid)}/overview`);
