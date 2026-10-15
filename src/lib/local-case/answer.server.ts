import { error, fail, isHttpError, type ActionFailure } from '@sveltejs/kit';
import { app } from './app.server.ts';
import { UserWorkError } from './user-work.server.ts';

export interface Answer { op: string; values: Record<string, string> | null; message: string | null; retry: boolean; field?: string | null; target?: string; gone?: boolean }
export interface Say { busy: string; refused: string | ((e: UserWorkError) => string); failed: string }

export function answer<V extends Record<string, string> | null, X extends Record<string, unknown> = {}>(op: string, values: V, e: unknown, say: Say, extra: X = {} as X) {
	const busy = isHttpError(e) && e.status === 503;
	const refused = e instanceof UserWorkError;
	const message = busy ? say.busy : refused ? (typeof say.refused === 'string' ? say.refused : say.refused(e)) : say.failed;
	return fail(busy ? 503 : refused ? 400 : 500, { ...extra, op, values, message, retry: busy });
}

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

export function actionCase(params: { vid: string }, store: { getVersion(id: string): { case_id: string } | undefined } = app().store): { vid: string; caseId: string } {
	const v = store.getVersion(params.vid);
	if (!v) error(404, 'Unknown results version');
	return { vid: params.vid, caseId: v.case_id };
}
