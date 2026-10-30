import { deserialize } from '$app/forms';
import type { SubmitFunction } from '$app/forms';

// Note composers own the request's settlement: enhance deliberately omits its result callback on AbortError, so a
// callback alone cannot release their readonly state. Cancel its default request and await this one in try/finally.
export async function postNote({ action, formData, controller }: Pick<Parameters<SubmitFunction>[0], 'action' | 'formData' | 'controller'>) {
	const body = new URLSearchParams();
	for (const [key, value] of formData) {
		if (typeof value !== 'string') throw new Error('A note form cannot upload files.');
		body.append(key, value);
	}
	const response = await fetch(action, {
		method: 'POST',
		headers: { accept: 'application/json', 'x-sveltekit-action': 'true', 'content-type': 'application/x-www-form-urlencoded' },
		body,
		signal: controller.signal,
	});
	const result = deserialize(await response.text());
	switch (result?.type) {
		case 'success': case 'failure': case 'redirect': case 'error': return result;
		default: throw new Error('The note action did not return a result.');
	}
}
