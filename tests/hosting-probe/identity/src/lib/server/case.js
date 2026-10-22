// Case reads and the one user-work write (GRS-108). Every query is scoped to the case id the gate checked, never to
// an id from the body.
import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { ID, NAME } from './http.js';

export async function caseView(caseId) {
	const c = await env.DB.prepare('SELECT id, title FROM cases WHERE id = ?').bind(caseId).first();
	if (!c) error(404, 'no such case');
	const { results: documents } = await env.DB.prepare('SELECT id, title FROM documents WHERE case_id = ? ORDER BY id').bind(caseId).all();
	const { results: notes } = await env.DB.prepare('SELECT id, body, created_at FROM notes WHERE case_id = ? ORDER BY created_at, id').bind(caseId).all();
	return { case: c, documents, notes };
}

export async function documentText(caseId, docId) {
	const d = ID.test(docId) ? await env.DB.prepare('SELECT id, title, body FROM documents WHERE case_id = ? AND id = ?').bind(caseId, docId).first() : null;
	if (!d) error(404, 'no such document in this case');
	return d;
}

/** The R2 object `cases/<case>/<kind>/<name>`, or 404; kind is "published" for clients and "draft" for operators. */
export async function asset(caseId, kind, name) {
	const obj = NAME.test(name) ? await env.BUCKET.get(`cases/${caseId}/${kind}/${name}`) : null;
	if (!obj) error(404, 'no such asset');
	return new Response(obj.body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' } });
}

/**
 * Adds a Note once per request id: a retry after a lost response or an interrupted session returns the first save
 * (`replayed`) instead of a second Note. The same request id from another author is a conflict.
 */
export async function addNote(access, requestId, body) {
	if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId) || !body.trim() || body.length > 2000) return { status: 400, error: 'requestId (8-64 of A-Z a-z 0-9 -) and a body of at most 2000 characters are required' };
	const id = crypto.randomUUID();
	const inserted = await env.DB.prepare('INSERT INTO notes (id, case_id, author_app, author_subject, request_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (case_id, request_id) DO NOTHING')
		.bind(id, access.caseId, access.principal.app, access.principal.subject, requestId, body, new Date().toISOString())
		.run();
	const note = await env.DB.prepare('SELECT id, author_app, author_subject, body FROM notes WHERE case_id = ? AND request_id = ?').bind(access.caseId, requestId).first();
	if (note.author_app !== access.principal.app || note.author_subject !== access.principal.subject) return { status: 409, error: 'that request id belongs to another author' };
	return { status: inserted.meta.changes === 1 ? 201 : 200, note: { id: note.id, body: note.body }, replayed: inserted.meta.changes !== 1 };
}

export async function notes(caseId) {
	const { results } = await env.DB.prepare('SELECT id, body, created_at FROM notes WHERE case_id = ? ORDER BY created_at, id').bind(caseId).all();
	return results;
}
