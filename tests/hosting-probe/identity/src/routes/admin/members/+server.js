import { env } from 'cloudflare:workers';
import { json } from '#lib/server/http.js';

/** The client's members and roles for its firm admin: who is enrolled, not what any case holds. */
export async function GET() {
	const { results } = await env.DB.prepare("SELECT subject, role FROM members WHERE app = 'client' AND active = 1 ORDER BY joined_at, subject").all();
	return json({ members: results });
}
