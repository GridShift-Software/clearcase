import { fetchApp } from '../identity/harness.ts';
import { transcript } from './transcript.mjs';

export function observe(r, reply) {
	const denied = r.status === 401;
	const observed = { status: reply.status, denial: reply.denial,
		marker: Boolean(r.marker && reply.body.includes(r.marker)),
		leaked: denied ? /CC108-|CC201-/.test(reply.body) : /CC108-CASE2-/.test(reply.body) };
	const pass = observed.status === r.status && observed.denial === r.denial && observed.marker === Boolean(r.marker) && !observed.leaked;
	return { ...r, observed, pass };
}
// Both live and crafted runtime modes execute exactly this request sweep.
export async function sweep(worlds, progress = { results: [], storesUnchanged: {} }) {
	// The live caller retains these safe observations even when a later check throws.
	const { results, storesUnchanged } = progress;
	const before = {};
	for (const r of transcript()) {
		const w = worlds[r.target];
		if (r.actor === 'foreign' && !before[r.target]) before[r.target] = await w.snapshot();
		const token = await w.token(r.actor, r.staff ?? false);
		const form = r.path.includes('?/note');
		const payload = { requestId: `isolation-${r.target}-${r.actor}`, body: 'CC201-NOTE' };
		const reply = await fetchApp(w.origin, r.path, { token, method: r.method,
			headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json' },
			...(r.method === 'GET' ? {} : { body: form ? new URLSearchParams(payload).toString() : JSON.stringify(payload) }) });
		const result = observe(r, reply);
		results.push(result);
		if (!result.pass) throw new Error(`request contract failed: ${r.command}`);
	}
	for (const [name, w] of Object.entries(worlds)) {
		storesUnchanged[name] = before[name] === await w.snapshot();
		if (!storesUnchanged[name]) throw new Error(`hostile requests mutated ${name}'s store`);
	}
	return progress;
}
