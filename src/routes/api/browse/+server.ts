import { json } from '@sveltejs/kit';
import { listFolder } from '$lib/local-case/case-pack.server';
import type { RequestHandler } from './$types';

// The Import page's folder browser: names, kinds and sizes of one folder's subfolders and .zip files, never contents.
// GET only; hooks.server.ts refuses a cross-site request and a foreign Host before this runs.
export const GET: RequestHandler = async ({ url }) => json(await listFolder(url.searchParams.get('path')), { headers: { 'cache-control': 'no-store' } });
