import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, INPUTS, ENVIRONMENT, expectedResults, problems } from './check.mjs';
import { INSTANCES, HOLD, LIFECYCLE, transcript } from './transcript.mjs';
import { observe } from './scenario.mjs';

const head = 'a'.repeat(40);
const context = { head, digestAt: () => 'sha256:fixture' };
function fixture() {
	return structuredClone({ schema: SCHEMA, sourceSha: head, inputs: { paths: INPUTS, digest: 'sha256:fixture' }, treeClean: true, mode: 'live-clerk-development', environment: ENVIRONMENT, instances: INSTANCES,
		served: { a: head, c: head }, results: expectedResults(), lifecycle: LIFECYCLE.map((assertion) => ({ assertion, pass: true })), storesUnchanged: { a: true, c: true },
		cleanup: { usersCreated: 4, usersDeleted: 4, invitationsCreated: 4, invitationsDeleted: 4, sessionsCreated: 6, sessionsEnded: 6, remaining: 0 }, scan: { files: 100, hits: 0 }, hold: HOLD, evidence: true });
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
