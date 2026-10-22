import { instances } from '#lib/server/identity.js';
import { invite } from '#lib/server/invite.js';

/** A firm admin invites a user into this client instance; the user sees no case until assigned. */
export const POST = (event) => invite(event, instances().own, 'client', 'member');
