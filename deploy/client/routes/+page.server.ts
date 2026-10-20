import { redirect, type RequestEvent } from '@sveltejs/kit';

export function load({ locals }: RequestEvent) {
	redirect(303, locals.identity.kind === 'verified' ? '/cases' : '/sign-in');
}
