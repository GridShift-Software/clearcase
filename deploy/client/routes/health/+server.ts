import { json, type RequestEvent } from '@sveltejs/kit';
import { codeOf } from '$lib/server/runtime/errors';

// The runtime report: which runtime serves the request, the artifact's build stamp, the gate run (hosted-gate only)
// and a real D1 and R2 round trip. 200 only when the stamp is valid and every binding answers; it releases no case data.
export async function GET({ locals }: RequestEvent) {
	const r = locals.runtime;
	const read = <T>(get: () => T) => {
		try {
			return { value: get(), error: null };
		} catch (e) {
			return { value: null, error: codeOf(e) ?? 'error' };
		}
	};
	const build = read(() => r.build), gate = read(() => r.gate), probe = await r.probe().catch(() => null);
	const ok = build.value !== null && probe?.ok === true && (build.value.profile === 'production' || gate.value !== null);
	return json({ ok, runtime: navigator.userAgent, build: build.value, buildError: build.error, gate: gate.value, probe, identityProvider: r.testIdentity?.provider ?? null }, { status: ok ? 200 : 503 });
}
