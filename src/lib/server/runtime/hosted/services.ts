import type { Readiness } from './handle.ts';
import { createUnavailableServices } from '../unavailable.ts';
import { id } from '../ids.ts';

// No feature owner has landed a hosted adapter yet, so every protected service is unavailable and nothing is ready.
export async function hostedServices(_request: Request): Promise<Readiness> {
	return { ready: false, reason: 'the hosted services are not configured', services: createUnavailableServices({ clientId: id('client', 'unconfigured'), now: () => new Date() }) };
}
