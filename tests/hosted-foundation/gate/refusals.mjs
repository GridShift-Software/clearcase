#!/usr/bin/env bun
// The hosted gate's refusal tests (GRS-138): one throwaway case per condition the gate must refuse, each required to
// fail the gate, plus a positive control that must pass. `gate:hosted` runs this as its first step; run it alone with
//   bun tests/hosted-foundation/gate/refusals.mjs [--out FILE]
// It is not a Vitest file, because Vitest's include globs do not collect tests/hosted-foundation/gate/.
//
// dirty-tree, reduced-run and missing-binding run the real `scripts/gate-hosted.mjs` in a throwaway clone of HEAD
// (node_modules linked) and require `GATE FAIL <step>` before any step ran. stale-stamp and summary-not-evidence drive
// the gate's own runHostedGate with its real validators and a run that writes the evidence a real run writes, with one
// field changed per case; the unchanged control must give GATE PASS, so each refusal is that field's doing.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { REDUCED_ENV } from '../../../scripts/gate.mjs';
import { CHECKS, gateSummaryProblem, runHostedGate } from '../../../scripts/gate-hosted.mjs';
import { LIFECYCLE } from '../../../.agents/skills/verify-clearcase-hosted/lib/main.mjs';
import { DRIVE_STEPS, TEST_LEGS } from '../../../.agents/skills/verify-clearcase-hosted/lib/evidence.mjs';
import { gateFixture } from '../runtime/gate-fixture.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const LEADER_ENV = 'CLEARCASE_HOSTED_GATE_LEADER';
const git = (cwd, ...a) => {
	const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=refusal-test', '-c', 'user.email=refusal-test@example.invalid', ...a], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.trim()}`);
	return r.stdout.trim();
};
const SHA = git(REPO, 'rev-parse', 'HEAD');
const PARENT = git(REPO, 'rev-parse', 'HEAD~1');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(REPO, '.local', 'gate-hosted', 'refusals.json');
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'clearcase-gate-refusals-'));

const report = { schema: 'clearcase-hosted-gate-refusals/1', sha: SHA, control: null, refusals: [] };
function refusal(name, cases) {
	const r = { name, status: cases.every((c) => c.status === 'PASS') && cases.length > 0 ? 'PASS' : 'FAIL', cases };
	report.refusals.push(r);
	console.log(`${r.status} ${name} (${cases.length} cases)${r.status === 'PASS' ? '' : `: ${cases.filter((c) => c.status !== 'PASS').map((c) => `${c.case}: ${c.got}`).join('; ')}`}`);
}

// --- The real CLI in a throwaway clone -------------------------------------------------------------------------------

const clone = join(scratch, 'clone');
git(REPO, 'clone', '-q', '--shared', '--no-checkout', REPO, clone);
git(clone, 'checkout', '-q', '--detach', SHA);
symlinkSync(join(REPO, 'node_modules'), join(clone, 'node_modules'));
const reset = () => { git(clone, 'checkout', '-q', '--detach', '-f', SHA); git(clone, 'clean', '-q', '-fdx', '-e', 'node_modules'); };

/** Runs the clone's gate as its own leader (no re-exec, so the timeout reaches it) with `extraEnv` and `args`. */
function cliGate(extraEnv = {}, args = []) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(k in REDUCED_ENV) && k !== 'CLEARCASE_BROWSER_LOCK' && !k.startsWith('CLEARCASE_HOSTED_')));
	const r = spawnSync(process.execPath, ['scripts/gate-hosted.mjs', ...args], { cwd: clone, encoding: 'utf8', timeout: 60_000, env: { ...env, [LEADER_ENV]: clone, ...extraEnv } });
	return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, head: git(clone, 'rev-parse', 'HEAD') };
}
/** The gate must exit 1 with `GATE FAIL <step> <head>`, a line matching `why`, no step line, and no evidence directory. */
function refusedBy(step, why, r) {
	const lines = r.out.trim().split('\n');
	const ran = lines.filter((l) => /^(PASS|FAIL|SKIP) /.test(l));
	const evidence = spawnSync('ls', [join(clone, '.local', 'gate-hosted', r.head.slice(0, 12))]).status === 0;
	const ok = r.code === 1 && lines.at(-1) === `GATE FAIL ${step} ${r.head}` && lines.some((l) => why.test(l)) && !ran.length && !evidence;
	return { status: ok ? 'PASS' : 'FAIL', got: ok ? lines.at(-1) : `exit ${r.code}, ${evidence ? 'evidence written, ' : ''}output: ${r.out.slice(-400)}` };
}

