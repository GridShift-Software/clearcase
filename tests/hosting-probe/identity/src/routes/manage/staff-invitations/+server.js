import { instances } from '#lib/server/identity.js';
import { invite } from '#lib/server/invite.js';

/** The Global Admin invites an operator into the staff app; an operator reaches no case until a client instance grants it. */
export const POST = (event) => invite(event, instances().own, 'staff', 'operator');
