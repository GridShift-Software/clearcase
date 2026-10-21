import { notes } from '#lib/server/case.js';
import { json } from '#lib/server/http.js';

export const GET = async ({ locals }) => json({ notes: await notes(locals.access.caseId) });
