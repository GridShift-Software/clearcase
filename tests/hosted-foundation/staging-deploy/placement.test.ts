// Staging's London placement check (GRS-289): scripts/staging-placement.ts and the deploy smoke in scripts/deploy-staging.sh.
// Every id, SHA, origin and response here is SYNTHETIC, shaped like Wrangler's `deployments list --json` and
// `versions view --json`. The shell runs stub Wrangler (through a fake `node`) and curl, so a PASS proves the script's
// decisions, not anything about Cloudflare.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activeVersion, placementHeader, providerPlacement } from '../../../scripts/staging-placement.ts';

const repo = path.resolve(import.meta.dirname, '../../..');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const VERSION = '11111111-2222-4333-8444-555555555555';
const OLD = '66666666-7777-4888-9999-000000000000';
const BINDING_VALUE = 'SYNTHETIC-BINDING-VALUE-NOT-FOR-OUTPUT';

const deployments = (newest: unknown[] = [{ version_id: VERSION, percentage: 100 }]) => [
	{ id: 'd-old', source: 'wrangler', strategy: 'percentage', versions: [{ version_id: OLD, percentage: 100 }], created_on: '2026-01-01T10:00:00.000000Z' },
	{ id: 'd-new', source: 'wrangler', strategy: 'percentage', versions: newest, created_on: '2026-01-02T10:00:00.000000Z' },
];
const london = () => ({ mode: 'targeted', target: [{ id: 43, region: 'aws:eu-west-2', type: 'region' }] });
const version = (placement: unknown = london(), over: Record<string, unknown> = {}) => ({
	id: VERSION, number: 7, annotations: { 'workers/tag': SHA, 'workers/triggered_by': 'version_upload' },
	resources: {
		script: { etag: 'e', handlers: ['fetch'], placement_mode: 'targeted', placement },
		bindings: [{ type: 'plain_text', name: 'CLEARCASE_APP_ORIGIN', text: 'https://staging.example.test' }, { type: 'plain_text', name: 'SYNTHETIC_VAR', text: BINDING_VALUE }, { type: 'secret_text', name: 'SYNTHETIC_SECRET' }],
	},
	...over,
});
const withScript = (script: Record<string, unknown>) => { const v = version(); Object.assign(v.resources.script, script); return v; };

describe('the cf-placement header', () => {
	it('is observed only as exactly one remote-LHR, whatever the header-name case', () => {
		expect(placementHeader('HTTP/2 200\r\ncf-placement: remote-LHR\r\ncf-ray: 0abc-JNB\r\n')).toBe('observed: response execution observed (cf-placement remote-LHR)');
		expect(placementHeader('HTTP/2 200\nCF-Placement: remote-LHR\n')).toMatch(/^observed: /);
	});
	it('is absent with no cf-placement line, naming the colo that took the request', () => {
		expect(placementHeader('HTTP/2 200\r\ncf-ray: a52928d16c83d0e9-JNB\r\n')).toBe('absent: response execution not observed (no cf-placement header; Cloudflare took the request at JNB)');
		expect(placementHeader('HTTP/2 200\n')).toMatch(/^absent: .*an unnamed colo/);
	});
	it.each([['local', 'cf-placement: local-JNB'], ['another region', 'cf-placement: remote-FRA'], ['empty', 'cf-placement:'], ['twice', 'cf-placement: remote-LHR\ncf-placement: remote-LHR'], ['mixed', 'cf-placement: remote-LHR\ncf-placement: local-JNB']])('fails when it is %s', (_, line) => {
		expect(() => placementHeader(`HTTP/2 200\n${line}\n`)).toThrow(/cf-placement is .*not remote-LHR/);
	});
});

describe('the active version', () => {
	it('is the one version of the newest deployment at 100%, in either list order', () => {
		expect(activeVersion(deployments())).toBe(VERSION);
		expect(activeVersion(deployments().reverse())).toBe(VERSION);
	});
	it.each([
		['a split', deployments([{ version_id: VERSION, percentage: 50 }, { version_id: OLD, percentage: 50 }]), /serves 2 versions/],
		['under 100%', deployments([{ version_id: VERSION, percentage: 99 }]), /at 99%, not 100%/],
		['no version id', deployments([{ percentage: 100 }]), /no version_id/],
		['a tie for newest', [...deployments(), { ...deployments()[1], id: 'd-tie' }], /ambiguous/],
		['a bad created_on', [{ ...deployments()[1], created_on: 'soon' }], /created_on/],
		['an empty list', [], /empty/], ['an API envelope', { result: { deployments: deployments() } }, /not a list/], ['null', null, /not a list/],
	])('refuses %s', (_, list, error) => {
		expect(() => activeVersion(list)).toThrow(error);
	});
});

