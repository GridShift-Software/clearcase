import { json } from '#lib/server/http.js';
import { documentText } from '#lib/server/case.js';

export const GET = async ({ locals, params }) => json(await documentText(locals.access.caseId, params.doc));
