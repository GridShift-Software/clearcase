import { env } from 'cloudflare:workers';
import { json } from '#lib/server/http.js';

/** The staff app's members and roles, for the Global Admin. */
export async function GET() {
	const { results } = await env.DB.prepare("SELECT subject, role FROM members WHERE app = 'staff' AND active = 1 ORDER BY joined_at, subject").all();
	return json({ members: results });
}
