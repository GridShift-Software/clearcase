import { error, type RequestEvent } from '@sveltejs/kit';
import { intakeControllerFor, type SetView, type SubmissionView } from '$lib/submissions';

// The intake page reads the case's submissions through the same controller and authority as the JSON route.
export async function load(e: RequestEvent) {
	const caseId = (e.params as Record<string, string>).caseId;
	const controller = await intakeControllerFor(e);
	const r = await controller.list({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
	const body = (await r.json()) as { submissions?: SubmissionView[]; sets?: SetView[]; code?: string; message?: string };
	if (r.status === 503) return { caseId: caseId, available: false as const, submissions: [] as SubmissionView[], sets: [] as SetView[] };
	if (!r.ok) error(r.status, { message: body.message ?? 'Not found.', code: body.code });
	return { caseId: caseId, available: true as const, submissions: body.submissions ?? [], sets: body.sets ?? [] };
}
