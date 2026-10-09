import { json } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json(app().importProgress(), { headers: { 'cache-control': 'no-store' } });
