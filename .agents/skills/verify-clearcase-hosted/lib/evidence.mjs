// What counts as hosted evidence for one exact revision. The runner, the inner lifecycle, `gate:hosted` and its refusal
// tests all judge with these functions, so a summary the gate accepts is one the skill would accept too. Each returns a
// problem string, or null when the document is evidence for `sha` (the full 40-character HEAD; a prefix is refused).
// Each judges its document against one expected shape: exact key sets (a missing or unknown key is a problem), types and
// values. Only a step's own `evidence` record, an `ms` and drive's `startedAt` are free-form. tests/hosted-foundation/gate/
// mutations.mjs walks every field of real-shaped evidence through these, so a field they forget cannot hide.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { steps as MAPPED } from './steps.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;
export const PROFILE = 'hosted-gate';
/** The Bun of package.json's packageManager, which the build stamp must name. */
export const BUN_PIN = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'package.json'), 'utf8')).packageManager?.replace(/^bun@/, '') ?? null;
/** The legs test:hosted runs for the hosted-gate profile (tests/hosted-foundation/runtime/smoke.ts, scripts/pilot/hosted.ts). */
export const TEST_LEGS = ['request', 'render', 'action', 'feature-map', 'denials', 'sign-out', 'import-boundary-negative'];
/** The drive steps every run must pass: one per mapped feature (features/*.md), in order. */
export const DRIVE_STEPS = ['sign-in', 'open-case', 'open-original', 'wrong-client', 'no-egress'];
/** The feature a drive step proves (lib/steps.mjs, features/*.md); the launch and the egress proof belong to none. */
export const featureOf = (id) => MAPPED.find((s) => s.id === id)?.feature ?? null;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v !== '';
const time = (v) => text(v) && !Number.isNaN(Date.parse(v));
const natural = (v) => Number.isInteger(v) && v > 0;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const STAMP_KEYS = ['revision', 'dirty', 'exported', 'builtAt', 'bun', 'buildId', 'target', 'profile'];

/** null when `v` is a plain object with exactly the keys `keys` (and, when listed, `optional` ones); else what differs. */
export function keysProblem(what, v, keys, optional = []) {
	if (!isObject(v)) return `${what} is ${JSON.stringify(v)?.slice(0, 60)}, not an object`;
	const missing = keys.filter((k) => !Object.hasOwn(v, k)), extra = Object.keys(v).filter((k) => !keys.includes(k) && !optional.includes(k));
	if (!missing.length && !extra.length) return null;
	return `${what}: ${[missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `unknown ${extra.join(', ')}` : ''].filter(Boolean).join('; ')}`;
}

const shaProblem = (what, got, sha) => {
	if (!FULL_SHA.test(sha ?? '')) return `${what}: the expected revision ${JSON.stringify(sha)} is not a full SHA`;
	if (got === sha) return null;
	return `${what} names revision ${typeof got === 'string' ? got : JSON.stringify(got)}, not HEAD ${sha}${typeof got === 'string' && got && sha.startsWith(got) ? ' (a prefix is not the revision)' : ''}`;
};

/** A build stamp (the sidecar's, the live /health's, the gate summary's) of a hosted-gate artifact built from `sha`. */
export function stampProblem(what, s, sha) {
	const keys = keysProblem(what, s, STAMP_KEYS);
	if (keys) return keys;
	return shaProblem(what, s.revision, sha)
		?? (s.dirty !== false ? `${what} was built from a dirty tree (dirty ${JSON.stringify(s.dirty)})` : null)
		?? (s.profile !== PROFILE ? `${what}: the artifact profile is ${JSON.stringify(s.profile)}, not ${PROFILE}` : null)
		?? (typeof s.buildId !== 'string' || !s.buildId.startsWith(`${sha.slice(0, 12)}-${PROFILE}-`) || !/-\d+$/.test(s.buildId) ? `${what}: the buildId ${JSON.stringify(s.buildId)} is not <sha12>-${PROFILE}-<time>` : null)
		?? (s.target !== 'cloudflare' ? `${what}: the target is ${JSON.stringify(s.target)}, not cloudflare` : null)
		?? (s.bun !== BUN_PIN ? `${what} names Bun ${JSON.stringify(s.bun)}, not the pin ${BUN_PIN}` : null)
		?? (s.exported !== false ? `${what}: exported is ${JSON.stringify(s.exported)}; build:hosted builds the checkout in place (false)` : null)
		?? (!time(s.builtAt) ? `${what}: builtAt ${JSON.stringify(s.builtAt)} is not a time` : null);
}

