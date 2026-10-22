import { asset } from '#lib/server/case.js';

/** A published asset of the case. Drafts are never served here, only to an operator with a grant (/operator/...). */
export const GET = ({ locals, params }) => asset(locals.access.caseId, 'published', params.name);