describe('the provider proof of London placement', () => {
	it('passes the active version at its SHA with one targeted aws:eu-west-2 region, and says it is configuration', () => {
		const out = providerPlacement(VERSION, SHA, deployments(), version());
		expect(out).toBe(`provider configuration verified: version ${VERSION} at 100%, tagged ${SHA}, targeted placement region aws:eu-west-2 (target 43)`);
		expect(out).not.toContain(BINDING_VALUE);
		const { placement_mode: _, ...script } = version().resources.script;
		expect(providerPlacement(VERSION, SHA, deployments(), { ...version(), resources: { ...version().resources, script } })).toMatch(/^provider configuration verified/);
	});
	it.each([
		['a stale active version', () => providerPlacement(VERSION, SHA, deployments([{ version_id: OLD, percentage: 100 }]), version()), /serves 6666.*, not 1111/],
		['a mixed deployment', () => providerPlacement(VERSION, SHA, deployments([{ version_id: VERSION, percentage: 90 }, { version_id: OLD, percentage: 10 }]), version()), /2 versions/],
		['another version record', () => providerPlacement(VERSION, SHA, deployments(), version(london(), { id: OLD })), /not 1111/],
		['another revision', () => providerPlacement(VERSION, OTHER_SHA, deployments(), version()), /tagged '0123.*', not fedc/],
		['an untagged version', () => providerPlacement(VERSION, SHA, deployments(), version(london(), { annotations: {} })), /tagged '', not/],
		['a short SHA', () => providerPlacement(VERSION, SHA.slice(0, 8), deployments(), version()), /not a full SHA/],
		['smart placement', () => providerPlacement(VERSION, SHA, deployments(), version({ mode: 'smart', target: london().target })), /mode is 'smart'/],
		['a disagreeing placement_mode', () => providerPlacement(VERSION, SHA, deployments(), withScript({ placement_mode: 'smart' })), /placement_mode is 'smart'/],
		['another region', () => providerPlacement(VERSION, SHA, deployments(), version({ mode: 'targeted', target: [{ id: 44, region: 'aws:eu-central-1', type: 'region' }] })), /targets region aws:eu-central-1, not region aws:eu-west-2/],
		['a host target', () => providerPlacement(VERSION, SHA, deployments(), version({ mode: 'targeted', target: [{ id: 43, region: 'aws:eu-west-2', type: 'host' }] })), /targets host/],
		['two targets', () => providerPlacement(VERSION, SHA, deployments(), version({ mode: 'targeted', target: [...london().target, ...london().target] })), /2 placement targets/],
		['no targets', () => providerPlacement(VERSION, SHA, deployments(), version({ mode: 'targeted', target: [] })), /0 placement targets/],
		['a target without an id', () => providerPlacement(VERSION, SHA, deployments(), version({ mode: 'targeted', target: [{ region: 'aws:eu-west-2', type: 'region' }] })), /not \{id, region, type\}/],
		['a target with a bad id', () => providerPlacement(VERSION, SHA, deployments(), version({ mode: 'targeted', target: [{ id: '43', region: 'aws:eu-west-2', type: 'region' }] })), /no valid id/],
		['an extra placement key', () => providerPlacement(VERSION, SHA, deployments(), version({ ...london(), hostname: 'db.example.test' })), /keys mode, target, hostname/],
		['no placement', () => providerPlacement(VERSION, SHA, deployments(), withScript({ placement: undefined })), /reports no placement/],
		['the source-config shape', () => providerPlacement(VERSION, SHA, deployments(), version({ region: 'aws:eu-west-2' })), /keys region, not mode and target/],
		['a malformed version', () => providerPlacement(VERSION, SHA, deployments(), null), /not 1111/],
		['a malformed deployments list', () => providerPlacement(VERSION, SHA, 'error: Authentication error', version()), /not a list/],
	])('refuses %s', (_, run, error) => {
		expect(run).toThrow(error);
	});
});