/** The build sidecar (.svelte-kit/clearcase-hosted.json) and Kit's _app/version.json of a hosted-gate artifact built from `sha`. */
export function buildProblem(sidecar, version, sha) {
	if (!isObject(sidecar) || sidecar.schema !== 'clearcase.hosted-build/1' || !isObject(sidecar.stamp)) return `build: no clearcase.hosted-build/1 stamp (${JSON.stringify(sidecar)?.slice(0, 200)})`;
	return keysProblem('build: the sidecar', sidecar, ['schema', 'stamp', 'artifact'])
		?? stampProblem('build: the artifact stamp', sidecar.stamp, sha)
		?? (typeof sidecar.artifact !== 'string' || !DIGEST.test(sidecar.artifact) ? 'build: the sidecar records no artifact digest' : null)
		?? keysProblem('build: _app/version.json', version, ['version'])
		?? shaProblem('build: _app/version.json', version?.version, sha);
}

/** build.json, which the run writes as { sidecar, version }. */
export const buildFileProblem = (doc, sha) => keysProblem('build.json', doc, ['sidecar', 'version']) ?? buildProblem(doc.sidecar, doc.version, sha);

/** health.json: what the live doctor accepted from /health of this run's server. `fixtureSha256` is the committed fixture's. */
export function healthProblem(doc, sha, fixtureSha256) {
	const bad = keysProblem('health.json', doc, ['ok', 'runtime', 'build', 'buildError', 'gate', 'probe', 'identityProvider'])
		?? stampProblem('health.json: the served build', doc.build, sha)
		?? keysProblem('health.json: gate', doc.gate, ['runId', 'fixtureSha256'])
		?? keysProblem('health.json: probe', doc.probe, ['ok', 'bindings', 'probes'])
		?? keysProblem('health.json: probe.bindings', doc.probe.bindings, ['DB', 'BUCKET', 'ASSETS'])
		?? keysProblem('health.json: probe.probes', doc.probe.probes, ['d1', 'r2']);
	if (bad) return bad;
	const wrong = (doc.ok !== true && 'ok is not true')
		|| (doc.runtime !== 'Cloudflare-Workers' && `runtime is ${JSON.stringify(doc.runtime)}, not Cloudflare-Workers`)
		|| (doc.buildError !== null && 'buildError is not null')
		|| (doc.identityProvider !== 'test-identity-double' && `identityProvider is ${JSON.stringify(doc.identityProvider)}, not test-identity-double`)
		|| (!text(doc.gate.runId) || !doc.gate.runId.startsWith('clearcase-test-double:hosted-gate/run-') ? `gate.runId is ${JSON.stringify(doc.gate.runId)}` : false)
		|| (doc.gate.fixtureSha256 !== fixtureSha256 && `gate.fixtureSha256 is ${JSON.stringify(doc.gate.fixtureSha256)}, not the committed gate fixture`)
		|| (doc.probe.ok !== true && 'probe.ok is not true')
		|| (['DB', 'BUCKET', 'ASSETS'].some((k) => doc.probe.bindings[k] !== true) && 'a binding is not live')
		|| (['d1', 'r2'].some((k) => doc.probe.probes[k] !== true) && 'a D1 or R2 probe failed');
	return wrong ? `health.json is not this run's server for HEAD ${sha}: ${wrong}` : null;
}

