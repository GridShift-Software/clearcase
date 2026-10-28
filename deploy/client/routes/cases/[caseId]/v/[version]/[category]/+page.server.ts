import type { RequestEvent } from '@sveltejs/kit';
import { comingSoon } from '$lib/views/hosted/payloads.server';

// A view without a category (`/chronology`) that hosted has not ported yet; the layout has authorized the version.
export const load = ({ params }: RequestEvent) => comingSoon(`/${params.category ?? ''}`);
