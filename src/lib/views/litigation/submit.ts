// What a litigation save that got no action result means (GRS-18). SvelteKit's enhance turns both a request that never
// got an answer (the server stopped, the connection dropped) and an HTTP error before the action ran (413: the body is
// over the server's request size limit) into a result of type 'error'; only the second has a status. A message says
// "try again" only where a retry can succeed. Browser-safe.

export const LOST = 'Not saved: the app could not be reached. Your entry is kept below; try again once it is running.';

export const REQUEST_LIMIT = '512 KiB';

export type Op = 'add' | 'delete' | 'status';
export interface Failure { message: string; retry: boolean }

export const failureMessage = (data: Record<string, unknown> | undefined) => (typeof data?.message === 'string' ? data.message : null);

export const refused = (data: Record<string, unknown> | undefined, fallback: string): Failure => ({ message: failureMessage(data) ?? fallback, retry: data?.retry === true });

export function lostMessage(op: Op, status?: number): Failure {
	const what = op === 'delete' ? 'Not deleted' : 'Not saved';
	const kept = op === 'add' ? 'Your entry is kept below' : op === 'status' ? 'Your choice is kept' : 'The entry is still listed';
	if (status === 413) return { message: `${what}: it is too large to send. The app accepts at most ${REQUEST_LIMIT} in one request. ${kept}; shorten it before saving.`, retry: false };
	if (status) return { message: `${what}: the app reported an error (${status}). ${kept}; check the list, then try again.`, retry: true };
	if (op === 'add') return { message: LOST, retry: true };
	return { message: `${what}: the app could not be reached. ${kept}; try again once it is running.`, retry: true };
}
