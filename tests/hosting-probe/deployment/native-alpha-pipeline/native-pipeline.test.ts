// The checked pipeline's native profile, unit level: target parsing bound to the approved native scope, the strict
// native Wrangler comparison, the native stage and its prebuilt re-verification. Every target, config, artifact and
// stage is a synthetic fixture under .local/; a PASS here is structural only, never provider, EU, deploy or funding evidence.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { CF_NATIVE_GAP, NATIVE_STAGE_SCHEMA, NATIVE_STAGED, checkNativeWrangler, nativeOwners, parseNativeTarget, type NativeTarget } from '../../../../deploy/native-alpha/pipeline.ts';
import { checkNative, checkNativeStage, digestDir, loadNativeTargets, loadTargets, stageNative, STAGED } from '../../../../deploy/probes/target.ts';

const ROOT = path.join(import.meta.dirname, '../../../..');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const CLIENTS = path.join(FIXTURES, 'clients');
const ARTIFACT = path.join(FIXTURES, 'artifact');
const LEGACY_CLIENTS = path.join(ROOT, 'deploy/probes/clients');
const DIGEST = digestDir(ARTIFACT);
const SCRATCH = path.join(ROOT, '.local/hosting-probe/deployment', `native-unit-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const targets = loadNativeTargets(CLIENTS);
const a = targets.find((t) => t.client === 'client-a')!;
const b = targets.find((t) => t.client === 'client-b')!;
const wrangler = (client: string) => readFileSync(path.join(CLIENTS, client, 'wrangler.jsonc'), 'utf8');
const data = (text: string) => JSON.parse(text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n'));
let n = 0;
const scratch = (name: string) => path.join(SCRATCH, `${name}-${++n}`);
/** A copy of the native fixture clients directory, mutated by `edit`. */
const clientsCopy = (edit: (dir: string) => void = () => {}) => {
	const dir = scratch('clients');
	cpSync(CLIENTS, dir, { recursive: true });
	edit(dir);
	return dir;
};
const artifactCopy = (edit: (dir: string) => void = () => {}) => {
	const dir = scratch('artifact');
	cpSync(ARTIFACT, dir, { recursive: true });
	edit(dir);
	return dir;
};
const editJson = (file: string, edit: (v: Record<string, any>) => void) => {
	const v = JSON.parse(readFileSync(file, 'utf8'));
	edit(v);
	writeFileSync(file, JSON.stringify(v, null, 2));
};
const refusedWith = (problems: string[], reason: RegExp | string) => expect(problems.some((p) => (typeof reason === 'string' ? p.includes(reason) : reason.test(p))), problems.join('\n') || '(no problems)').toBe(true);
const check = (text: string, ts: NativeTarget[] = targets) => checkNative({ client: 'client-a', targets: ts, text });

type Path = (string | number)[];
const leaves = (v: unknown, at: Path = []): Path[] =>
	(at.length ? [at] : []).concat(v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => leaves(x, [...at, Array.isArray(v) ? Number(k) : k])) : []);
const mutants = (value: unknown) =>
	leaves(value).flatMap((at) =>
		(['delete', 'null', 'retype'] as const).map((op) => {
			const copy = structuredClone(value) as Record<string | number, unknown>;
			const parent = at.slice(0, -1).reduce<Record<string | number, unknown>>((o, k) => o[k] as Record<string | number, unknown>, copy);
			const key = at.at(-1)!;
			const old = parent[key];
			if (op === 'delete') Array.isArray(parent) ? parent.splice(key as number, 1) : delete parent[key];
			else parent[key] = op === 'null' ? null : typeof old === 'string' ? 7 : typeof old === 'boolean' ? 'false' : typeof old === 'number' ? String(old) : Array.isArray(old) ? {} : typeof old === 'object' && old !== null ? [] : 'x';
			return { label: `${op} ${at.join('.')}`, copy };
		}),
	);

describe('the native profile shares the legacy staged paths and keeps the legacy parser closed', () => {
	test('the native staged entry, assets and migrations are the legacy STAGED paths', () => {
		expect({ entry: NATIVE_STAGED.entry, assets: NATIVE_STAGED.assets, migrations: NATIVE_STAGED.migrations }).toEqual({ ...STAGED });
	});
	test('the legacy loader still refuses a native target (its /1 schema check is not widened)', () => {
		expect(() => loadTargets(CLIENTS)).toThrow(/schema is "clearcase\.deploy-target\.native\/1", not clearcase\.deploy-target\/1/);
	});
	test('the native loader refuses the legacy /1 clients', () => {
		expect(() => loadNativeTargets(LEGACY_CLIENTS)).toThrow(/not clearcase\.deploy-target\.native\/1/);
	});
	test("a legacy config under the native profile is refused (it binds no custom domain, workers.dev or EU)", () => {
		const legacy = readFileSync(path.join(LEGACY_CLIENTS, 'client-a', 'wrangler.jsonc'), 'utf8');
		const problems = check(legacy);
		refusedWith(problems, 'config.workers_dev is missing');
		refusedWith(problems, 'config.routes is missing');
	});
});

describe('the native Wrangler config is compared key by key with its native target', () => {
	for (const client of ['client-a', 'client-b'])
		test(`${client}'s native config passes`, () => expect(checkNative({ client, targets, text: wrangler(client) })).toEqual([]));

	test("every mutant of client A's native config is refused (the native profile has no unread keys)", () => {
		const accepted = mutants(data(wrangler('client-a')))
			.filter(({ copy }) => check(JSON.stringify(copy)).length === 0)
			.map(({ label }) => label);
		expect(accepted).toEqual([]);
	});

	test.each([
		['a KV namespace', '"kv_namespaces": [{ "binding": "KV", "id": "x" }]', /config\.kv_namespaces is not a key/],
		['a named environment', '"env": { "staging": {} }', /config\.env is not a key/],
		['a singular route', '"route": "a.sandbox.gridshift.co.za/*"', /config\.route is not a key/],
		['a service binding', '"services": [{ "binding": "S", "service": "x" }]', /config\.services is not a key/],
		['a build command (executable config)', '"build": { "command": "curl x | sh" }', /config\.build is not a key/],
		['a define (executable config)', '"define": { "X": "1" }', /config\.define is not a key/],
		['module rules', '"rules": [{ "type": "Text", "globs": ["**/*.txt"] }]', /config\.rules is not a key/],
		['no_bundle', '"no_bundle": true', /config\.no_bundle is not a key/],
		['an alias', '"alias": { "x": "./y" }', /config\.alias is not a key/],
		['keep_vars', '"keep_vars": true', /config\.keep_vars is not a key/],
		['a tail consumer', '"tail_consumers": [{ "service": "x" }]', /config\.tail_consumers is not a key/],
		['an unsafe block', '"unsafe": { "bindings": [] }', /config\.unsafe is not a key/],
		['placement', '"placement": { "mode": "smart" }', /config\.placement is not a key/],
		['observability', '"observability": { "enabled": true }', /config\.observability is not a key/],
		['a compliance region', '"compliance_region": "fedramp_high"', /config\.compliance_region is not a key/],
		['previews', '"previews": {}', /config\.previews is not a key/],
	])('a config with %s is refused', (_what, add, reason) => refusedWith(check(wrangler('client-a').replace('  "send_metrics": false,\n', `  "send_metrics": false,\n  ${add},\n`)), reason));

	const route = '{ "pattern": "a.sandbox.gridshift.co.za", "zone_id": "db7c322907320aba562d64015ee7d673", "custom_domain": true }';
	test.each([
		['a second route covering the zone', `${route}, { "pattern": "*.gridshift.co.za/*", "zone_id": "db7c322907320aba562d64015ee7d673" }`, /routes is .*not exactly client-a's one custom domain/],
		['a zone route instead of a custom domain', '{ "pattern": "a.sandbox.gridshift.co.za/*", "zone_id": "db7c322907320aba562d64015ee7d673" }', /custom_domain is missing/],
		['custom_domain false', route.replace('"custom_domain": true', '"custom_domain": false'), /custom_domain is false, not true/],
		['zone_name instead of zone_id', route.replace('"zone_id": "db7c322907320aba562d64015ee7d673"', '"zone_name": "gridshift.co.za"'), /zone_name is not a key/],
		['enabled on the custom domain', route.replace(' }', ', "enabled": true }'), /enabled is not a key/],
		['previews_enabled on the custom domain', route.replace(' }', ', "previews_enabled": false }'), /previews_enabled is not a key/],
		['a wildcard hostname', route.replace('"a.sandbox', '"*.sandbox'), /custom-domain hostname is "\*\.sandbox\.gridshift\.co\.za"/],
		['an upper-case hostname', route.replace('"a.sandbox', '"A.sandbox'), /custom-domain hostname is "A\.sandbox/],
		['a trailing dot', route.replace('co.za"', 'co.za."'), /custom-domain hostname is "a\.sandbox\.gridshift\.co\.za\."/],
		['another zone', route.replace('db7c322907320aba562d64015ee7d673', 'f'.repeat(32)), /zone_id is "f{32}"/],
		['no route at all', '', /routes is \[\], not exactly client-a's one custom domain/],
	])('%s is refused', (_what, routes, reason) => {
		const text = wrangler('client-a').replace(route, routes);
		expect(text).not.toBe(wrangler('client-a'));
		refusedWith(check(text), reason);
	});

	test.each([
		['a raised CPU limit', '"cpu_ms": 1000', '"cpu_ms": 300000', /limits\.cpu_ms is 300000, not 1000/],
		['a subrequest limit the target does not set', '"cpu_ms": 1000 }', '"cpu_ms": 1000, "subrequests": 50 }', /config\.limits\.subrequests is not a key/],
		['a D1 preview database', '"migrations_dir": "migrations" }', '"migrations_dir": "migrations", "preview_database_id": "00000000-0000-4000-8000-000000000001" }', /preview_database_id is not a key/],
		['a D1 migrations table', '"migrations_dir": "migrations" }', '"migrations_dir": "migrations", "migrations_table": "x" }', /migrations_table is not a key/],
		['a D1 jurisdiction field Wrangler does not define', '"migrations_dir": "migrations" }', '"migrations_dir": "migrations", "jurisdiction": "eu" }', /d1_databases\[0\]\.jurisdiction is not a key/],
		['remote D1 in local dev', '"migrations_dir": "migrations" }', '"migrations_dir": "migrations", "remote": true }', /d1_databases\[0\]\.remote is not a key/],
		['an R2 preview bucket', '"jurisdiction": "eu" }', '"jurisdiction": "eu", "preview_bucket_name": "x" }', /preview_bucket_name is not a key/],
		['an R2 binding with no jurisdiction', ', "jurisdiction": "eu" }', ' }', /r2_buckets\[0\]\.jurisdiction is missing/],
		['migrations outside the stage', '"migrations_dir": "migrations"', '"migrations_dir": "../client-b/migrations"', /the migrations directory is "\.\.\/client-b\/migrations"/],
		['an entry outside the staged artifact', '"main": "artifact/cloudflare/_worker.js"', '"main": "./artifact/cloudflare/../../src/_worker.js"', /the Worker entry is/],
		['an assets directory outside the staged artifact', '"directory": "artifact/cloudflare"', '"directory": "static"', /the assets directory is "static"/],
		['another assets binding', '"binding": "ASSETS"', '"binding": "FILES"', /the assets binding is "FILES"/],
		['another compatibility flag', '["nodejs_als"]', '["nodejs_compat"]', /compatibility_flags is \["nodejs_compat"\]/],
		['send_metrics on', '"send_metrics": false', '"send_metrics": true', /send_metrics is true, not false/],
		['a secret beside the target names', '["CLERK_SECRET_KEY"]', '["CLERK_SECRET_KEY", "EXTRA_KEY"]', /secret names are/],
		['a var beside the target vars', '"CLEARCASE_CLIENT_ID": "client-a" }', '"CLEARCASE_CLIENT_ID": "client-a", "DEBUG": "1" }', /vars are/],
		['a block comment', '{\n  "name"', '{ /* x */\n  "name"', /not JSON with whole-line comments/],
	])('%s is refused', (_what, from, to, reason) => {
		const text = wrangler('client-a').replace(from, to);
		expect(text).not.toBe(wrangler('client-a'));
		refusedWith(check(text), reason);
	});

	test.each([
		['Worker name', `"name": "${'cc-sbx-a-20261023'}"`, `"name": "${'cc-sbx-b-20261023'}"`, 'cc-sbx-b-20261023 belongs to client-b'],
		['D1 name', '"database_name": "cc-sbx-a-20261023-db"', '"database_name": "cc-sbx-b-20261023-db"', 'cc-sbx-b-20261023-db belongs to client-b'],
		['D1 id', '"database_id": "00000000-0000-4000-8000-0000000a0107"', '"database_id": "00000000-0000-4000-8000-0000000b0107"', '00000000-0000-4000-8000-0000000b0107 belongs to client-b'],
		['R2 bucket', '"bucket_name": "cc-sbx-a-20261023-files"', '"bucket_name": "cc-sbx-b-20261023-files"', 'cc-sbx-b-20261023-files belongs to client-b'],
		['hostname in a var, in other case', '"CLEARCASE_CLIENT_ID": "client-a" }', '"CLEARCASE_CLIENT_ID": "client-a", "NOTE": "B.SANDBOX.GRIDSHIFT.CO.ZA" }', 'B.SANDBOX.GRIDSHIFT.CO.ZA belongs to client-b'],
		['hostname as a key', '"CLEARCASE_CLIENT_ID": "client-a" }', '"CLEARCASE_CLIENT_ID": "client-a", "b.sandbox.gridshift.co.za": "x" }', 'b.sandbox.gridshift.co.za belongs to client-b'],
	])("client B's %s in client A's native config is refused, naming client B", (_what, from, to, reason) => {
		const text = wrangler('client-a').replace(from, to);
		expect(text).not.toBe(wrangler('client-a'));
		refusedWith(check(text), reason);
	});

	test("an approved native client's identifiers are foreign even when its target is not in the directory", () => {
		const onlyA = targets.filter((t) => t.client === 'client-a');
		expect(nativeOwners(onlyA).get('b.sandbox.gridshift.co.za')).toBe('client-b');
		refusedWith(check(wrangler('client-a').replace('"bucket_name": "cc-sbx-a-20261023-files"', '"bucket_name": "cc-sbx-b-20261023-files"'), onlyA), 'cc-sbx-b-20261023-files belongs to client-b');
	});

	test('a cf config, or a prebuilt cf Build Output, under the native profile is the measured capability gap', () => {
		expect(checkNative({ client: 'client-a', targets, format: 'cf', text: 'export default {};' })).toEqual([CF_NATIVE_GAP]);
		expect(checkNative({ client: 'client-a', targets, format: 'prebuilt', text: '{}' })).toEqual([CF_NATIVE_GAP]);
	});
	test('an unknown client', () => expect(checkNativeWrangler({ client: 'client-c', targets, text: wrangler('client-a') })).toEqual(['no native target for client-c']));
});

describe('the native target is the desired exact scoped target, bound to the approved native scope', () => {
	const fixture = () => JSON.parse(readFileSync(path.join(CLIENTS, 'client-a', 'target.json'), 'utf8'));
	const parse = (edit: (t: Record<string, any>) => void) => {
		const t = fixture();
		edit(t);
		return () => parseNativeTarget(t, 'target.json');
	};
	test('each fixture target parses', () => expect(parseNativeTarget(fixture(), 'target.json')).toMatchObject({ client: 'client-a', workersDev: false, previewUrls: false }));
	test('a draft target with a null D1 UUID is refused as a draft, not made executable', () => expect(parse((t) => (t.d1.id = null))).toThrow(/d1 id is null: this is a draft target, not an executable one/));
	test("every mutant of client A's native target is refused", () => {
		const accepted = mutants(fixture())
			.filter(({ label }) => label !== 'delete secrets.0' && label !== 'delete runtime.compatibilityFlags.0') // no secrets or no flags is a legitimate target; its config must then name none
			.filter(({ copy }) => {
				try {
					parseNativeTarget(copy, 'target.json');
					return true;
				} catch {
					return false;
				}
			})
			.map(({ label }) => label);
		expect(accepted).toEqual([]);
	});
	test.each([
		['an unapproved client', (t: any) => ((t.client = 'client-c'), (t.vars.CLEARCASE_CLIENT_ID = 'client-c')), /client "client-c" is not an approved native client/],
		['another account', (t: any) => (t.accountId = 'f'.repeat(32)), /accountId "f{32}" is not the approved native account/],
		['another zone', (t: any) => (t.zone.id = 'f'.repeat(32)), /zone .* is not exactly the approved zone/],
		["client B's Worker", (t: any) => (t.worker = 'cc-sbx-b-20261023'), /worker "cc-sbx-b-20261023" is not the approved cc-sbx-a-20261023/],
		['a wildcard hostname', (t: any) => (t.customDomain.hostname = '*.sandbox.gridshift.co.za'), /customDomain hostname .* is not the approved exact a\.sandbox\.gridshift\.co\.za/],
		['an upper-case hostname', (t: any) => (t.customDomain.hostname = 'A.sandbox.gridshift.co.za'), /customDomain hostname/],
		['a custom-domain ID (observed, not desired)', (t: any) => (t.customDomain.id = '0'.repeat(32)), /customDomain .* is not exactly \{ hostname, zoneId \}/],
		['workers.dev on', (t: any) => (t.workersDev = true), /workersDev is true, not false/],
		['Preview URLs on', (t: any) => (t.previewUrls = true), /previewUrls is true, not false/],
		['a public R2 bucket', (t: any) => (t.r2.publicAccess = true), /r2 publicAccess true is not false/],
		['a non-EU R2 bucket', (t: any) => (t.r2.jurisdiction = 'default'), /r2 jurisdiction "default" is not "eu"/],
		['a non-EU D1', (t: any) => (t.d1.jurisdiction = 'us'), /d1 jurisdiction "us" is not "eu"/],
		['a hosted-gate runtime profile', (t: any) => (t.runtime.profile = 'hosted-gate'), /runtime profile "hosted-gate" is not "production"/],
		['a zero CPU limit', (t: any) => (t.limits.cpu_ms = 0), /limits .* is not \{ cpu_ms/],
		['a secret that is also a var', (t: any) => (t.vars.CLERK_SECRET_KEY = 'x'), /"CLERK_SECRET_KEY" is both a secret name and a var/],
		['a version ID (observed, not desired)', (t: any) => (t.versionIds = []), /target\.json\.versionIds is not a key the native profile reads/],
	])('%s is refused', (_what, edit, reason) => expect(parse(edit)).toThrow(reason));

	test('two native targets that share an identifier are refused', () => {
		const dir = clientsCopy((d) => editJson(path.join(d, 'client-b', 'target.json'), (t) => (t.d1.id = a.d1.id)));
		expect(() => loadNativeTargets(dir)).toThrow(/is not|in both client-a's and client-b's native targets/);
	});
});

describe('the native stage binds the checked config, the artifact and the migrations by digest', () => {
	const stageOk = () => {
		const out = scratch('stage');
		expect(stageNative({ client: 'client-a', artifact: ARTIFACT, digest: DIGEST, out, clients: CLIENTS })).toEqual([]);
		return out;
	};
	test('a native stage records exactly what it checked, with every claim flag false', () => {
		const out = stageOk();
		const record = JSON.parse(readFileSync(path.join(out, 'stage.json'), 'utf8'));
		expect(record).toEqual({
			schema: NATIVE_STAGE_SCHEMA,
			profile: 'native',
			adapter: 'wrangler',
			client: 'client-a',
			files: { 'target.json': expect.stringMatching(/^sha256:[0-9a-f]{64}$/), 'wrangler.jsonc': expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
			artifact: DIGEST,
			migrations: a.runtime.migrationsSha256,
			runtime: { profile: 'production', sourceSha: a.runtime.sourceSha },
			desired: { accountId: a.accountId, worker: a.worker, zoneId: a.zone.id, hostname: 'a.sandbox.gridshift.co.za', d1Id: a.d1.id, r2Bucket: a.r2.bucket },
			policy: { workersDev: false, previewUrls: false, d1Jurisdiction: 'eu', r2Jurisdiction: 'eu', r2PublicAccess: false, remoteMigrations: 'not-applied-by-stage' },
			state: 'STAGED-UNVERIFIED',
			fundedAdmission: false,
			controlsProof: false,
			providerProof: false,
			deployed: false,
		});
		expect(digestDir(path.join(out, 'migrations'))).toBe(record.migrations);
		expect(checkNativeStage({ client: 'client-a', stage: out, clients: CLIENTS })).toEqual([]);
	});

	const refusedStage = (a2: { artifact?: string; digest?: string; clients?: string }, reason: RegExp | string) => {
		const out = scratch('stage-refused');
		refusedWith(stageNative({ client: 'client-a', artifact: a2.artifact ?? ARTIFACT, digest: a2.digest ?? DIGEST, out, clients: a2.clients ?? CLIENTS }), reason);
		expect(existsSync(out)).toBe(false);
	};
	test('a cf config in the native client directory is refused as the capability gap', () =>
		refusedStage({ clients: clientsCopy((d) => writeFileSync(path.join(d, 'client-a', 'cloudflare.config.ts'), 'export default {};\n')) }, 'native profile capability gap'));
	test('a stray file in the native client directory is refused', () => refusedStage({ clients: clientsCopy((d) => writeFileSync(path.join(d, 'client-a', '.env'), 'X=1\n')) }, /\.env is not part of a native client directory/));
	test('a target.json that is a symlink is refused', () =>
		refusedStage(
			{
				clients: clientsCopy((d) => {
					const f = path.join(d, 'client-a', 'target.json');
					cpSync(f, path.join(d, 'moved-target.json'));
					rmSync(f);
					symlinkSync(path.join(d, 'moved-target.json'), f);
				}),
			},
			/target\.json is not a regular file|moved-target\.json is not part of|is not a directory/,
		));
	test('a symlink in the artifact is refused', () => refusedStage({ artifact: artifactCopy((d) => symlinkSync('/etc/hostname', path.join(d, 'cloudflare/extra.txt'))) }, /extra\.txt is not a regular file/));
	test('a FIFO in the migrations is refused', () => {
		const clients = clientsCopy((d) => expect(spawnSync('mkfifo', [path.join(d, 'client-a/migrations/0002_fifo.sql')]).status).toBe(0));
		refusedStage({ clients }, /0002_fifo\.sql is not a regular file/);
	});
	test('a symlinked artifact root is refused', () => {
		const link = scratch('artifact-link');
		symlinkSync(ARTIFACT, link);
		refusedStage({ artifact: link }, /is a symlink, not a directory/);
	});
	test('swapped migrations are refused (they no longer match the target)', () =>
		refusedStage({ clients: clientsCopy((d) => writeFileSync(path.join(d, 'client-a/migrations/0001_synthetic.sql'), 'DROP TABLE everything;\n')) }, /the staged migrations are sha256:[0-9a-f]{64}, not the target's/));
	test("client B's migrations under client A are refused", () =>
		refusedStage({ clients: clientsCopy((d) => cpSync(path.join(d, 'client-b/migrations/0001_synthetic.sql'), path.join(d, 'client-a/migrations/0001_synthetic.sql'))) }, /the staged migrations are .* not the target's/));
	test('an artifact changed after review is refused', () =>
		refusedStage({ artifact: artifactCopy((d) => writeFileSync(path.join(d, 'cloudflare/_worker.js'), 'export default {};\n')) }, /the staged artifact is sha256:[0-9a-f]{64}, not the target's/));
	test('a --digest other than the target artifact identity is refused', () => refusedStage({ digest: `sha256:${'0'.repeat(64)}` }, /not the reviewed sha256:0{64}/));
	const retarget = (art: string) => clientsCopy((d) => editJson(path.join(d, 'client-a', 'target.json'), (t) => (t.runtime.artifactSha256 = digestDir(art))));
	test('an artifact whose version file names another source is refused, even when the target names its digest', () => {
		const art = artifactCopy((d) => writeFileSync(path.join(d, 'cloudflare/_app/version.json'), '{"version":"1111111111111111111111111111111111111111"}\n'));
		refusedStage({ artifact: art, digest: digestDir(art), clients: retarget(art) }, /_app\/version\.json names "1{40}", not the target's source/);
	});
	test('a hosted-gate artifact (test-double marker) is refused, even when the target names its digest', () => {
		const art = artifactCopy((d) => writeFileSync(path.join(d, 'cloudflare/_app/double.js'), 'export const m = "clearcase-test-double:hosted-gate";\n'));
		refusedStage({ artifact: art, digest: digestDir(art), clients: retarget(art) }, /holds the hosted-gate test-double marker/);
	});
	test("client B's D1 id in client A's committed native config is refused and nothing is staged", () =>
		refusedStage({ clients: clientsCopy((d) => writeFileSync(path.join(d, 'client-a/wrangler.jsonc'), wrangler('client-a').replace(a.d1.id, b.d1.id))) }, `d1 id ${b.d1.id} belongs to client-b, not client-a`));
	test('a draft (null D1 UUID) target is never staged', () =>
		refusedStage({ clients: clientsCopy((d) => editJson(path.join(d, 'client-a', 'target.json'), (t) => (t.d1.id = null))) }, /d1 id is null: this is a draft target/));
	test('the legacy clients directory under the native profile is refused', () => refusedStage({ clients: LEGACY_CLIENTS }, /not clearcase\.deploy-target\.native\/1/));

	describe('prebuilt re-verifies the whole stage just before the upload', () => {
		const refusedPrebuilt = (edit: (out: string) => void, reason: RegExp | string) => {
			const out = stageOk();
			edit(out);
			refusedWith(checkNativeStage({ client: 'client-a', stage: out, clients: CLIENTS }), reason);
		};
		test('a claim flag edited in stage.json is refused', () => refusedPrebuilt((o) => editJson(path.join(o, 'stage.json'), (r) => (r.fundedAdmission = true)), /stage\.json is not the record of these staged bytes/));
		test('a policy edited in stage.json is refused', () => refusedPrebuilt((o) => editJson(path.join(o, 'stage.json'), (r) => (r.policy.r2Jurisdiction = 'default')), /stage\.json is not the record/));
		test('a benign-looking edit to the staged config after staging is refused (its hash no longer matches)', () =>
			refusedPrebuilt((o) => writeFileSync(path.join(o, 'wrangler.jsonc'), `// edited after staging\n${readFileSync(path.join(o, 'wrangler.jsonc'), 'utf8')}`), /stage\.json is not the record/));
		test('a workers_dev flip in the staged config is refused', () => refusedPrebuilt((o) => writeFileSync(path.join(o, 'wrangler.jsonc'), wrangler('client-a').replace('"workers_dev": false', '"workers_dev": true')), 'workers_dev is true, not false'));
		test('staged migrations swapped after staging are refused', () => refusedPrebuilt((o) => writeFileSync(path.join(o, 'migrations/0002_late.sql'), 'DROP TABLE x;\n'), /the staged migrations are .* not the target's/));
		test('a staged artifact swapped after staging is refused', () => refusedPrebuilt((o) => writeFileSync(path.join(o, 'artifact/cloudflare/_worker.js'), 'export default {};\n'), /the staged artifact is .* not the target's/));
		test('a symlink added to the staged artifact is refused', () => refusedPrebuilt((o) => symlinkSync('/etc/hostname', path.join(o, 'artifact/cloudflare/x')), /not a regular file or directory/));
		test('a cf Build Output in a native stage is refused as the capability gap', () =>
			refusedPrebuilt((o) => (mkdirSync(path.join(o, '.cloudflare/output/v0'), { recursive: true }), writeFileSync(path.join(o, '.cloudflare/output/v0/config.json'), '{}')), 'native profile capability gap'));
		test('a cf config added to a native stage is refused', () => refusedPrebuilt((o) => writeFileSync(path.join(o, 'cloudflare.config.ts'), 'export default {};\n'), 'native profile capability gap'));
		test.each(['.env', '.dev.vars', 'wrangler.toml'])('a %s beside the staged config is refused', (f) => refusedPrebuilt((o) => writeFileSync(path.join(o, f), 'X=1\n'), `${f} is not part of a native stage`));
		test('a .wrangler directory is refused', () => refusedPrebuilt((o) => mkdirSync(path.join(o, '.wrangler')), '.wrangler is not part of a native stage'));
		test('a missing stage.json is refused', () => refusedPrebuilt((o) => rmSync(path.join(o, 'stage.json')), 'stage.json is missing from the stage'));
		test('a legacy stage record is refused', () => refusedPrebuilt((o) => editJson(path.join(o, 'stage.json'), (r) => (r.schema = 'clearcase.deploy-stage/1')), /not a clearcase\.deploy-stage\.native\/1 record/));
		test("client B's staged target in client A's stage is refused", () => refusedPrebuilt((o) => cpSync(path.join(CLIENTS, 'client-b/target.json'), path.join(o, 'target.json')), /client client-b is not client-a/));
		test('a symlinked stage root is refused', () => {
			const out = stageOk();
			const link = scratch('stage-link');
			symlinkSync(out, link);
			refusedWith(checkNativeStage({ client: 'client-a', stage: link, clients: CLIENTS }), /is a symlink, not a directory/);
		});
	});
});

describe('the native CLI', () => {
	const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'deploy/probes/target.ts'), ...args], { encoding: 'utf8', cwd: ROOT });
	test('an unknown profile and a native command without --clients are usage errors', () => {
		expect(cli('check', 'client-a', '--profile', 'legacy2').status).toBe(2);
		expect(cli('check', 'client-a', '--profile', 'native').status).toBe(2);
		expect(cli('stage', 'client-a', '--profile', 'native', '--clients', CLIENTS).status).toBe(2);
	});
	test('a native check of a client directory holding a cf config is refused', () => {
		const dir = clientsCopy((d) => writeFileSync(path.join(d, 'client-a', 'cloudflare.config.ts'), 'export default {};\n'));
		const r = cli('check', 'client-a', '--profile', 'native', '--clients', dir);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('native profile capability gap');
		expect(r.stdout).toBe('TARGET REFUSED check client-a profile=native\n');
	});
});
