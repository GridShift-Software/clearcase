// BA-19, the sign-in entry and recovery page. It reads only its own query: why the last request was refused and where
// to return, which must be a path on this origin. It never calls Clerk or D1. The hosted app mounts Clerk's sign-in
// component here (GRS-113); its copy is a placeholder for review.
const GUIDANCE = {
	'signed-out': 'Sign in to continue.',
	'token-expired': 'Your session needs refreshing. Sign in again if this page does not continue by itself.',
	'session-revoked': 'Your session was ended. Sign in again.',
	'session-ended': 'Your session has ended. Sign in again.',
	'wrong-party': 'This sign-in belongs to another ClearCase app. Sign in here.',
	'token-invalid': 'Your sign-in could not be checked. Sign in again.',
};

export function load({ url }) {
	const reason = url.searchParams.get('reason') ?? 'signed-out';
	const next = url.searchParams.get('next') ?? '/';
	return { reason: reason in GUIDANCE ? reason : 'signed-out', guidance: GUIDANCE[reason] ?? GUIDANCE['signed-out'], next: /^\/(?![/\\])[A-Za-z0-9/_.-]*$/.test(next) ? next : '/' };
}
