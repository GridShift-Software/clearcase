import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { checkPrebuilt, checkTarget, digestDir, loadTargets, stage, STAGED, type Target } from '../../../deploy/probes/target.ts';

const CLIENTS = path.join(import.meta.dirname, '../../../deploy/probes/clients');
const targets = loadTargets(CLIENTS);
const a = targets.find((t) => t.client === 'client-a')!;
const b = targets.find((t) => t.client === 'client-b')!;
const config = (client: string, file: string) => readFileSync(path.join(CLIENTS, client, file), 'utf8');
const FORMATS = [['wrangler', 'wrangler.jsonc'], ['cf', 'cloudflare.config.ts']] as const;

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
			else parent[key] = op === 'null' ? null : typeof old === 'string' ? 7 : Array.isArray(old) ? {} : typeof old === 'object' && old !== null ? [] : 'x';
			return { label: `${op} ${at.join('.')}`, copy };
		}),
	);

// Reviewed with the config, never compared with a target: none of them names a client or the uploaded code.
const UNREAD = /^(compatibility_date|compatibility_flags|send_metrics|assets\.binding|d1_databases\.0\.migrations_dir|worker\.compatibilityDate|worker\.compatibilityFlags)(\.|$)/;

describe('same-account wrong-client identifiers', () => {
	for (const [format, file] of FORMATS) {
		test(`${format}: client B's D1 id in client A's config is refused, naming client B`, () => {
			const swapped = config('client-a', file).replace(a.d1.id, b.d1.id);
			expect(swapped).not.toBe(config('client-a', file));
			expect(a.accountId).toBe(b.accountId);
			const problems = checkTarget({ client: 'client-a', targets, format, text: swapped });
			expect(problems.some((p) => p.includes(b.d1.id) && p.includes('client-b'))).toBe(true);
		});

		test(`${format}: client B's R2 bucket in client A's config is refused, naming client B`, () => {
			const swapped = config('client-a', file).replaceAll(`"${a.r2.bucket}"`, `"${b.r2.bucket}"`);
			const problems = checkTarget({ client: 'client-a', targets, format, text: swapped });
			expect(problems.some((p) => p.includes(b.r2.bucket) && p.includes('client-b'))).toBe(true);
		});

		test(`${format}: client B's Worker name in client A's config is refused, naming client B`, () => {
			const swapped = config('client-a', file).replace(`"name": "${a.worker}"`, `"name": "${b.worker}"`);
			expect(swapped).not.toBe(config('client-a', file));
			const problems = checkTarget({ client: 'client-a', targets, format, text: swapped });
			expect(problems.some((p) => p.includes(b.worker) && p.includes('client-b'))).toBe(true);
		});

		test(`${format}: each client's reviewed config passes its own target check`, () => {
			expect(checkTarget({ client: 'client-a', targets, format, text: config('client-a', file) })).toEqual([]);
			expect(checkTarget({ client: 'client-b', targets, format, text: config('client-b', file) })).toEqual([]);
		});
	}
});

