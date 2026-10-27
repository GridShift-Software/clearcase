import { error, type RequestEvent } from '@sveltejs/kit';
import { intakeControllerFor, type SubmissionView } from '$lib/submissions';

// The intake page reads the case's submissions through the same controller and authority as the JSON route.
export async function load(e: RequestEvent) {
	const caseId = (e.params as Record<string, string>).caseId;
	const controller = await intakeControllerFor(e);
	const r = await controller.list({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
	const body = (await r.json()) as { submissions?: SubmissionView[]; canUpload?: boolean; code?: string; message?: string };
	if (r.status === 503) return { caseId: caseId, available: false as const, submissions: [] as SubmissionView[] };
	if (!r.ok) error(r.status, { message: body.message ?? 'Not found.', code: body.code });
	// `canUpload` is advisory: the page shows the form only for `true`; the audited send still decides every upload.
	return { caseId: caseId, available: true as const, submissions: body.submissions ?? [], ...(typeof body.canUpload === 'boolean' ? { canUpload: body.canUpload } : {}) };
}
