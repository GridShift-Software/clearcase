import type { RequestEvent } from '@sveltejs/kit';
import { serveAsset } from '$lib/viewer/hosted/route';

// One derived asset (a preview) of one results version. Authority is read-preview and the assets handle enforces
// publication every time: only the exact published, not-withdrawn version answers; a candidate, a superseded or a
// withdrawn version reads as absent. Access to a case's originals before publication grants none of this.
export const GET = (event: RequestEvent) => serveAsset(event, 'preview', 'GET');
export const HEAD = (event: RequestEvent) => serveAsset(event, 'preview', 'HEAD');