/** The summary `bun run --bun test:hosted` wrote (.local/hosted/test-<sha12>-hosted-gate.json). */
export function testSummaryProblem(doc, sha) {
	if (doc?.schema !== 'clearcase.hosted-test/1') return `test:hosted: no clearcase.hosted-test/1 summary (${JSON.stringify(doc)?.slice(0, 200)})`;
	const bad = keysProblem('test:hosted: the summary', doc, ['schema', 'revision', 'profile', 'artifact', 'base', 'runtime', 'node', 'bun', 'pass', 'legs', 'at']) ?? shaProblem('test:hosted: the summary', doc.revision, sha);
	if (bad) return bad;
	if (doc.profile !== PROFILE) return `test:hosted: the summary is for profile ${JSON.stringify(doc.profile)}, not ${PROFILE}`;
	if (doc.pass !== true) return `test:hosted: the summary says pass is ${JSON.stringify(doc.pass)}`;
	if (typeof doc.artifact !== 'string' || !DIGEST.test(doc.artifact)) return 'test:hosted: the summary records no artifact digest';
	if (typeof doc.base !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(doc.base)) return `test:hosted: the summary's base ${JSON.stringify(doc.base)} is not a loopback origin`;
	if (doc.runtime !== 'workerd via wrangler dev --local') return `test:hosted: the summary's runtime is ${JSON.stringify(doc.runtime)}, not workerd via wrangler dev --local`;
	if (!text(doc.node) || doc.bun !== BUN_PIN || !time(doc.at)) return `test:hosted: the summary's node ${JSON.stringify(doc.node)}, bun ${JSON.stringify(doc.bun)} (pin ${BUN_PIN}) or time ${JSON.stringify(doc.at)} is wrong`;
	const legs = Array.isArray(doc.legs) ? doc.legs : [];
	const shaped = legs.map((l, i) => keysProblem(`test:hosted: leg ${i}`, l, ['name', 'status', 'asserted'])).find(Boolean);
	if (shaped) return shaped;
	if (legs.map((l) => l.name).join() !== TEST_LEGS.join()) return `test:hosted: the legs are ${legs.map((l) => JSON.stringify(l.name)).join(', ')}, not ${TEST_LEGS.join(', ')}`;
	const weak = legs.filter((l) => l.status !== 'PASS' || !Array.isArray(l.asserted) || l.asserted.length === 0 || !l.asserted.every(text)).map((l) => l.name);
	return weak.length ? `test:hosted: no passing leg with assertions for ${weak.join(', ')}` : null;
}

/** drive.json: every drive step passed, in order, and the no-egress step's canary saw nothing. */
export function driveProblem(doc) {
	const ids = ['browser', ...DRIVE_STEPS];
	const bad = keysProblem('drive.json', doc, ['ok', 'partial', 'startedAt', 'results']);
	if (bad) return bad;
	if (doc.ok !== true || doc.partial !== false) return `drive.json: ok ${JSON.stringify(doc.ok)}, partial ${JSON.stringify(doc.partial)}`;
	if (!natural(doc.startedAt)) return `drive.json: startedAt ${JSON.stringify(doc.startedAt)} is not a time`;
	const results = Array.isArray(doc.results) ? doc.results : [];
	const shaped = results.map((r, i) => stepProblem(`drive.json: result ${i}`, r, ['id', 'feature', 'title', 'status', 'ms', 'evidence'])).find(Boolean);
	if (shaped) return shaped;
	if (results.map((r) => r.id).join() !== ids.join()) return `drive.json: the steps are ${results.map((r) => JSON.stringify(r.id)).join(', ')}, not ${ids.join(', ')}`;
	const notPassed = results.filter((r) => r.status !== 'PASS').map((r) => r.id);
	if (notPassed.length) return `drive.json: not passed: ${notPassed.join(', ')}`;
	const wrongFeature = results.find((r) => r.feature !== featureOf(r.id));
	if (wrongFeature) return `drive.json: step ${wrongFeature.id} names feature ${JSON.stringify(wrongFeature.feature)}, not ${JSON.stringify(featureOf(wrongFeature.id))}`;
	if (results.find((r) => r.id === 'no-egress').evidence.canaryHits !== 0) return 'drive.json: the no-egress canary saw a connection';
	return null;
}

