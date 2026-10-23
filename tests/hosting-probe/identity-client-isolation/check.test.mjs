import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, INPUTS, ENVIRONMENT, expectedResults, problems } from './check.mjs';
import { INSTANCES, HOLD, LIFECYCLE, transcript, tokenSlot } from './transcript.mjs';
import { observe } from './scenario.mjs';

const head = 'a'.repeat(40);
const manifest = [
	['build', 'cloudflare/_worker.js'], ['run', 'logs/build.log'], ['run', 'summary-scan.json'],
	...['a', 'c'].flatMap((c) => [['run', `${c}/logs/serve-0.log`], ['run', `${c}/persist/client/state.sqlite`], ['run', `${c}/persist/staff/state.sqlite`]]),
].map(([root, path]) => ({ root, path, bytes: 10, sha256: 'b'.repeat(64) }));
const context = { head, digestAt: () => 'sha256:fixture', coverageAt: () => manifest };
function fixture() {
	return structuredClone({ schema: SCHEMA, sourceSha: head, inputs: { paths: INPUTS, digest: 'sha256:fixture' }, treeClean: true, mode: 'live-clerk-development', runDir: '.local/hosting-probe/identity-client-isolation/live-fixture', environment: ENVIRONMENT, instances: INSTANCES,
		served: { a: head, c: head }, results: expectedResults(), lifecycle: LIFECYCLE.map((assertion) => ({ assertion, pass: true })), storesUnchanged: { a: true, c: true },
		cleanup: { usersCreated: 4, usersDeleted: 4, invitationsCreated: 4, invitationsDeleted: 4, sessionsCreated: 10, sessionsEnded: 10, remaining: 0 }, scan: { files: manifest.length, hits: 0, manifest }, hold: HOLD, evidence: true });
}
test('complete synthetic checker fixture is accepted (not provider evidence)', () => assert.deepEqual(problems(fixture(), context), []));
const corruptions = {
	'invented command': (s) => { s.results[0].command = 'pretend command'; },
	'invented assertion': (s) => { s.results[0].assertion = 'pretend assertion'; },
	'missing reciprocal direction': (s) => { s.results = s.results.filter((r) => r.target !== 'c'); },
	'missing positive': (s) => { s.results.splice(0, 1); },
	'altered environment': (s) => { s.environment.remote = true; },
	'incomplete environment': (s) => { delete s.environment.CLOUDFLARE_CF_FETCH_ENABLED; },
	'stale digest': (s) => { s.inputs.digest = 'sha256:stale'; },
	'wrong revision': (s) => { s.sourceSha = 'b'.repeat(40); },
	'stale served build': (s) => { s.served.c = 'b'.repeat(40); },
	'incomplete cleanup': (s) => { s.cleanup.sessionsEnded--; },
	'leaked content': (s) => { s.results[6].observed.leaked = true; },
	'failed positive': (s) => { s.results[0].observed.status = 401; },
	'fabricated lifecycle': (s) => { s.lifecycle[0].assertion = 'pretend build'; },
	'mutated store': (s) => { s.storesUnchanged.a = false; },
	'credential hit': (s) => { s.scan.hits = 1; },
	'absent scan': (s) => { s.scan.files = 0; },
	'partial scan': (s) => { s.scan.files = 1; s.scan.manifest = s.scan.manifest.slice(0, 1); },
	'altered scanned file': (s) => { s.scan.manifest[0].sha256 = 'c'.repeat(64); },
	'escaping scan directory': (s) => { s.runDir = '../elsewhere'; },
	'offline mode': (s) => { s.mode = 'crafted'; },
	'extra field': (s) => { s.acceptAnyway = true; },
	'dirty tree': (s) => { s.treeClean = false; },
	'no evidence': (s) => { s.evidence = false; },
};
for (const [name, change] of Object.entries(corruptions)) test(`refuses ${name}`, () => { const s = fixture(); change(s); assert.notDeepEqual(problems(s, context), []); });
test('observation refuses content leaks even on a 401 and wrong denial causes', () => {
	const r = transcript().find((x) => x.actor === 'foreign');
	assert.equal(observe(r, { status: 401, denial: 'token-invalid', body: 'CC108-CASE1-META' }).pass, false);
	assert.equal(observe(r, { status: 401, denial: 'token-expired', body: '' }).pass, false);
	assert.equal(observe(r, { status: 401, denial: 'token-invalid', body: '' }).pass, true);
});
test('observation requires the expected positive marker', () => {
	const r = transcript()[0];
	assert.equal(observe(r, { status: 200, denial: null, body: 'unrelated page' }).pass, false);
});
test('issuer controls use the recipient party, including staff gates and own-client denials', () => {
	assert.deepEqual(tokenSlot('a', 'foreign', true), { person: 'c', party: 'staff-a' });
	assert.deepEqual(tokenSlot('c', 'foreign', true), { person: 'a', party: 'staff-c' });
	assert.deepEqual(tokenSlot('a', 'foreign', false), { person: 'c', party: 'client-a' });
	assert.deepEqual(tokenSlot('a', 'own-client', true), { person: 'a', party: 'staff-a' });
	assert.deepEqual(tokenSlot('c', 'own-client', true), { person: 'c', party: 'staff-c' });
	assert.deepEqual(tokenSlot('a', 'wrong-party', true), { person: 'staff-c', party: 'staff-c' });
	for (const target of ['a', 'c']) assert.ok(transcript().some((r) => r.target === target && r.actor === 'own-client' && r.path.includes('/drafts/')));
});
test('checker refuses a self-consistent manifest lacking required roots', () => {
	const s = fixture(); s.scan.manifest = manifest.slice(0, 1); s.scan.files = 1;
	assert.ok(problems(s, { ...context, coverageAt: () => s.scan.manifest }).includes('incomplete scan coverage'));
});
