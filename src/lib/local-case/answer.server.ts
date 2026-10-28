import { error, fail, isHttpError, type ActionFailure } from '@sveltejs/kit';
import { app } from './app.server.ts';
import { UserWorkError } from './user-work.server.ts';
import type { UserWork } from './user-work.server.ts';

/** Local argument order with awaitable reads: hosted actions can use the same port without opening local storage. */
type WorkMethods = Pick<UserWork, 'listRows' | 'putRow' | 'deleteRow' | 'seedViews' | 'putSeedOverlay' | 'notesFor' | 'addNote' | 'deleteNote' | 'listTableRows' | 'putTableRow'>;
type AwaitableWork = { [K in keyof WorkMethods]: (...args: Parameters<WorkMethods[K]>) => ReturnType<WorkMethods[K]> | Promise<Awaited<ReturnType<WorkMethods[K]>>> };
export interface Work extends AwaitableWork {}

export interface Answer { op: string; values: Record<string, string> | null; message: string | null; retry: boolean; field?: string | null; target?: string; gone?: boolean }
export interface Say { busy: string; refused: string | ((e: UserWorkError) => string); failed: string }

export function answer<V extends Record<string, string> | null, X extends Record<string, unknown> = {}>(op: string, values: V, e: unknown, say: Say, extra: X = {} as X) {
	const busy = isHttpError(e) && e.status === 503;
	const refused = e instanceof UserWorkError;
	const message = busy ? say.busy : refused ? (typeof say.refused === 'string' ? say.refused : say.refused(e)) : say.failed;
	return fail(busy ? 503 : refused ? 400 : 500, { ...extra, op, values, message, retry: busy });
}

export async function guarded<T, V extends Record<string, string> | null, X extends Record<string, unknown> = {}>(op: string, values: V, write: (work: Work) => Promise<T>, say: Say, extra: X = {} as X, work?: Work):
	Promise<{ ok: true; value: T } | { ok: false; failure: ActionFailure<X & { op: string; values: V; message: string; retry: boolean }> }> {
	try {
		// Existing zero-argument callbacks keep their lazy access to app().
		return { ok: true, value: await write(work ?? (write.length ? app().userWork : undefined as unknown as Work)) };
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
