import type { RequestEvent } from '@sveltejs/kit';
import { comingSoon } from '$lib/views/hosted/payloads.server';

// A registry view that hosted has not ported yet; one marked never (the system views) is 404. The layout has authorized the version.
export const load = ({ params }: RequestEvent) => comingSoon(`/${params.category ?? ''}/${params.view ?? ''}`);