describe('the target check fails closed', () => {
	const wrangler = config('client-a', 'wrangler.jsonc');
	const cf = config('client-a', 'cloudflare.config.ts');
	const refuses = (format: 'wrangler' | 'cf', text: string, reason: RegExp) => {
		const problems = checkTarget({ client: 'client-a', targets, format, text });
		expect(problems.some((p) => reason.test(p)), problems.join('\n')).toBe(true);
	};

	test.each([
		['the D1 id', `, "database_id": "${'00000000-0000-4000-8000-00000000aaaa'}"`, /d1 id is missing/],
		['the account id', `  "account_id": "00000000000000000000000000000107",\n`, /account id is missing/],
		['the R2 bucket name', `, "bucket_name": "clearcase-client-a-files"`, /r2 bucket is missing/],
		['the secret names', `  "secrets": { "required": ["CLERK_SECRET_KEY"] },\n`, /secret names are missing/],
		['the client var', `  "vars": { "CLEARCASE_CLIENT_ID": "client-a" },\n`, /vars are missing/],
	])('wrangler: a config without %s', (_what, cut, reason) => {
		expect(wrangler).toContain(cut);
		refuses('wrangler', wrangler.replace(cut, ''), reason);
	});

	test.each([
		['a KV namespace', `  "kv_namespaces": [{ "binding": "KV", "id": "x" }],\n`, /config.kv_namespaces is not a key/],
		['a named environment', `  "env": { "staging": {} },\n`, /config.env is not a key/],
	])('wrangler: a config with %s', (_what, add, reason) => refuses('wrangler', wrangler.replace('  "send_metrics": false,\n', `  "send_metrics": false,\n${add}`), reason));
	test('wrangler: a D1 binding with a preview database', () => {
		const text = wrangler.replace('"migrations_dir": "migrations" }', `"migrations_dir": "migrations", "preview_database_id": "${b.d1.id}" }`);
		refuses('wrangler', text, /d1_databases\[0\]\.preview_database_id is not a key/);
		refuses('wrangler', text, /belongs to client-b/);
	});

	test('wrangler: a second D1 binding', () => refuses('wrangler', wrangler.replace('"migrations_dir": "migrations" }]', '"migrations_dir": "migrations" }, { "binding": "DB2", "database_name": "x-db", "database_id": "00000000-0000-4000-8000-000000000000" }]'), /binds 2 D1 databases/));
	test('wrangler: the client var naming another client', () => refuses('wrangler', wrangler.replace('"CLEARCASE_CLIENT_ID": "client-a"', '"CLEARCASE_CLIENT_ID": "client-b"'), /vars are/));
	test("wrangler: client B's identifier in a field the comparisons do not read", () => refuses('wrangler', wrangler.replace('"CLEARCASE_CLIENT_ID": "client-a"', `"CLEARCASE_CLIENT_ID": "client-a", "NOTE": "${b.d1.id}"`), /belongs to client-b/));
	test('wrangler: a config that is not JSON', () => refuses('wrangler', wrangler.replace('{', '{ /* block comment */'), /not JSON with whole-line comments/));

	test.each([
		['an import', `import { defineConfig } from "@cloudflare/config";\n`, 'prepend'],
		['a computed value', `"name": process.env.WORKER_NAME,`, '"name": "clearcase-client-a",'],
		['a function export', 'export default () => ({', 'export default {'],
	])('cf: a config with %s is code, not data', (_what, change, at) => refuses('cf', at === 'prepend' ? change + cf : cf.replace(at, change), /not data only/));
	test('cf: a KV binding', () => refuses('cf', cf.replace('"BUCKET":', '"KV": { "type": "kv", "id": "x" },\n      "BUCKET":'), /only d1, r2, secret and text bindings/));
	test('cf: a D1 binding without its id', () => refuses('cf', cf.replace(`, "id": "${a.d1.id}"`, ''), /d1 id is missing/));
	test('cf: no account id', () => refuses('cf', cf.replace('  "accountId": "00000000000000000000000000000107",\n', ''), /account id is missing/));
	test('an unknown client', () => expect(checkTarget({ client: 'client-c', targets, format: 'cf', text: cf })).toEqual(['no target manifest for client-c']));
});

