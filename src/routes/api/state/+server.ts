import { json } from '@sveltejs/kit';
import { stateStamp } from '$lib/local-case/app.server';
import type { RequestHandler } from './$types';

// A restored (bfcache) page asks whether anything changed since it was rendered; it reloads only if so.
export const GET: RequestHandler = () => json({ stamp: stateStamp() }, { headers: { 'cache-control': 'no-store' } });
