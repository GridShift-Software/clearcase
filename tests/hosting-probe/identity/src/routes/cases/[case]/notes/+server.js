import { addNote, notes } from '#lib/server/case.js';
import { body, json } from '#lib/server/http.js';

export const GET = async ({ locals }) => json({ notes: await notes(locals.access.caseId) });

export async function POST({ locals, request }) {
	const b = await body(request);
	const r = await addNote(locals.access, String(b.requestId ?? ''), String(b.body ?? ''));
	return json(r.error ? { error: r.error } : { note: r.note, replayed: r.replayed }, { status: r.status });
}
