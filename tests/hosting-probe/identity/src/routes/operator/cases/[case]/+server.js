import { caseView } from '#lib/server/case.js';
import { json } from '#lib/server/http.js';

export const GET = async ({ locals }) => json(await caseView(locals.access.caseId));
