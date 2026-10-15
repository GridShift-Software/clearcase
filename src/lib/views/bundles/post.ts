import { deserialize } from '$app/forms';

export type Posted = { ok: true; data: Record<string, unknown> | undefined } | { ok: false; message: string; status: number; data?: Record<string, unknown> };
export const UNREACHABLE = 'Not saved: the app could not be reached. Your input is kept; try again.';
export const TOO_LARGE = 'Not saved: the request was larger than the app accepts (413). Your input is kept.';

export async function postAction(action: string, entries: Iterable<[string, string]>): Promise<Posted> {
	const body = new FormData();
	for (const [k, v] of entries) body.append(k, v);
	let text: string, status: number;
	try {
		const r = await fetch(`?/${action}`, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } });
		status = r.status;
		text = await r.text();
	} catch { return { ok: false, message: UNREACHABLE, status: 0 }; }
	if (status === 413) return { ok: false, message: TOO_LARGE, status };
	let res;
	try { res = deserialize(text); } catch { return { ok: false, message: UNREACHABLE, status }; }
	if (res.type === 'success') return { ok: true, data: res.data };
	if (res.type === 'failure') {
		const data = res.data as Record<string, unknown> | undefined;
		return { ok: false, message: String(data?.message ?? 'Not saved.'), status: res.status, data };
	}
	return { ok: false, message: res.type === 'error' ? `Not saved: ${String((res.error as { message?: unknown })?.message ?? 'error')}` : 'Not saved.', status };
}
