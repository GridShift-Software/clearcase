import { error, type RequestEvent } from '@sveltejs/kit';
import { operatorDownloadControllerFor, type OperatorSubmissionView } from '$lib/submissions/download';

// The operator page reads the case's finalized submissions through the same controller and authority as the JSON route.
export async function load(e: RequestEvent) {
	const caseId = (e.params as Record<string, string>).caseId;
	const controller = await operatorDownloadControllerFor(e);
	const r = await controller.list({ request: e.request, url: e.url, params: e.params as Record<string, string>, identity: e.locals.identity });
	const body = (await r.json()) as { submissions?: OperatorSubmissionView[]; pendingCount?: number; code?: string; message?: string };
	if (r.status === 503 && body.code === 'operator-download-unavailable') return { caseId, available: false as const, submissions: [] as OperatorSubmissionView[], pendingCount: 0 };
	if (!r.ok) error(r.status, { message: body.message ?? 'Not found.', code: body.code });
	return { caseId, available: true as const, submissions: body.submissions ?? [], pendingCount: body.pendingCount ?? 0 };
}
