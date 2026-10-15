import { redirect } from '@sveltejs/kit';
import { viewById, viewHref } from '$lib/components/views';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => redirect(308, viewHref(params.vid, viewById('search')!));