// The real scripts/deploy-staging.sh --verify, with `node` (so Wrangler) and `curl` replaced by stubs on PATH. Every
// Wrangler call is logged, so the test also proves --verify only reads.
const NODE_STUB = `#!/usr/bin/env bash
[[ $1 == -p ]] && { echo; exit 0; }
shift
n=$(( $(wc -l <"$FAKE/calls") + 1 ))
echo "$*" >>"$FAKE/calls"
(( n >= \${FAKE_FAIL_FROM:-99} )) && { echo 'synthetic Authentication error [code: 10000]' >&2; exit 1; }
case "$1 $2" in
'deployments list') cat "$FAKE/deployments.json" ;;
'versions view') cat "$FAKE/version.json" ;;
*) echo "unexpected wrangler $*" >&2; exit 9 ;;
esac
`;
const CURL_STUB = `#!/usr/bin/env bash
out='' hdr='' url=''
while (($#)); do case $1 in -o) out=$2; shift 2 ;; -D) hdr=$2; shift 2 ;; -w|-H) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
case \${url##*/} in health) code=200 ;; sign-in) code=200 ;; cases) code=401 ;; *) code=404 ;; esac
[[ -n $hdr ]] && cp "$FAKE/health.headers" "$hdr"
[[ \${url##*/} == health && -n $out ]] && cp "$FAKE/health.json" "$out"
printf %s "$code"
`;
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function verify(opts: { header?: string; version?: unknown; deployments?: unknown; failFrom?: number }) {
	const fake = mkdtempSync(path.join(tmpdir(), 'staging-placement-')), bin = path.join(fake, 'bin');
	dirs.push(fake);
	mkdirSync(bin);
	mkdirSync(path.join(fake, 'tmp'));
	for (const [name, body] of [['node', NODE_STUB], ['curl', CURL_STUB]]) { writeFileSync(path.join(bin, name), body); chmodSync(path.join(bin, name), 0o755); }
	writeFileSync(path.join(fake, 'calls'), '');
	writeFileSync(path.join(fake, 'deployments.json'), JSON.stringify(opts.deployments ?? deployments()));
	writeFileSync(path.join(fake, 'version.json'), JSON.stringify(opts.version ?? version()));
	writeFileSync(path.join(fake, 'health.json'), JSON.stringify({ ok: true, build: { revision: SHA, dirty: false, profile: 'production' } }));
	writeFileSync(path.join(fake, 'health.headers'), `HTTP/2 200\r\ncontent-type: application/json\r\n${opts.header ?? ''}cf-ray: 0123456789abcdef-JNB\r\n\r\n`);
	const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? fake, FAKE: fake, TMPDIR: path.join(fake, 'tmp') };
	if (opts.failFrom) env.FAKE_FAIL_FROM = String(opts.failFrom);
	const r = spawnSync('bash', [path.join(repo, 'scripts/deploy-staging.sh'), '--verify', SHA], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: readFileSync(path.join(fake, 'calls'), 'utf8').trim().split('\n').map((c) => c.split(' ').slice(0, 2).join(' ')),
		// placement_proof's directory holds the Wrangler responses (bindings included); it must be gone, pass or fail.
		tmpDirs: readdirSync(path.join(fake, 'tmp')).filter((f) => statSync(path.join(fake, 'tmp', f)).isDirectory()) };
}

describe('scripts/deploy-staging.sh --verify (stub Wrangler and curl)', () => {
	it('with no header, passes on the provider proof, says configuration is verified and execution not observed, and only reads', () => {
		const r = verify({});
		expect(r.stderr).toContain(`smoke: PASS /health 200 at ${SHA}, /sign-in 200, /cases 401; placement: provider configuration verified: version ${VERSION} at 100%, tagged ${SHA}, targeted placement region aws:eu-west-2 (target 43); response execution not observed (no cf-placement header; Cloudflare took the request at JNB)`);
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe(`${SHA} https://staging.example.test ${VERSION}`);
		expect(r.calls).toEqual(['deployments list', 'versions view', 'deployments list', 'versions view']);
		expect(r.stdout + r.stderr).not.toContain(BINDING_VALUE);
		expect(r.tmpDirs).toEqual([]);
	});
	it('with cf-placement remote-LHR, passes on the observation without asking for the proof', () => {
		const r = verify({ header: 'cf-placement: remote-LHR\r\n' });
		expect(r.stderr).toContain('; placement: response execution observed (cf-placement remote-LHR)');
		expect(r.status).toBe(0);
		expect(r.calls).toEqual(['deployments list', 'versions view']);
	});
	it('fails on a contradictory header even though the provider record is right', () => {
		const r = verify({ header: 'cf-placement: local-JNB\r\n' });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("FAIL: smoke: cf-placement is 'local-JNB', not remote-LHR");
		expect(r.stderr).not.toContain('PASS');
	});
	it('fails with no header when the active version targets another region', () => {
		const r = verify({ version: version({ mode: 'targeted', target: [{ id: 44, region: 'aws:eu-central-1', type: 'region' }] }) });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("FAIL: smoke: no cf-placement header, and Cloudflare's record does not prove London placement: version");
		expect(r.stderr).toContain('not region aws:eu-west-2');
		expect(r.tmpDirs).toEqual([]);
	});
	it('fails with no header when the version is tagged with another revision', () => {
		const r = verify({ version: version(london(), { annotations: { 'workers/tag': OTHER_SHA } }) });
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/does not prove London placement: .*tagged 'fedc.*', not 0123/);
	});
	it('fails when the live deployment is split, before any smoke', () => {
		const r = verify({ deployments: deployments([{ version_id: VERSION, percentage: 50 }, { version_id: OLD, percentage: 50 }]) });
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/FAIL: --verify: the newest deployment d-new serves 2 versions/);
	});
	it('fails with an actionable message when Wrangler cannot authorise the proof, and leaves no response behind', () => {
		const r = verify({ failFrom: 3 });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`does not prove London placement: Wrangler could not read the deployments or version ${VERSION}: sign in with wrangler login, or export CLOUDFLARE_API_TOKEN`);
		expect(r.tmpDirs).toEqual([]);
		const lost = verify({ failFrom: 1 });
		expect(lost.status).toBe(1);
		expect(lost.stderr).toMatch(/FAIL: --verify: .*not readable JSON \(Wrangler needs its login/);
	});
});
