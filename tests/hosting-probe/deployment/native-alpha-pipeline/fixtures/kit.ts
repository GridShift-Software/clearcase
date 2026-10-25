// Shared synthetic Kit output. The manifest's start/app are executable browser modules,
// not version JSON or provenance labels. Negative additions never enter these trusted inputs.
import { readFileSync } from 'node:fs';

export const KIT_WORKER = readFileSync(new URL('./artifact/cloudflare/_worker.js', import.meta.url), 'utf8');
export const KIT_SERVER = KIT_WORKER.slice(0, KIT_WORKER.indexOf('export default'));
export const KIT_CLIENT_FILES = Object.fromEntries([
	'_app/immutable/entry/app.js',
	'_app/immutable/entry/start.js',
	'favicon.svg',
].map((rel) => [rel, readFileSync(new URL(`./artifact/public/${rel}`, import.meta.url))]));