/** One step record of drive.json or inner.json: exact keys, and a free-form `evidence` object. */
function stepProblem(what, r, keys) {
	return keysProblem(what, r, keys)
		?? (text(r.id) && text(r.title) && typeof r.status === 'string' && typeof r.ms === 'number' && isObject(r.evidence) ? null : `${what} (${JSON.stringify(r.id)}): id, title, status, ms or evidence has the wrong type`);
}

/** inner.json of one run: every step of `required` PASSED, nothing else, for `sha`. */
export function innerProblem(doc, sha, required) {
	const keys = keysProblem('inner', doc, ['ok', 'partial', 'revision', 'ports', 'stamp', 'state', 'results']);
	if (keys) return keys;
	if (doc.partial !== false || doc.ok !== true) return `inner: the run did not finish ok (ok ${JSON.stringify(doc.ok)}, partial ${JSON.stringify(doc.partial)})`;
	const bad = shaProblem('inner: the run', doc.revision, sha)
		?? keysProblem('inner: ports', doc.ports, ['app', 'canary'])
		?? stampProblem('inner: the build stamp', doc.stamp, sha)
		?? keysProblem('inner: the server state', doc.state, ['schema', 'pid', 'port', 'base', 'revision', 'profile', 'artifact', 'runDir', 'persist', 'runId', 'fixtureSha256', 'node', 'startedAt']);
	if (bad) return bad;
	const st = doc.state;
	const wrong = (!natural(doc.ports.app) || !natural(doc.ports.canary) ? 'ports are not numbers' : '')
		|| (st.schema !== 'clearcase.hosted-server/1' ? `state.schema ${JSON.stringify(st.schema)}` : '')
		|| shaProblem('inner: the server state', st.revision, sha)
		|| (st.profile !== PROFILE ? `state.profile ${JSON.stringify(st.profile)}` : '')
		|| (!natural(st.pid) || st.port !== doc.ports.app || st.base !== `http://127.0.0.1:${doc.ports.app}` ? `state.pid, port or base (${JSON.stringify([st.pid, st.port, st.base])}) is not this run's server` : '')
		|| (typeof st.artifact !== 'string' || !DIGEST.test(st.artifact) ? 'state.artifact is not a digest' : '')
		|| (!/^[0-9a-f]{64}$/.test(st.fixtureSha256 ?? '') || !text(st.node) || !time(st.startedAt) ? 'state.fixtureSha256, node or startedAt is wrong' : '')
		|| (!/^run-[\w.-]+$/.test(st.runId ?? '') || st.runDir !== `.local/hosted/${st.runId}` || st.persist !== `${st.runDir}/persist` ? `state.runId, runDir or persist (${JSON.stringify([st.runId, st.runDir, st.persist])}) is not one run's` : '');
	if (wrong) return `inner: ${wrong}`;
	const results = Array.isArray(doc.results) ? doc.results : [];
	const driven = new Set(['browser', ...DRIVE_STEPS]);
	const shaped = results.map((r, i) => stepProblem(`inner: result ${i}`, r, driven.has(r?.id) ? ['id', 'feature', 'title', 'status', 'ms', 'evidence', 'drive'] : ['id', 'title', 'status', 'ms', 'evidence'])).find(Boolean);
	if (shaped) return shaped;
	if (results.some((r) => driven.has(r.id) && r.drive !== true)) return 'inner: a drive step is not marked as the drive\'s';
	const wrongInner = results.find((r) => driven.has(r.id) && r.feature !== featureOf(r.id));
	if (wrongInner) return `inner: step ${wrongInner.id} names feature ${JSON.stringify(wrongInner.feature)}, not ${JSON.stringify(featureOf(wrongInner.id))}`;
	const notPass = results.filter((r) => r.status !== 'PASS').map((r) => `${r.id} ${r.status}`);
	if (notPass.length) return `inner: steps did not pass: ${notPass.join(', ')}`;
	const ids = results.map((r) => r.id);
	const missing = required.filter((id) => !ids.includes(id)), extra = ids.filter((id, i) => !required.includes(id) || ids.indexOf(id) !== i);
	if (missing.length) return `inner: required steps never ran: ${missing.join(', ')}`;
	return extra.length ? `inner: unexpected or repeated steps: ${extra.join(', ')}` : null;
}
