// Small helpers the probe's routes share (GRS-108).
import { error, json } from '@sveltejs/kit';

/** The JSON body of a request, or a 400 that names no value. */
export async function body(request) {
	try {
		const v = await request.json();
		if (v && typeof v === 'object' && !Array.isArray(v)) return v;
	} catch {}
	error(400, 'a JSON object body is required');
}

export const NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;
export const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const created = (v) => json(v, { status: 201 });
export { json };
