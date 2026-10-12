// The answer of a form action whose user-work write failed (GRS-52), one shape for every view: `fail(status, {op,
// values, message, retry, ...extra})`. The typed values always travel back, so the form keeps the user's input and
// says what happened; nothing is lost to an error page. Only a busy store (the API's 503 after its retries) offers a
// retry: a refused write (UserWorkError, 400) would be refused again unchanged, and any other fault (500) is logged and
// never shown. Plus `actionCase`: the case of the version an action posts to (actions have no layout data).
import { error, fail, isHttpError, type ActionFailure } from '@sveltejs/kit';
import { app } from './app.server.ts';
import { UserWorkError } from './user-work.server.ts';

/** What a form action answers: its action, the values typed, and a message (null: nothing to say). */
export interface Answer { op: string; values: Record<string, string> | null; message: string | null; retry: boolean; field?: string | null; target?: string; gone?: boolean }
/** What a view says for each failure: busy, refused (fixed, or from the refusal) and any other fault. */
export interface Say { busy: string; refused: string | ((e: UserWorkError) => string); failed: string }

/** The answer to a failed write (pure: `guarded` logs the 500s). */
export function answer<V extends Record<string, string> | null, X extends Record<string, unknown> = {}>(op: string, values: V, e: unknown, say: Say, extra: X = {} as X) {
	const busy = isHttpError(e) && e.status === 503;
	const refused = e instanceof UserWorkError;
	const message = busy ? say.busy : refused ? (typeof say.refused === 'string' ? say.refused : say.refused(e)) : say.failed;
	return fail(busy ? 503 : refused ? 400 : 500, { ...extra, op, values, message, retry: busy });
}

/** Run a user-work write: its value, or the failure answer with the typed values. */
export async function guarded<T, V extends Record<string, string> | null, X extends Record<string, unknown> = {}>(op: string, values: V, write: () => Promise<T>, say: Say, extra: X = {} as X):
	Promise<{ ok: true; value: T } | { ok: false; failure: ActionFailure<X & { op: string; values: V; message: string; retry: boolean }> }> {
	try {
		return { ok: true, value: await write() };
	} catch (e) {
		const failure = answer(op, values, e, say, extra);
		if (failure.status === 500) console.error('user-work write failed', e);
		return { ok: false, failure };
	}
}

/** The case of the results version an action posts to; an unknown version is a 404. */
export function actionCase(params: { vid: string }, store: { getVersion(id: string): { case_id: string } | undefined } = app().store): { vid: string; caseId: string } {
	const v = store.getVersion(params.vid);
	if (!v) error(404, 'Unknown results version');
	return { vid: params.vid, caseId: v.case_id };
}
