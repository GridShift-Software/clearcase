import { env } from 'cloudflare:workers';

/** The caller's assigned cases only: membership or an admin role lists nothing more. */
export async function load({ locals }) {
	const { principal } = locals.access;
	const { results } = await env.DB.prepare('SELECT c.id, c.title, a.role FROM assignments a JOIN cases c ON c.id = a.case_id WHERE a.app = ? AND a.subject = ? ORDER BY c.id').bind(principal.app, principal.subject).all();
	return { cases: results };
}