describe('every field the check reads, deleted, nulled or retyped, is refused', () => {
	const MUTANT = path.join(import.meta.dirname, '../../../.local/hosting-probe/deployment', `mutant-${process.pid}`);
	afterAll(() => rmSync(MUTANT, { recursive: true, force: true }));
	const data = (text: string) => JSON.parse(text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n').replace(/^\s*export default /, '').replace(/;\s*$/, ''));

	for (const [format, file] of FORMATS) {
		test(`${format}: every mutant of client A's config outside the unread keys is refused`, () => {
			const accepted = mutants(data(config('client-a', file)))
				.filter(({ label }) => !UNREAD.test(label.split(' ')[1]!))
				.filter(({ copy }) => checkTarget({ client: 'client-a', targets, format, text: format === 'cf' ? `export default ${JSON.stringify(copy)};` : JSON.stringify(copy) }).length === 0)
				.map(({ label }) => label);
			expect(accepted).toEqual([]);
		});
	}

	test("every mutant of client A's target manifest is refused", () => {
		const target = JSON.parse(config('client-a', 'target.json'));
		const accepted = mutants(target)
			.filter(({ label }) => label !== 'delete secrets.0') // a client without secrets is a legitimate target; its configs must then name none
			.filter(({ copy }) => {
				const dir = MUTANT;
				rmSync(dir, { recursive: true, force: true });
				cpSync(CLIENTS, dir, { recursive: true });
				writeFileSync(path.join(dir, 'client-a', 'target.json'), JSON.stringify(copy));
				try {
					return checkTarget({ client: 'client-a', targets: loadTargets(dir), format: 'wrangler', text: config('client-a', 'wrangler.jsonc') }).length === 0;
				} catch {
					return false;
				}
			})
			.map(({ label }) => label);
		expect(accepted).toEqual([]);
	});

	for (const [format, file] of FORMATS)
		test(`${format}: a Worker entry outside the staged artifact is refused`, () => {
			const text = config('client-a', file);
			expect(text).toContain(STAGED.entry);
			const problems = checkTarget({ client: 'client-a', targets, format, text: text.replace(STAGED.entry, 'src/_worker.js') });
			expect(problems.some((p) => p.includes("not the staged artifact's")), problems.join('\n')).toBe(true);
		});

	test('wrangler: an assets directory outside the staged artifact is refused', () => {
		const text = config('client-a', 'wrangler.jsonc').replace(`"directory": "${STAGED.assets}"`, '"directory": "static"');
		const problems = checkTarget({ client: 'client-a', targets, format: 'wrangler', text });
		expect(problems.some((p) => p.includes('assets directory')), problems.join('\n')).toBe(true);
	});
});

describe("the Build Output of a credential-free cf build is checked again before a --prebuilt upload", () => {
	// cf deploy --prebuilt uploads the bindings in .cloudflare/output/v0, not those in cloudflare.config.ts. This is the
	// shape cf 1.0.0-beta.20's build wrote for client A's stage in the probe.
	const BOS = path.join(import.meta.dirname, '../../../.local/hosting-probe/deployment', `bos-${process.pid}`);
	afterAll(() => rmSync(BOS, { recursive: true, force: true }));
	const worker = (t: Target) => ({
		name: t.worker,
		compatibilityDate: '2026-10-12',
		compatibilityFlags: ['nodejs_als'],
		env: { DB: { type: 'd1', name: t.d1.name, id: t.d1.id }, BUCKET: { type: 'r2', name: t.r2.bucket }, CLERK_SECRET_KEY: { type: 'secret' }, CLEARCASE_CLIENT_ID: { type: 'text', value: t.client } },
		manifest: { type: 'complete', mainModule: '_worker.js', modules: { '_worker.js': { type: 'esm' }, '_worker.js.map': { type: 'sourcemap' } } },
	});
	const write = (name: string, config: object, workers = ['default'], top: object = { accountId: a.accountId, buildContext: { isPreview: false } }) => {
		const out = path.join(BOS, name, '.cloudflare/output/v0');
		for (const w of workers) {
			mkdirSync(path.join(out, 'workers', w), { recursive: true });
			writeFileSync(path.join(out, 'workers', w, 'worker.config.json'), JSON.stringify(config));
		}
		writeFileSync(path.join(out, 'config.json'), JSON.stringify(top));
		return path.join(BOS, name);
	};
	const refuses = (stage: string, reason: RegExp) => {
		const problems = checkPrebuilt({ client: 'client-a', stage, targets });
		expect(problems.some((p) => reason.test(p)), problems.join('\n')).toBe(true);
	};

	test("client A's Build Output passes", () => expect(checkPrebuilt({ client: 'client-a', stage: write('clean', worker(a)), targets })).toEqual([]));
	test("client B's D1 id in client A's Build Output is refused, naming client B", () =>
		refuses(write('swapped', { ...worker(a), env: { ...worker(a).env, DB: { type: 'd1', name: a.d1.name, id: b.d1.id } } }), new RegExp(`d1 id ${b.d1.id} belongs to client-b`)));
	test("client B's Worker name is refused", () => refuses(write('worker', { ...worker(a), name: b.worker }), /worker clearcase-client-b belongs to client-b/));
	test('a second Worker in the Build Output', () => refuses(write('two', worker(a), ['default', 'other']), /holds 2 Workers, not exactly one/));
	test('no Build Output', () => refuses(path.join(BOS, 'none'), /holds 0 Workers/));
	test('a module beside the staged entry', () =>
		refuses(write('module', { ...worker(a), manifest: { ...worker(a).manifest, modules: { ...worker(a).manifest.modules, 'extra.js': { type: 'esm' } } } }), /Worker entry/));
	test('every mutant of the Build Output outside the unread keys is refused', () => {
		const accepted = mutants({ accountId: a.accountId, buildContext: { isPreview: false }, worker: worker(a) })
			.filter(({ label }) => !UNREAD.test(label.split(' ')[1]!))
			.filter(({ copy }) => checkTarget({ client: 'client-a', targets, format: 'prebuilt', text: JSON.stringify(copy) }).length === 0)
			.map(({ label }) => label);
		expect(accepted).toEqual([]);
	});
	test('a preview build or another account', () => {
		refuses(write('preview', worker(a), ['default'], { accountId: a.accountId, buildContext: { isPreview: true } }), /buildContext/);
		refuses(write('account', worker(a), ['default'], { accountId: 'f'.repeat(32), buildContext: { isPreview: false } }), /account id/);
	});
});

describe('the trusted parent stages only a checked config and the reviewed artifact', () => {
	const SCRATCH = path.join(import.meta.dirname, '../../../.local/hosting-probe/deployment', `target-${process.pid}`);
	const artifact = path.join(SCRATCH, 'artifact');
	mkdirSync(path.join(artifact, '_app'), { recursive: true });
	writeFileSync(path.join(artifact, '_worker.js'), 'export default { fetch() { return new Response("synthetic"); } };\n');
	writeFileSync(path.join(artifact, '_app/version.json'), '{"version":"synthetic"}\n');
	const digest = digestDir(artifact);
	afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

	test('a checked config and the reviewed digest are staged with a record of what was staged', () => {
		const out = path.join(SCRATCH, 'stage-ok');
		expect(stage({ client: 'client-a', artifact, digest, out })).toEqual([]);
		expect(readFileSync(path.join(out, 'wrangler.jsonc'), 'utf8')).toBe(config('client-a', 'wrangler.jsonc'));
		expect(digestDir(path.join(out, 'artifact'))).toBe(digest);
		const record = JSON.parse(readFileSync(path.join(out, 'stage.json'), 'utf8'));
		expect(record).toMatchObject({ schema: 'clearcase.deploy-stage/1', client: 'client-a', artifact: digest });
		expect(Object.keys(record.files).sort()).toEqual(['cloudflare.config.ts', 'target.json', 'wrangler.jsonc']);
	});

	test('an artifact changed after review is refused and nothing is staged', () => {
		const out = path.join(SCRATCH, 'stage-changed');
		const changed = path.join(SCRATCH, 'changed');
		cpSync(artifact, changed, { recursive: true });
		writeFileSync(path.join(changed, '_worker.js'), 'export default { fetch() { return new Response("changed"); } };\n');
		expect(stage({ client: 'client-a', artifact: changed, digest, out })).toEqual([expect.stringMatching(/is sha256:[0-9a-f]{64}, not the reviewed sha256:/)]);
		expect(existsSync(out)).toBe(false);
	});

	test("client B's D1 id in client A's committed config is refused and nothing is staged", () => {
		const clients = path.join(SCRATCH, 'clients');
		cpSync(CLIENTS, clients, { recursive: true });
		const file = path.join(clients, 'client-a', 'cloudflare.config.ts');
		writeFileSync(file, readFileSync(file, 'utf8').replace(a.d1.id, b.d1.id));
		const out = path.join(SCRATCH, 'stage-swapped');
		expect(stage({ client: 'client-a', artifact, digest, out, clients })).toEqual([`cloudflare.config.ts: d1 id ${b.d1.id} belongs to client-b, not client-a`]);
		expect(existsSync(out)).toBe(false);
	});

	test('the CLI exits 0 for each reviewed client and 1 for a swapped config', () => {
		const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(CLIENTS, '../target.ts'), ...args], { encoding: 'utf8' });
		for (const client of ['client-a', 'client-b']) expect(cli('check', client)).toMatchObject({ status: 0, stdout: `TARGET PASS check ${client}\n` });
		const swapped = path.join(SCRATCH, 'swapped.jsonc');
		writeFileSync(swapped, config('client-a', 'wrangler.jsonc').replace(a.r2.bucket, b.r2.bucket));
		const r = cli('check', 'client-a', '--format', 'wrangler', '--config', swapped);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`refused: swapped.jsonc: r2 bucket ${b.r2.bucket} belongs to client-b, not client-a`);
		expect(cli('check').status).toBe(2);
	});
});
