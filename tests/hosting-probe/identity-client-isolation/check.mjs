import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { transcript, INSTANCES, HOLD, LIFECYCLE } from './transcript.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const INPUTS = ['tests/hosting-probe/identity-client-isolation', 'tests/hosting-probe/identity', 'deploy/probes/secrets.ts', 'deploy/probes/secrets-child.mjs', 'deploy/probes/secrets-env.mjs', 'deploy/probes/secrets-fd.mjs', 'deploy/probes/scan.ts'];
export const SCHEMA = 'clearcase.client-isolation/1';
export function git(args, cwd = ROOT) {
	const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (r.status !== 0) throw new Error('Git input inspection failed');
	return r.stdout.trim();
}
export function digest(rev, cwd = ROOT) {
	return `sha256:${createHash('sha256').update(git(['ls-tree', '-r', '--full-tree', rev, '--', ...INPUTS], cwd)).digest('hex')}`;
}
export const pins = JSON.parse(readFileSync(path.join(ROOT, 'tests/hosting-probe/identity/package.json'), 'utf8'));
export const ENVIRONMENT = {
	bindings: 'local D1 and R2; separate a/client, a/staff, c/client, c/staff stores',
	build: pins.packageManager, runner: 'Node >=24', runtime: pins.devDependencies.workerd,
	wrangler: pins.devDependencies.wrangler, clerk: pins.devDependencies['@clerk/backend'],
	AUTH_MFA_REQUIRED: 'false', remote: false, jwtKeys: false,
	WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', WRANGLER_HIDE_BANNER: 'true',
	CLOUDFLARE_CF_FETCH_ENABLED: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
};
export function expectedResults() {
	return transcript().map((r) => ({ ...r, observed: { status: r.status, denial: r.denial, marker: Boolean(r.marker), leaked: false }, pass: true }));
}
// Strict top-level and nested structure: extra or missing observations cannot silently become evidence.
export function problems(s, { head, digestAt = digest } = {}) {
	const errors = [];
	const eq = (name, actual, expected) => { if (!isDeepStrictEqual(actual, expected)) errors.push(name); };
	const keys = ['schema', 'sourceSha', 'inputs', 'treeClean', 'mode', 'environment', 'instances', 'served', 'results', 'lifecycle', 'storesUnchanged', 'cleanup', 'scan', 'hold', 'evidence'];
	if (!s || typeof s !== 'object' || Array.isArray(s)) return ['summary is not an object'];
	eq('summary fields', Object.keys(s).sort(), keys.sort());
	eq('schema', s.schema, SCHEMA);
	if (!/^[a-f0-9]{40}$/.test(s.sourceSha ?? '') || s.sourceSha !== head) errors.push('sourceSha must be exact HEAD');
	try { eq('inputs', s.inputs, { paths: INPUTS, digest: digestAt(head) }); } catch { errors.push('unreadable inputs'); }
	eq('treeClean', s.treeClean, true);
	eq('mode', s.mode, 'live-clerk-development');
	eq('environment', s.environment, ENVIRONMENT);
	eq('instances', s.instances, INSTANCES);
	eq('served', s.served, { a: head, c: head });
	eq('results', s.results, expectedResults());
	eq('lifecycle', s.lifecycle, LIFECYCLE.map((assertion) => ({ assertion, pass: true })));
	eq('storesUnchanged', s.storesUnchanged, { a: true, c: true });
	// Four users: two clients and one staff operator per world. Each client signs in at both origins.
	eq('cleanup', s.cleanup, { usersCreated: 4, usersDeleted: 4, invitationsCreated: 4, invitationsDeleted: 4, sessionsCreated: 6, sessionsEnded: 6, remaining: 0 });
	if (!s.scan || !Number.isSafeInteger(s.scan.files) || s.scan.files < 1) errors.push('scan files');
	eq('scan', s.scan, { files: s.scan?.files, hits: 0 });
	eq('hold', s.hold, HOLD);
	eq('evidence', s.evidence, true);
	return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length !== 3) throw new Error('usage: node check.mjs SUMMARY');
		const head = git(['rev-parse', 'HEAD']);
		const errors = problems(JSON.parse(readFileSync(process.argv[2], 'utf8')), { head });
		if (git(['status', '--porcelain'])) errors.push('working tree dirty');
		console.log(`ISOLATION CHECK ${errors.length ? 'FAIL' : 'PASS'} ${head}${errors.length ? ': ' + errors.join(', ') : ''}`);
		process.exitCode = errors.length ? 1 : 0;
	} catch { console.error('ISOLATION CHECK FAIL: unreadable input or invalid invocation'); process.exitCode = 2; }
}
