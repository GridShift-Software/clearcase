import { error } from '@sveltejs/kit';
import { codeOf } from '../errors.ts';

// How a contract refusal answers over HTTP. An inaccessible case or asset reads as absent (404), never as forbidden, so
// a denial releases neither bytes nor existence; a write without authority is 403.
const STATUS: Record<string, { status: number; message: string }> = {
	unauthenticated: { status: 401, message: 'Sign in to continue.' },
	'invalid-session': { status: 401, message: 'Your session has ended. Sign in again.' },
	'wrong-client': { status: 401, message: 'This session belongs to another client. Sign in for this client.' },
	'not-found': { status: 404, message: 'Not found.' },
	'missing-original': { status: 410, message: 'This original is no longer available.' },
	'changed-original': { status: 410, message: 'This original failed its integrity check.' },
	'identity-unavailable': { status: 503, message: 'Sign-in is unavailable. Try again shortly.' },
	'storage-unavailable': { status: 503, message: 'Case storage is unavailable. Try again shortly.' },
	'asset-unavailable': { status: 503, message: 'Originals are unavailable. Try again shortly.' },
	'audit-unavailable': { status: 503, message: 'The audit log is unavailable, so nothing was released. Try again shortly.' },
};

/** Rethrows a contract refusal as the page or endpoint answer it maps to; any other error propagates unchanged. */
export function refuse(e: unknown, access: 'read' | 'write' = 'read'): never {
	const code = codeOf(e);
	if (code === 'forbidden') error(access === 'read' ? 404 : 403, { message: access === 'read' ? 'Not found.' : 'You do not have permission to do that.', code });
	const known = code === null ? undefined : STATUS[code];
	if (!known) throw e;
	error(known.status, { message: known.message, code: code! });
}
