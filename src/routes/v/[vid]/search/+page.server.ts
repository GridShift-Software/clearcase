import { redirect } from '@sveltejs/kit';
import { viewById, viewHref } from '$lib/components/views';
import type { PageServerLoad } from './$types';

// The prototype's search route: Advanced Search is a registry entry owned by GRS-14 (evidence subtree).
export const load: PageServerLoad = ({ params }) => redirect(308, viewHref(params.vid, viewById('search')!));
