// Form actions posted with fetch (no navigation), so a failed write keeps what the user did on the page and shows the
// error. A busy store answers fail(503) after its retries; a lost server is a network error.
import { deserialize } from '$app/forms';

export type Posted = { ok: true; data: Record<string, unknown> | undefined } | { ok: false; message: string };
export const UNREACHABLE = 'Not saved: the app could not be reached. Your input is kept; try again.';

export async function postAction(action: string, entries: Iterable<[string, string]>): Promise<Posted> {
	const body = new FormData();
	for (const [k, v] of entries) body.append(k, v);
	let text: string;
	try {
		const r = await fetch(`?/${action}`, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } });
		text = await r.text();
	} catch { return { ok: false, message: UNREACHABLE }; }
	let res;
	try { res = deserialize(text); } catch { return { ok: false, message: UNREACHABLE }; }
	if (res.type === 'success') return { ok: true, data: res.data };
	if (res.type === 'failure') return { ok: false, message: String((res.data as { message?: unknown } | undefined)?.message ?? 'Not saved.') };
	return { ok: false, message: res.type === 'error' ? `Not saved: ${String((res.error as { message?: unknown })?.message ?? 'error')}` : 'Not saved.' };
}
