import type { BindingProbe, BuildStamp, Profile } from '../contracts.ts';
import { validateBuildStamp } from '../build.ts';
import { digest } from '../data.ts';
import { contractError } from '../errors.ts';
import type { Bindings } from './bindings.ts';

// Replaced by vite.config.ts with the stamp `build:hosted` passes in CLEARCASE_BUILD_STAMP; undefined anywhere else.
declare const __CLEARCASE_BUILD__: string | undefined;
const embedded = typeof __CLEARCASE_BUILD__ === 'string' ? __CLEARCASE_BUILD__ : null;

/** The artifact's build stamp, only when it is valid and names this profile; otherwise invalid-build. */
export function buildStamp<P extends Profile>(profile: P): Readonly<BuildStamp<P>> {
	let value: unknown = null;
	try {
		value = embedded === null ? null : JSON.parse(embedded);
	} catch {
		throw contractError('invalid-build');
	}
	const stamp = validateBuildStamp(value);
	if (stamp.profile !== profile) throw contractError('invalid-build');
	return stamp as Readonly<BuildStamp<P>>;
}

// `start:hosted` provisions both sentinels: a D1 row naming the SHA-256 of an R2 object. Each probe is a real round trip.
export const R2_SENTINEL = 'runtime/sentinel';
export async function probe(b: Bindings): Promise<BindingProbe> {
	const bound = { DB: b.DB !== null, BUCKET: b.BUCKET !== null, ASSETS: b.ASSETS };
	let expected: string | null = null, r2 = false;
	try {
		expected = (await b.DB?.prepare('SELECT value FROM runtime_sentinel WHERE name = ?').bind('r2-sha256').first<{ value: string }>())?.value ?? null;
	} catch {
		expected = null;
	}
	try {
		const object = await b.BUCKET?.get(R2_SENTINEL);
		r2 = !!object && expected !== null && (await digest(new Uint8Array(await object.arrayBuffer()))) === expected;
	} catch {
		r2 = false;
	}
	const d1 = expected !== null;
	return { ok: bound.DB && bound.BUCKET && bound.ASSETS && d1 && r2, bindings: bound, probes: { d1, r2 } };
}
