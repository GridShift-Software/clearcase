import { json } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';

/** Which client this deployment serves and what its bindings hold, so a probe can tell one client's Worker from another's. */
export async function GET() {
	const notes = env.DB ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first()).n : null;
	return json({ ok: true, client: env.CLEARCASE_CLIENT_ID ?? null, notes, bucket: typeof env.BUCKET?.put === 'function' });
}
