import { env } from 'cloudflare:workers';
import { json } from '#lib/server/http.js';

/** This app's audit events: who, which route, which case, the outcome. No case content. */
export async function GET() {
	const { results } = await env.DB.prepare('SELECT seq, at, app, subject, action, gate, case_id, outcome FROM audit ORDER BY seq').all();
	return json({ events: results });
}
