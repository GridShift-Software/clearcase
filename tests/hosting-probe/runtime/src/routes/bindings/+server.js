import { json } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';

/** Which bindings this Worker received, each checked by its API rather than by name, and a D1 row count. */
export async function GET() {
	const has = (name, method) => typeof env[name]?.[method] === 'function';
	// D1 refuses SQLite's own functions (`sqlite_version()`: "not authorized to use function"), so ask a table instead.
	const notes = has('DB', 'prepare') ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first()).n : null;
	return json({ DB: has('DB', 'prepare'), BUCKET: has('BUCKET', 'put'), ASSETS: has('ASSETS', 'fetch'), notes });
}
