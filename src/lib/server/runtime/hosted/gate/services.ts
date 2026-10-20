// TEST DOUBLES for the hosted gate (GRS-138). They are built only when CLEARCASE_HOSTED_PROFILE=hosted-gate selects
// ./hooks.server.ts, and the import guard and the artifact scan refuse them in a production artifact. They implement
// the request contracts over the local D1 and R2 that `start:hosted` provisions with the synthetic two-client fixture:
// a test identity stands in for the identity provider, fixture tables for GRS-117's storage and GRS-118's originals.
// User work and results stay unavailable until their owners land.
import type { Readiness } from '../handle.ts';
import type { RequestServices, Runtime } from '../../contracts.ts';
import { createUnavailableServices } from '../../unavailable.ts';
import { contractError } from '../../errors.ts';
import { id, sha256 } from '../../ids.ts';
import { bindings } from '../bindings.ts';
import { buildStamp, probe } from '../runtime.ts';
import { presentedSession } from '../session.ts';
import { testIdentity } from './identity.ts';
import { d1Audit } from './audit.ts';
import { fixtureStore } from './store.ts';
import { fixtureAssets } from './assets.ts';

/** Marks an artifact that contains the gate doubles; the production artifact scan refuses any artifact holding it. */
export const TEST_DOUBLE_MARKER = 'clearcase-test-double:hosted-gate';

export async function gateServices(request: Request, env: Readonly<Record<string, unknown>>): Promise<Readiness> {
	const b = bindings(env), now = () => new Date();
	const unavailable = createUnavailableServices({ clientId: b.clientId ?? id('client', 'unconfigured'), now });
	const runtime = (testIdentity: Runtime['testIdentity']): Runtime => ({
		get build() { return buildStamp('hosted-gate'); },
		get gate() {
			if (!b.gate) throw contractError('missing-binding');
			return { runId: `${TEST_DOUBLE_MARKER}/${b.gate.runId}`, fixtureSha256: sha256(b.gate.fixtureSha256) };
		},
		testIdentity, now, probe: () => probe(b),
	});
	if (!b.DB || !b.BUCKET || !b.clientId || !b.gate) return { ready: false, reason: 'the hosted gate bindings are not provisioned', services: { ...unavailable, runtime: runtime(null) } };
	const { DB: db, BUCKET: bucket, clientId } = b;
	let identity: Awaited<ReturnType<typeof testIdentity>>;
	try {
		identity = await testIdentity({ db, clientId, presented: presentedSession(request), now });
	} catch {
		return { ready: false, reason: 'the test identity is unavailable', services: { ...unavailable, runtime: runtime(null) } };
	}
	const audit = d1Audit({ db, clientId, identity: identity.identity, now });
	const services: RequestServices = {
		identity: identity.identity,
		store: fixtureStore({ db, clientId, base: unavailable.store, identity, audit }),
		assets: fixtureAssets({ db, bucket, clientId, identity: identity.identity, audit }),
		userWork: unavailable.userWork,
		audit: audit.sink,
		runtime: runtime(identity.double),
	};
	return { ready: true, services };
}
