import { asset } from '#lib/server/case.js';

/** A draft (unpublished) asset: only an operator with a current grant for this case reaches it. */
export const GET = ({ locals, params }) => asset(locals.access.caseId, 'draft', params.name);
