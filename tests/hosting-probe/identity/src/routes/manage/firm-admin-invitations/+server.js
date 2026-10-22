import { instances } from '#lib/server/identity.js';
import { invite } from '#lib/server/invite.js';

/** The instance admin (a Global Admin) invites this client's first firm admin through the client's own Clerk instance. */
export const POST = (event) => invite(event, instances().own, 'client', 'firm_admin');
