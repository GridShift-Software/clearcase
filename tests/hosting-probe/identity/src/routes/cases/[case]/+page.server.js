import { fail } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { addNote, caseView } from '#lib/server/case.js';

/** Case metadata, its documents and its Notes, for an assigned viewer or editor (the gate checked the assignment). */
export const load = ({ locals }) => caseView(locals.access.caseId);

export const actions = {
	// A form action is a POST to this page, so it meets the page's POST gate (case-write) before it runs.
	note: async ({ request, locals }) => {
		const form = await request.formData();
		const r = await addNote(locals.access, String(form.get('requestId') ?? ''), String(form.get('body') ?? ''));
		return r.status >= 400 ? fail(r.status, { error: r.error }) : { saved: r.note.id, replayed: r.replayed, count: (await env.DB.prepare('SELECT COUNT(*) AS n FROM notes WHERE case_id = ?').bind(locals.access.caseId).first()).n };
	},
};
