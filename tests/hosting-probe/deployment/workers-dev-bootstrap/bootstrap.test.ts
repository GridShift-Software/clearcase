import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	checkWorkersDevBootstrapInvocation, planWorkersDevBootstrap, prepareWorkersDevBootstrap, readWorkersDevBootstrap,
	type BootstrapSettings,
} from '../../../../deploy/native-alpha/workers-dev-bootstrap.ts';
import { digestDir } from '../../../../deploy/probes/target.ts';
import { HOSTED_GATE_MARKER, NATIVE_ADAPTER_HEADERS } from '../../../../deploy/native-alpha/pipeline.ts';

// All artifacts and markers are synthetic; these checks are not provider/runtime/deployment evidence.
const SOURCE = 'a'.repeat(40);
const STAMP = { revision: SOURCE, dirty: false, exported: false, builtAt: '2026-10-25T06:40:03.000Z', bun: '1.4.2', buildId: 'synthetic-bootstrap', target: 'cloudflare', profile: 'production' };
const worker = (stamp: unknown = STAMP) => `const embedded = ${JSON.stringify(JSON.stringify(stamp))};
const forward = (name) => import(name);
const kit_manifest = (() => { return { app_dir: "_app", app_path: "_app", assets: new Set(["robots.txt"]), client: { start: "_app/immutable/start.js", app: "_app/immutable/app.js", imports: ["_app/immutable/chunk.js"], stylesheets: ["_app/immutable/site.css"], fonts: [] } }; })();
const server = create_server(kit_manifest);
export default { async fetch() { await server.respond(); await import("node:async_hooks"); await forward("node:crypto"); return new Response(embedded); } };\n`;
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), 'cc-bootstrap-'));
	roots.push(root);
	const artifact = path.join(root, 'source-artifact'), out = path.join(root, 'stage');
	const put = (rel: string, bytes: string) => {
		mkdirSync(path.dirname(path.join(artifact, rel)), { recursive: true });
		writeFileSync(path.join(artifact, rel), bytes);
	};
	put('cloudflare/_worker.js', worker());
	put('public/_app/version.json', JSON.stringify({ version: SOURCE }));
	put('public/robots.txt', 'User-agent: *\nDisallow:\n');
	put('public/_app/immutable/start.js', 'export function start() {}\n');
	put('public/_app/immutable/app.js', 'import "./chunk.js";\n');
	put('public/_app/immutable/chunk.js', 'export const loaded = true;\n');
	put('public/_app/immutable/site.css', 'body { color: black; }\n');
	put('public/_headers', NATIVE_ADAPTER_HEADERS);
	const pins = (): BootstrapSettings => ({
		pins: { source: SOURCE, artifact: digestDir(artifact), entry: sha(readFileSync(path.join(artifact, 'cloudflare/_worker.js'))) },
		compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
	});
	const settings = pins();
	return { root, artifact, out, put, pins, settings, prepare: () => prepareWorkersDevBootstrap({ artifact, out, settings }) };
}
const valid = (): BootstrapSettings => ({ pins: { source: SOURCE, artifact: `sha256:${'b'.repeat(64)}`, entry: `sha256:${'c'.repeat(64)}` }, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'] });
const cfg = (text: string): Record<string, any> => JSON.parse(text);

describe('separate workers.dev bootstrap planner', () => {
	it('uses provider-enforced Workers Free CPU limits without a paid-plan override', () => {
		for (const target of planWorkersDevBootstrap(valid()).targets) expect(cfg(target.configText)).not.toHaveProperty('limits');
	});
	it('fixes all three names, the approved account and isolated real stores; staff gets no client authority', () => {
		const input = valid(), plan = planWorkersDevBootstrap(input);
		expect(plan).toEqual(planWorkersDevBootstrap(input));
		expect(plan.schema).toBe('clearcase.workers-dev-bootstrap/1');
		expect(Object.isFrozen(plan.targets[0])).toBe(true);
		const configs = plan.targets.map((t) => cfg(t.configText));
		expect(configs.map((c) => c.name)).toEqual(['cc-sbx-a-20261023', 'cc-sbx-b-20261023', 'cc-sbx-staff-20261023']);
		for (const c of configs) {
			expect(c.account_id).toBe('fb4c31b91c5d89b7a54afbdc34823170');
			expect(c).toMatchObject({ main: 'artifact/cloudflare/_worker.js', no_bundle: true, find_additional_modules: false, minify: false, compatibility_flags: ['nodejs_compat'], workers_dev: true, preview_urls: false, routes: [], assets: { directory: 'artifact/public', binding: 'ASSETS' } });
			expect(c).not.toHaveProperty('secrets');
		}
		expect(configs[0]!.d1_databases).toEqual([{ binding: 'DB', database_name: 'cc-sbx-a-20261023-db', database_id: 'cd257736-7bf3-49f6-8544-ac58c2207802' }]);
		expect(configs[1]!.d1_databases).toEqual([{ binding: 'DB', database_name: 'cc-sbx-b-20261025-r1-db', database_id: '7c340891-9fcc-4398-8128-68abe726f130' }]);
		expect(configs[0]!.r2_buckets).toEqual([{ binding: 'BUCKET', bucket_name: 'cc-sbx-a-20261023-files', jurisdiction: 'eu' }]);
		expect(configs[1]!.r2_buckets).toEqual([{ binding: 'BUCKET', bucket_name: 'cc-sbx-b-20261023-files', jurisdiction: 'eu' }]);
		expect(configs[0]!.vars).toEqual({ CLEARCASE_INSTANCE_ROLE: 'client', CLEARCASE_CLIENT_ID: 'client-a' });
		expect(configs[1]!.vars).toEqual({ CLEARCASE_INSTANCE_ROLE: 'client', CLEARCASE_CLIENT_ID: 'client-b' });
		expect(configs[2]!.vars).toEqual({ CLEARCASE_INSTANCE_ROLE: 'staff', CLEARCASE_CLIENT_ID: '' });
		expect(configs[2]).not.toHaveProperty('d1_databases');
		expect(configs[2]).not.toHaveProperty('r2_buckets');
		expect(plan.targets[2]).toMatchObject({ clientId: null, stores: null, readiness: 'unconfigured-portal-shell' });
		for (const t of plan.targets.slice(0, 2)) expect(t.stores).toEqual({ d1Jurisdiction: 'eu', r2Jurisdiction: 'eu', r2Public: false, r2DevUrl: false });
		expect(JSON.stringify(plan)).not.toMatch(/observedUrl|versionId|https:\/\//);
		input.pins.source = 'd'.repeat(40);
		expect(plan.settings.pins.source).toBe(SOURCE);
	});
	it.each(['role', 'client', 'worker', 'accountId', 'vars', 'd1', 'r2', 'config', 'rawConfig', 'argv', 'secrets'])( 'refuses caller-supplied %s', (key) => {
		expect(() => planWorkersDevBootstrap({ ...valid(), [key]: {} })).toThrow(/exactly/);
	});
	it.each([undefined, null, {}, { pins: {} }])('fails closed on missing settings %j', (input) => {
		expect(() => planWorkersDevBootstrap(input)).toThrow();
	});
	it.each(['source', 'artifact', 'entry'] as const)('requires the external %s pin', (key) => {
		for (const bad of [null, '', 'latest', 'ABC', 123]) {
			const input = valid();
			expect(() => planWorkersDevBootstrap({ ...input, pins: { ...input.pins, [key]: bad } })).toThrow();
		}
		const input = valid();
		delete (input.pins as Partial<BootstrapSettings['pins']>)[key];
		expect(() => planWorkersDevBootstrap(input)).toThrow();
	});
	it('refuses pin extensions and profile changes', () => {
		const input = valid();
		expect(() => planWorkersDevBootstrap({ ...input, pins: { ...input.pins, role: 'staff' } })).toThrow();
		expect(() => planWorkersDevBootstrap({ ...input, profile: 'hosted-gate' })).toThrow();
	});
	it.each([[], ['nodejs_als'], ['nodejs_compat', 'nodejs_als'], ['nodejs_compat', 'nodejs_compat'], null, 'nodejs_compat'])('requires the parent-selected exact compatibility flag %j', (flags) => {
		expect(() => planWorkersDevBootstrap({ ...valid(), compatibilityFlags: flags })).toThrow(/nodejs_compat/);
	});
	it.each(['2026-02-30', 'tomorrow', '', '2026-10-23T00:00:00Z'])('refuses invalid compatibility date %s', (date) => {
		expect(() => planWorkersDevBootstrap({ ...valid(), compatibilityDate: date })).toThrow(/compatibilityDate/);
	});
});

describe('file-checking owner and bounded upload guard', () => {
	it('emits canonical configs/manifest, hashes every upload byte and shares exactly one unchanged artifact', () => {
		const f = fixture(), checked = f.prepare();
		expect(readdirSync(f.out).sort()).toEqual(['artifact', 'bootstrap.json', 'client-a.wrangler.json', 'client-b.wrangler.json', 'staff.wrangler.json']);
		expect(digestDir(f.artifact)).toBe(f.settings.pins.artifact);
		expect(digestDir(path.join(f.out, 'artifact'))).toBe(f.settings.pins.artifact);
		expect(checked.manifestSha256).toBe(sha(readFileSync(path.join(f.out, 'bootstrap.json'))));
		expect(checked.manifest).toMatchObject({ artifactSha256: f.settings.pins.artifact, deployed: false, providerProof: false, stamp: STAMP });
		const upload = checked.manifest.upload;
		expect(upload).not.toHaveProperty('invocation');
		expect(upload.entry.sha256).toBe(f.settings.pins.entry);
		expect(upload.dynamicHostImports.map((x) => x.specifier)).toEqual(['node:async_hooks', 'node:crypto']);
		expect(upload.assets.files.map((x) => x.path)).toEqual(['artifact/public/_app/immutable/app.js', 'artifact/public/_app/immutable/chunk.js', 'artifact/public/_app/immutable/site.css', 'artifact/public/_app/immutable/start.js', 'artifact/public/_app/version.json', 'artifact/public/robots.txt']);
		expect(upload.assets.headers?.path).toBe('artifact/public/_headers');
		for (const file of upload.files) {
			const bytes = readFileSync(path.join(f.out, file.path));
			expect(file.sha256).toBe(sha(bytes));
			expect(file.bytes).toBe(bytes.length);
		}
		for (const t of checked.manifest.targets) {
			expect(sha(t.configText)).toBe(t.configSha256);
			expect(readFileSync(path.join(f.out, t.configFile), 'utf8')).toBe(t.configText);
			expect(t.argv).toEqual(['wrangler', 'deploy', '--config', `${t.slot}.wrangler.json`]);
			expect(checkWorkersDevBootstrapInvocation({ stage: f.out, settings: f.settings, cwd: f.out, slot: t.slot, argv: t.argv })).toEqual(checked);
		}
		expect(readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toEqual(checked);
	});
	it.each(['--name', '--env', '--route', '--var', '--define', '--compatibility-flag', '--no-bundle', '--minify', '--config', '--outdir', '--dry-run', '--keep-vars'])('rejects extra upload flag %s', (flag) => {
		const f = fixture(), checked = f.prepare(), t = checked.manifest.targets[0]!;
		expect(() => checkWorkersDevBootstrapInvocation({ stage: f.out, settings: f.settings, cwd: f.out, slot: t.slot, argv: [...t.argv, flag, 'override'] })).toThrow(/argv/);
	});
	it('rejects foreign config argv, unknown slot, wrong cwd and invocation keys', () => {
		const f = fixture(), checked = f.prepare();
		const args = { stage: f.out, settings: f.settings, cwd: f.out, slot: 'client-a' as const, argv: checked.manifest.targets[0]!.argv };
		expect(() => checkWorkersDevBootstrapInvocation({ ...args, argv: checked.manifest.targets[1]!.argv })).toThrow(/argv/);
		expect(() => checkWorkersDevBootstrapInvocation({ ...args, slot: 'unknown' as 'client-a' })).toThrow(/slot/);
		expect(() => checkWorkersDevBootstrapInvocation({ ...args, cwd: f.root })).toThrow(/cwd/);
		expect(() => checkWorkersDevBootstrapInvocation({ ...args, env: {} } as typeof args)).toThrow(/exactly/);
	});
	it.each([
		['client-a', 'd1_databases', [{ binding: 'DB', database_name: 'cc-sbx-b-20261025-r1-db', database_id: '7c340891-9fcc-4398-8128-68abe726f130' }]],
		['client-b', 'r2_buckets', [{ binding: 'BUCKET', bucket_name: 'cc-sbx-a-20261023-files', jurisdiction: 'eu' }]],
		['staff', 'd1_databases', [{ binding: 'DB', database_id: 'cd257736-7bf3-49f6-8544-ac58c2207802' }]],
		['staff', 'r2_buckets', [{ binding: 'BUCKET', bucket_name: 'cc-sbx-a-20261023-files' }]],
		['client-a', 'account_id', '0'.repeat(32)], ['staff', 'name', 'provider-assigned-id'],
		['client-a', 'workers_dev', false], ['client-b', 'preview_urls', true],
		['staff', 'routes', [{ pattern: 'staff.example.test', custom_domain: true }]],
		['client-a', 'no_bundle', false], ['client-a', 'find_additional_modules', true], ['client-a', 'minify', true],
		['client-a', 'assets', { directory: 'artifact', binding: 'ASSETS' }],
		['client-a', 'vars', { CLEARCASE_INSTANCE_ROLE: 'staff', CLEARCASE_CLIENT_ID: 'client-b' }],
		['client-a', 'limits', { cpu_ms: 50 }], ['client-a', 'services', [{ binding: 'OTHER' }]],
		['client-a', 'd1_databases', [{ binding: 'DB', database_name: 'cc-sbx-a-20261023-db', database_id: 'cd257736-7bf3-49f6-8544-ac58c2207802', remote: true }]],
	])('refuses %s %s config mutation even with a rewritten manifest', (slot, key, value) => {
		const f = fixture(), checked = f.prepare();
		const target = checked.manifest.targets.find((t) => t.slot === slot)!;
		const config = cfg(target.configText);
		config[key] = value;
		const text = `${JSON.stringify(config, null, 2)}\n`;
		writeFileSync(path.join(f.out, target.configFile), text);
		const manifest = JSON.parse(checked.manifestText);
		const changed = manifest.targets.find((t: { slot: string }) => t.slot === slot);
		changed.configText = text; changed.configSha256 = sha(text);
		writeFileSync(path.join(f.out, 'bootstrap.json'), `${JSON.stringify(manifest, null, 2)}\n`);
		expect(() => readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toThrow(/exact bootstrap profile/);
	});
	it.each(['.env', '.dev.vars', 'wrangler.jsonc', 'migrations/0001.sql', 'unexpected/empty/.keep'])('refuses unexpected stage file %s', (name) => {
		const f = fixture(); f.prepare();
		mkdirSync(path.dirname(path.join(f.out, name)), { recursive: true });
		writeFileSync(path.join(f.out, name), 'synthetic');
		expect(() => readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toThrow(/unexpected/);
	});
	it('refuses unexpected empty directories and manifest mutation', () => {
		const f = fixture(); f.prepare();
		mkdirSync(path.join(f.out, 'artifact/empty'));
		expect(() => readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toThrow(/external artifact pin/);
		rmSync(path.join(f.out, 'artifact/empty'), { recursive: true });
		mkdirSync(path.join(f.out, 'empty'));
		expect(() => readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toThrow(/unexpected/);
		rmSync(path.join(f.out, 'empty'), { recursive: true });
		writeFileSync(path.join(f.out, 'bootstrap.json'), '{}');
		expect(() => readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toThrow(/bootstrap.json/);
	});
	it.each(['artifact/cloudflare/_worker.js', 'artifact/public/_app/immutable/site.css', 'artifact/public/_app/version.json', 'artifact/public/_headers'])('refuses changed uploaded bytes at %s', (file) => {
		const f = fixture(); f.prepare();
		writeFileSync(path.join(f.out, file), 'changed bytes');
		expect(() => readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toThrow();
	});
	it('requires external pins rather than trusting a manifest or a source-only pin', () => {
		const f = fixture(); f.prepare();
		for (const key of ['source', 'artifact', 'entry'] as const) {
			const settings = structuredClone(f.settings);
			settings.pins[key] = key === 'source' ? 'b'.repeat(40) : `sha256:${'f'.repeat(64)}`;
			expect(() => readWorkersDevBootstrap({ stage: f.out, settings })).toThrow();
		}
		expect(() => readWorkersDevBootstrap({ stage: f.out, settings: {} })).toThrow();
	});
	it('never overwrites an existing out or copies into its own source tree', () => {
		const f = fixture(); f.prepare();
		expect(() => f.prepare()).toThrow(/must not exist/);
		expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: path.join(f.artifact, 'out'), settings: f.settings })).toThrow(/inside/);
	});
	it('refuses symlinked roots and hard-linked or symlinked stage files', () => {
		const f = fixture(); f.prepare();
		const alias = path.join(f.root, 'alias'); symlinkSync(f.out, alias);
		expect(() => readWorkersDevBootstrap({ stage: alias, settings: f.settings })).toThrow(/symlink/);
		const config = path.join(f.out, 'staff.wrangler.json');
		linkSync(config, path.join(f.root, 'hard-link'));
		expect(() => readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toThrow(/hard link/);
		rmSync(path.join(f.root, 'hard-link')); rmSync(config); symlinkSync(path.join(f.out, 'client-a.wrangler.json'), config);
		expect(() => readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toThrow(/symlink/);
	});
});

describe('production identity and existing closed-artifact checks', () => {
	it.each([
		['dirty', true], ['exported', true], ['profile', 'hosted-gate'], ['revision', 'b'.repeat(40)],
		['target', 'node'], ['bun', 'wrong'], ['builtAt', 'bad'], ['buildId', ''],
	])('refuses an invalid embedded %s marker even when byte pins match', (key, value) => {
		const f = fixture(); f.put('cloudflare/_worker.js', worker({ ...STAMP, [key]: value }));
		expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings: f.pins() })).toThrow();
		expect(() => readFileSync(path.join(f.out, 'bootstrap.json'))).toThrow();
	});
	it('refuses missing or conflicting production markers', () => {
		const f = fixture();
		f.put('cloudflare/_worker.js', worker('no marker'));
		expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings: f.pins() })).toThrow(/production marker/);
		f.put('cloudflare/_worker.js', `${worker()} const second = ${JSON.stringify(JSON.stringify({ ...STAMP, buildId: 'second' }))};`);
		expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings: f.pins() })).toThrow(/production marker/);
	});
	it.each(['{}', '{"version":"wrong"}', '{"version":"a","version":"b"}', 'not JSON'])('refuses version.json %s with otherwise matching byte pins', (version) => {
		const f = fixture(); f.put('public/_app/version.json', version);
		expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings: f.pins() })).toThrow();
	});
	it.each([
		['public/test.txt', HOSTED_GATE_MARKER], ['cloudflare/chunk.js', 'export const extra = 1;'],
		['public/_worker.js', 'server bundle'], ['public/renamed.js', worker()],
		['public/.assetsignore', ''], ['public/_redirects', '/ /else 302'], ['public/_routes.json', '{}'],
		['public/code.js.map', '{}'], ['public/_headers', '/*\n  X-Unsafe: true'],
		['outside.txt', 'unexpected'],
	])('uses the existing checker to refuse %s', (file, content) => {
		const f = fixture(); f.put(file, content);
		expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings: f.pins() })).toThrow();
	});
	it.each([
		'import "./chunk.js";', 'import x from "package";', 'export { x } from "../outside.js";',
		'async function unproven(name) { return import(name); }', 'const dependency = require("foo");',
	])('refuses an open module graph: %s', (extra) => {
		const f = fixture(); f.put('cloudflare/_worker.js', `${worker()}\n${extra}`);
		expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings: f.pins() })).toThrow();
	});
});
