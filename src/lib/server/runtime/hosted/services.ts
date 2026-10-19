import type { Readiness } from './handle.ts';
import type { RequestServices } from '../contracts.ts';
import { createUnavailableServices } from '../unavailable.ts';
import { id } from '../ids.ts';
import { bindings } from './bindings.ts';
import { buildStamp, probe } from './runtime.ts';

// The production entry. No feature owner has landed a hosted adapter yet (the identity provider, GRS-117 storage,
// GRS-118 assets), so every protected service is unavailable and every protected request is refused with 503. The
// runtime handle still reports the build stamp and the binding probes on /health.
export async function hostedServices(_request: Request, env: Readonly<Record<string, unknown>>): Promise<Readiness> {
	const b = bindings(env), now = () => new Date();
	const services: RequestServices = createUnavailableServices({ clientId: b.clientId ?? id('client', 'unconfigured'), now });
	services.runtime = { get build() { return buildStamp('production'); }, gate: null, testIdentity: null, now, probe: () => probe(b) };
	return { ready: false, reason: 'the hosted services are not configured', services };
}
