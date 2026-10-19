import { json } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';

/** Which bindings this Worker received, each checked by its API rather than by name, and D1's engine version. */
export async function GET() {
	const has = (name, method) => typeof env[name]?.[method] === 'function';
	const sqlite = has('DB', 'prepare') ? (await env.DB.prepare('SELECT sqlite_version() AS v').first()).v : null;
	return json({ DB: has('DB', 'prepare'), BUCKET: has('BUCKET', 'put'), ASSETS: has('ASSETS', 'fetch'), sqlite });
}
