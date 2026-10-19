import { error, fail } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';

const LATEST = 'probe/latest.txt';

/** The named binding, or a 503 that names it: a Worker deployed without a binding refuses instead of half-rendering. */
function binding(name) {
	const value = env[name];
	if (!value) error(503, `${name} binding is not configured`);
	return value;
}

export async function load() {
	const db = binding('DB');
	const bucket = binding('BUCKET');
	const { results } = await db.prepare('SELECT id, body FROM notes ORDER BY id').all();
	const latest = await bucket.get(LATEST);
	return { notes: results, latest: latest ? await latest.text() : null };
}

export const actions = {
	// D1 first, then R2: a refused D1 write leaves the R2 object as it was.
	save: async ({ request }) => {
		const db = binding('DB');
		const bucket = binding('BUCKET');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const body = String(form.get('body') ?? '').trim();
		if (!id || !body) return fail(400, { error: 'id and body are required' });
		try {
			await db.prepare('INSERT INTO notes (id, body) VALUES (?, ?)').bind(id, body).run();
		} catch (e) {
			if (String(e).includes('UNIQUE constraint failed')) return fail(409, { error: `note ${id} already exists` });
			throw e;
		}
		await bucket.put(LATEST, body);
		const back = await bucket.get(LATEST);
		return { saved: id, readBack: back ? await back.text() : null };
	}
};
