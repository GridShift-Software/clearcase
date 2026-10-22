// The bounded-retry policy for a notice email (GRS-111), as the user accepted it for alpha on 16 October 2026 (GRS-93):
// bounded retries that prefer a possible duplicate generic notice over a missed one; publication, files and in-app
// state never wait on email; exactly-once delivery is not promised.
//
// Each failed send() is one of three outcomes:
// - permanent: the provider refused the message itself, so a retry cannot help. No retry; the operator sees it.
// - transient: the provider refused before accepting (rate or daily limit). Retry, at most MAX_ATTEMPTS in all.
// - ambiguous: acceptance is unknown (internal error, a delivery failure the docs do not explain, an error with no
//   known code, a timeout). Retry, at most MAX_ATTEMPTS in all, and mark the notice a possible duplicate, because
//   the earlier attempt may have been accepted. Email Sending has no idempotency key, and Message-ID is the
//   platform's, so the app cannot deduplicate at the recipient.
//
// The codes are Cloudflare's documented send() errors (Workers API page, updated 15 October 2026). The local
// simulator throws plain errors without a code for its two restrictions; they are matched by their text here, and
// counted permanent like the production codes they stand for.

export type Outcome = 'permanent' | 'transient' | 'ambiguous';
export const MAX_ATTEMPTS = 3;
/** How long one send() may take before the attempt is recorded as a timeout (ambiguous). */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;
/** The longest SEND_TIMEOUT_MS taken: a timer past 2^31 - 1 ms fires at once, and one of hours holds the request open. */
export const MAX_SEND_TIMEOUT_MS = 60_000;
/**
 * SEND_TIMEOUT_MS as milliseconds. Anything but a positive finite number of at most MAX_SEND_TIMEOUT_MS (absent, empty,
 * non-numeric, zero, negative, larger) is DEFAULT_SEND_TIMEOUT_MS: a NaN timer fires at once, which would mark every send
 * a timeout while it may have sent.
 */
export function sendTimeoutMs(value: string | undefined): number {
	const ms = value === undefined ? NaN : Number(value);
	return Number.isFinite(ms) && ms > 0 && ms <= MAX_SEND_TIMEOUT_MS ? ms : DEFAULT_SEND_TIMEOUT_MS;
}

/** Minutes after attempt n (1-based) before attempt n + 1 is due. */
export const BACKOFF_MINUTES = [5, 30];

const PERMANENT = new Set([
	'E_VALIDATION_ERROR',
	'E_FIELD_MISSING',
	'E_TOO_MANY_RECIPIENTS',
	'E_TOO_MANY_ATTACHMENTS',
	'E_SENDER_NOT_VERIFIED',
	'E_RECIPIENT_NOT_ALLOWED',
	'E_RECIPIENT_SUPPRESSED',
	'E_SENDER_DOMAIN_NOT_AVAILABLE',
	'E_CONTENT_TOO_LARGE',
	'E_HEADER_NOT_ALLOWED',
	'E_HEADER_USE_API_FIELD',
	'E_HEADER_VALUE_INVALID',
	'E_HEADER_VALUE_TOO_LONG',
	'E_HEADER_NAME_INVALID',
	'E_HEADERS_TOO_LARGE',
	'E_HEADERS_TOO_MANY',
	// the app's own refusals, before any send() call
	'NOTICE_CONTENT_REFUSED',
	'EMAIL_BINDING_MISSING',
	'RECIPIENT_MISSING',
]);
const TRANSIENT = new Set(['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED']);
export const DOCUMENTED_CODES = [...PERMANENT].filter((c) => c.startsWith('E_')).concat([...TRANSIENT], ['E_DELIVERY_FAILED', 'E_INTERNAL_SERVER_ERROR']);

/** The code recorded for a thrown send() error: its `code`, the simulator's restriction, or UNKNOWN. Never its message, which can echo an address. */
export function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && /^E_[A-Z_]+$/.test(code)) return code;
	const message = error instanceof Error ? error.message : '';
	if (/^email from \S+ not allowed$/.test(message)) return 'LOCAL_SENDER_NOT_ALLOWED';
	if (/^email to \S+ not allowed$/.test(message)) return 'LOCAL_RECIPIENT_NOT_ALLOWED';
	return 'UNKNOWN';
}

export function classify(code: string): Outcome {
	if (PERMANENT.has(code) || code === 'LOCAL_SENDER_NOT_ALLOWED' || code === 'LOCAL_RECIPIENT_NOT_ALLOWED') return 'permanent';
	if (TRANSIENT.has(code)) return 'transient';
	return 'ambiguous';
}

/** When attempt `n` (1-based) failed at `at` ms with `outcome`: the time the next attempt is due, or null for none. */
export function nextAttemptAt(n: number, outcome: Outcome, at: number): number | null {
	if (outcome === 'permanent' || n >= MAX_ATTEMPTS) return null;
	return at + BACKOFF_MINUTES[n - 1]! * 60_000;
}