try {
	const dirty = [];
	writeFileSync(join(clone, 'src', 'refusal-probe-untracked.ts'), 'export const probe = 1;\n');
	dirty.push({ case: 'untracked file', ...refusedBy('dirty', /uncommitted or untracked/, cliGate()) });
	reset();
	writeFileSync(join(clone, 'package.json'), readFileSync(join(clone, 'package.json'), 'utf8') + '\n');
	dirty.push({ case: 'modified tracked file', ...refusedBy('dirty', /uncommitted or untracked/, cliGate()) });
	git(clone, 'add', 'package.json');
	dirty.push({ case: 'staged change', ...refusedBy('dirty', /uncommitted or untracked/, cliGate()) });
	reset();
	refusal('dirty-tree', dirty);

	const reduced = Object.keys(REDUCED_ENV).map((k) => ({ case: `${k}=''`, ...refusedBy('env', new RegExp(`^${k} is set`), cliGate({ [k]: '' })) }));
	reduced.push({ case: '--allow-stale-build', ...refusedBy('usage', /unknown argument --allow-stale-build/, cliGate({}, ['--allow-stale-build'])) });
	refusal('reduced-run', reduced);

	const config = join(clone, 'deploy', 'client', 'wrangler.toml'), original = readFileSync(config, 'utf8');
	const variants = {
		'DB removed': [original.replace(/\[\[d1_databases\]\][\s\S]*?remote = false\n/, ''), /binds no D1 database as DB/],
		'BUCKET removed': [original.replace(/\[\[r2_buckets\]\][\s\S]*?remote = false\n?/, ''), /binds no R2 bucket as BUCKET/],
		'ASSETS removed': [original.replace(/\[assets\][\s\S]*?binding = "ASSETS"\n/, ''), /binds no assets directory as ASSETS/],
		'DB remote': [original.replace(/(database_id = "[^"]*"\n)remote = false/, '$1remote = true'), /DB binding is not remote = false/],
		'account_id added': [original.replace(/^(name = .*)$/m, '$1\naccount_id = "00000000000000000000000000000000"'), /names an account_id/],
	};
	const bindings = [];
	for (const [name, [text, why]] of Object.entries(variants)) {
		if (text === original) { bindings.push({ case: name, status: 'FAIL', got: 'the variant did not change wrangler.toml' }); continue; }
		writeFileSync(config, text);
		git(clone, 'commit', '-q', '-am', `refusal test: ${name}`);
		bindings.push({ case: name, ...refusedBy('bindings', why, cliGate()) });
		reset();
	}
	refusal('missing-binding', bindings);
} finally {
	rmSync(clone, { recursive: true, force: true });
}

// --- runHostedGate with the real validators and written evidence ---------------------------------------------------

const stamp = { revision: SHA, dirty: false, exported: false, builtAt: '2026-01-01T00:00:00.000Z', bun: '1.4.2', buildId: `${SHA.slice(0, 12)}-hosted-gate-1`, target: 'cloudflare', profile: 'hosted-gate' };
/** The files a passing run writes into its evidence directory, as a real run shapes them. */
const validEvidence = () => ({
	'build.json': { sidecar: { schema: 'clearcase.hosted-build/1', stamp: { ...stamp }, artifact: `sha256:${'a'.repeat(64)}` }, version: { version: SHA } },
	'health.json': { ok: true, runtime: 'Cloudflare-Workers', build: { ...stamp }, gate: { runId: 'clearcase-test-double:hosted-gate/run', fixtureSha256: gateFixture().sha256 }, identityProvider: 'test-identity-double', probe: { ok: true, bindings: { DB: true, BUCKET: true, ASSETS: true }, probes: { d1: true, r2: true } } },
	'test-hosted.json': { schema: 'clearcase.hosted-test/1', revision: SHA, profile: 'hosted-gate', pass: true, legs: TEST_LEGS.map((name) => ({ name, status: 'PASS', asserted: [`${name} asserted`] })) },
	'drive.json': { ok: true, partial: false, results: ['browser', ...DRIVE_STEPS].map((id) => ({ id, status: 'PASS' })) },
	'inner.json': { ok: true, partial: false, revision: SHA, results: [...new Set([...LIFECYCLE, ...CHECKS.map((c) => c.id)])].map((id) => ({ id, status: 'PASS', ms: 1 })) },
});
async function gateWith(edit) {
	const root = mkdtempSync(join(scratch, 'run-'));
	const files = validEvidence();
	edit(files);
	const r = await runHostedGate({
		head: { sha: SHA, dirty: false }, env: {}, repo: REPO,
		pre: () => ({ ok: true, problems: [], facts: { node: { version: 'refusal-test' }, tools: { chromium: 'refusal-test' }, lock: null } }),
		refusals: async () => ({ ok: true }),
		async hosted({ evidence }) {
			for (const [f, doc] of Object.entries(files)) if (doc !== undefined) { mkdirSync(dirname(join(evidence, f)), { recursive: true }); writeFileSync(join(evidence, f), JSON.stringify(doc)); }
			const steps = [...files['inner.json']?.results ?? [], ...['offline', 'cleanup', 'evidence-kept'].map((id) => ({ id, status: 'PASS', ms: 1 }))];
			return { ok: true, steps, inner: files['inner.json'] };
		},
		reread: () => ({ head: { sha: SHA, dirty: false } }),
		evidenceRoot: join(root, 'evidence'), scratchRoot: join(root, 'scratch'),
	});
	return r;
}
const expectFail = async (name, step, edit) => {
	const r = await gateWith(edit);
	const ok = !r.pass && r.failed === step && r.lines.at(-1) === `GATE FAIL ${step} ${SHA}` && r.summary === null;
	return { case: name, status: ok ? 'PASS' : 'FAIL', got: ok ? r.lines.at(-1) : r.lines.slice(-4).join(' | ') };
};

const control = await gateWith(() => {});
report.control = { status: control.pass && control.summary?.evidence === true && gateSummaryProblem(control.summary, SHA) === null ? 'PASS' : 'FAIL', got: control.lines.at(-1) };
console.log(`${report.control.status} control (unchanged evidence: ${report.control.got})`);

refusal('stale-stamp', [
	await expectFail('stamp names the parent commit', 'build', (f) => { f['build.json'].sidecar.stamp.revision = PARENT; }),
	await expectFail('stamp names a 12-character prefix of HEAD', 'build', (f) => { f['build.json'].sidecar.stamp.revision = SHA.slice(0, 12); }),
	await expectFail('stamp built from a dirty tree', 'build', (f) => { f['build.json'].sidecar.stamp.dirty = true; }),
	await expectFail('_app/version.json names the parent', 'build', (f) => { f['build.json'].version.version = PARENT; }),
	await expectFail('the live server reports the parent\'s stamp', 'live-doctor', (f) => { f['health.json'].build.revision = PARENT; }),
	await expectFail('no build stamp at all', 'build', (f) => { f['build.json'] = undefined; }),
]);

const summaryCases = [
	await expectFail('test:hosted summary says pass false', 'test:hosted', (f) => { f['test-hosted.json'].pass = false; }),
	await expectFail('test:hosted wrote no summary', 'test:hosted', (f) => { f['test-hosted.json'] = undefined; }),
	await expectFail('test:hosted summary for the parent commit', 'test:hosted', (f) => { f['test-hosted.json'].revision = PARENT; }),
	await expectFail('test:hosted summary for a prefix of HEAD', 'test:hosted', (f) => { f['test-hosted.json'].revision = SHA.slice(0, 12); }),
	await expectFail('test:hosted summary lacks the import-boundary negative leg', 'test:hosted', (f) => { f['test-hosted.json'].legs = f['test-hosted.json'].legs.filter((l) => l.name !== 'import-boundary-negative'); }),
	await expectFail('drive summary says ok false', 'drive', (f) => { f['drive.json'].ok = false; }),
	await expectFail('drive summary lacks the wrong-client step', 'drive', (f) => { f['drive.json'].results = f['drive.json'].results.filter((r) => r.id !== 'wrong-client'); }),
	await expectFail('inner summary still partial', 'offline', (f) => { f['inner.json'].partial = true; }),
];
const valid = control.summary;
for (const [name, edit] of Object.entries({
	'gate summary with evidence false': (s) => { s.evidence = false; },
	'gate summary without an evidence field': (s) => { delete s.evidence; },
	'gate summary for a prefix of HEAD': (s) => { s.sha = SHA.slice(0, 12); },
	'gate summary for the parent commit': (s) => { s.sha = PARENT; },
	'gate summary with a skipped step': (s) => { s.skipped = ['drive']; },
	'gate summary missing a required step': (s) => { s.steps = s.steps.filter((x) => x.name !== 'test:hosted'); },
	'gate summary claiming a real identity provider': (s) => { s.boundaries = { ...s.boundaries, identity: { kind: 'real', what: 'Clerk' } }; },
})) {
	if (!valid) { summaryCases.push({ case: name, status: 'FAIL', got: 'no control summary' }); continue; }
	const doc = structuredClone(valid);
	edit(doc);
	const problem = gateSummaryProblem(doc, SHA);
	summaryCases.push({ case: name, status: problem ? 'PASS' : 'FAIL', got: problem ?? 'accepted' });
}
refusal('summary-not-evidence', summaryCases);

rmSync(scratch, { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
const ok = report.control.status === 'PASS' && report.refusals.length === 5 && report.refusals.every((r) => r.status === 'PASS');
console.log(`refusals: ${ok ? 'PASS' : 'FAIL'} at ${SHA}; ${OUT}`);
process.exit(ok ? 0 : 1);
