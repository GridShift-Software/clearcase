// What counts as hosted evidence for one exact revision. The runner, the inner lifecycle, `gate:hosted` and its refusal
// tests all judge with these functions, so a summary the gate accepts is one the skill would accept too. Each returns a
// problem string, or null when the document is evidence for `sha` (the full 40-character HEAD; a prefix is refused).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FULL_SHA = /^[0-9a-f]{40}$/;
export const PROFILE = 'hosted-gate';
/** The Bun of package.json's packageManager, which the build stamp must name. */
export const BUN_PIN = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'package.json'), 'utf8')).packageManager?.replace(/^bun@/, '') ?? null;
/** The legs test:hosted runs for the hosted-gate profile (tests/hosted-foundation/runtime/smoke.ts, scripts/pilot/hosted.ts). */
export const TEST_LEGS = ['request', 'render', 'action', 'feature-map', 'denials', 'sign-out', 'import-boundary-negative'];
/** The drive steps every run must pass: one per mapped feature (features/*.md), in order. */
export const DRIVE_STEPS = ['sign-in', 'open-case', 'open-original', 'wrong-client', 'no-egress'];

const shaProblem = (what, got, sha) => {
	if (!FULL_SHA.test(sha ?? '')) return `${what}: the expected revision ${JSON.stringify(sha)} is not a full SHA`;
	if (got === sha) return null;
	return `${what} names revision ${typeof got === 'string' ? got : JSON.stringify(got)}, not HEAD ${sha}${typeof got === 'string' && got && sha.startsWith(got) ? ' (a prefix is not the revision)' : ''}`;
};

/** The build sidecar (.svelte-kit/clearcase-hosted.json) and Kit's _app/version.json of a hosted-gate artifact built from `sha`. */
export function buildProblem(sidecar, version, sha) {
	const s = sidecar?.stamp;
	if (sidecar?.schema !== 'clearcase.hosted-build/1' || !s) return `build: no clearcase.hosted-build/1 stamp (${JSON.stringify(sidecar)?.slice(0, 200)})`;
	return shaProblem('build: the artifact stamp', s.revision, sha)
		?? (s.dirty !== false ? `build: the artifact was built from a dirty tree (dirty ${JSON.stringify(s.dirty)})` : null)
		?? (s.profile !== PROFILE ? `build: the artifact profile is ${JSON.stringify(s.profile)}, not ${PROFILE}` : null)
		?? (typeof s.buildId !== 'string' || !s.buildId ? 'build: the stamp has no buildId' : null)
		?? (s.target !== 'cloudflare' ? `build: the stamp's target is ${JSON.stringify(s.target)}, not cloudflare` : null)
		?? (s.bun !== BUN_PIN ? `build: the stamp names Bun ${JSON.stringify(s.bun)}, not the pin ${BUN_PIN}` : null)
		?? (s.exported !== false ? `build: the stamp's exported is ${JSON.stringify(s.exported)}; build:hosted builds the checkout in place (false)` : null)
		?? (typeof s.builtAt !== 'string' || Number.isNaN(Date.parse(s.builtAt)) ? `build: the stamp's builtAt ${JSON.stringify(s.builtAt)} is not a time` : null)
		?? (typeof sidecar.artifact !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(sidecar.artifact) ? 'build: the sidecar records no artifact digest' : null)
		?? shaProblem('build: _app/version.json', version?.version, sha);
}

/** The summary `bun run --bun test:hosted` wrote (.local/hosted/test-<sha12>-hosted-gate.json). */
export function testSummaryProblem(doc, sha) {
	if (doc?.schema !== 'clearcase.hosted-test/1') return `test:hosted: no clearcase.hosted-test/1 summary (${JSON.stringify(doc)?.slice(0, 200)})`;
	const bad = shaProblem('test:hosted: the summary', doc.revision, sha);
	if (bad) return bad;
	if (doc.profile !== PROFILE) return `test:hosted: the summary is for profile ${JSON.stringify(doc.profile)}, not ${PROFILE}`;
	if (doc.pass !== true) return `test:hosted: the summary says pass is ${JSON.stringify(doc.pass)}`;
	const legs = Array.isArray(doc.legs) ? doc.legs : [];
	const missing = TEST_LEGS.filter((n) => !legs.some((l) => l?.name === n && l.status === 'PASS' && Array.isArray(l.asserted) && l.asserted.length > 0 && l.asserted.every((a) => typeof a === 'string' && a !== '')));
	if (missing.length) return `test:hosted: no passing leg with assertions for ${missing.join(', ')}`;
	return null;
}

/** inner.json of one run: every step of `required` PASSED, nothing else failed or did not run, for `sha`. */
export function innerProblem(doc, sha, required) {
	if (!doc || doc.partial !== false || doc.ok !== true) return `inner: the run did not finish ok (ok ${JSON.stringify(doc?.ok)}, partial ${JSON.stringify(doc?.partial)})`;
	const bad = shaProblem('inner: the run', doc.revision, sha);
	if (bad) return bad;
	const results = Array.isArray(doc.results) ? doc.results : [];
	const notPass = results.filter((r) => r?.status !== 'PASS').map((r) => `${r?.id} ${r?.status}`);
	if (notPass.length) return `inner: steps did not pass: ${notPass.join(', ')}`;
	const missing = required.filter((id) => !results.some((r) => r.id === id));
	if (missing.length) return `inner: required steps never ran: ${missing.join(', ')}`;
	return null;
}
