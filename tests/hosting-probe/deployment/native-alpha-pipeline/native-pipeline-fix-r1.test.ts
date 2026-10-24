// Fix round 1 for the checked pipeline's native profile (written findings M1, M2, L1-L3). RED first, against
// 3acde466, through the real CLI and the exported functions: M1 the final Worker upload bytes (a closed, prebundled
// module graph and a checked no_bundle upload), M2 externally pinned reviewed target/artifact/migrations/entry/source
// (not stage-self agreement), and the low class (unknown/override/repeated flags, duplicate JSON keys, hardlinks,
// descriptor-based reads). Synthetic fixtures only, unit level: no Wrangler, no bundler, no build, no provider, no
// credential and no network. A PASS here is structural, never evidence of a real artifact, an upload or a deploy.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { NATIVE_STAGED } from '../../../../deploy/native-alpha/pipeline.ts';
import * as pipeline from '../../../../deploy/native-alpha/pipeline.ts';
import * as target from '../../../../deploy/probes/target.ts';
import { checkNativeStage, digestDir, loadNativeTargets, stageNative } from '../../../../deploy/probes/target.ts';

const ROOT = path.join(import.meta.dirname, '../../../..');
const TARGET = path.join(ROOT, 'deploy/probes/target.ts');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const CLIENTS = path.join(FIXTURES, 'clients');
const ARTIFACT = path.join(FIXTURES, 'artifact');
const SCRATCH = path.join(ROOT, '.local/hosting-probe/deployment', `native-fix-r1-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let n = 0;
const scratch = (name: string) => path.join(SCRATCH, `${name}-${++n}`);
const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const cli = (...args: string[]) => spawnSync(process.execPath, [TARGET, ...args], { encoding: 'utf8', cwd: ROOT });
const refusedWith = (problems: string[], reason: RegExp | string) => expect(problems.some((p) => (typeof reason === 'string' ? p.includes(reason) : reason.test(p))), problems.join('\n') || '(no problems)').toBe(true);
const editJson = (file: string, edit: (v: Record<string, any>) => void) => {
	const v = JSON.parse(readFileSync(file, 'utf8'));
	edit(v);
	writeFileSync(file, JSON.stringify(v, null, 2));
};
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

/** The six external pins a reviewer holds, computed from the REVIEWED sources and never from a stage. */
type Pins = { target: string; config: string; artifact: string; migrations: string; entry: string; source: string };
const pinsFor = (clients: string, artifact: string, client = 'client-a'): Pins => ({
	target: sha(readFileSync(path.join(clients, client, 'target.json'))),
	config: sha(readFileSync(path.join(clients, client, 'wrangler.jsonc'))),
	artifact: digestDir(artifact),
	migrations: digestDir(path.join(clients, client, 'migrations')),
	entry: sha(readFileSync(path.join(artifact, 'cloudflare/_worker.js'))),
	source: JSON.parse(readFileSync(path.join(clients, client, 'target.json'), 'utf8')).runtime.sourceSha,
});
const PIN_FLAGS: Record<keyof Pins, string> = { target: '--pin-target', config: '--pin-config', artifact: '--pin-artifact', migrations: '--pin-migrations', entry: '--pin-entry', source: '--pin-source' };
const pinArgs = (p: Partial<Pins>) => Object.entries(p).flatMap(([k, v]) => [PIN_FLAGS[k as keyof Pins], v as string]);
const OK = pinsFor(CLIENTS, ARTIFACT);
const prebuiltArgs = (stage: string, clients = CLIENTS, pins: Partial<Pins> = OK) => ['prebuilt', 'client-a', '--profile', 'native', '--clients', clients, '--stage', stage, ...pinArgs(pins)];
const okStage = (clients = CLIENTS, artifact = ARTIFACT) => {
	const out = scratch('stage');
	expect(stageNative({ client: 'client-a', artifact, digest: digestDir(artifact), out, clients })).toEqual([]);
	return out;
};
const prebuilt = (stage: string, clients = CLIENTS, pins: Pins = OK) => checkNativeStage({ client: 'client-a', stage, clients, pins } as Parameters<typeof checkNativeStage>[0]);

/** A reviewed-source set built from `worker` as the artifact's _worker.js: the target names that artifact's digest, so only the bundle's own content can refuse it. */
const withWorker = (worker: string) => {
	const artifact = artifactCopy((d) => writeFileSync(path.join(d, 'cloudflare/_worker.js'), worker));
	const clients = clientsCopy((d) => editJson(path.join(d, 'client-a/target.json'), (t) => (t.runtime.artifactSha256 = digestDir(artifact))));
	return { artifact, clients };
};
const stageWorker = (worker: string) => {
	const { artifact, clients } = withWorker(worker);
	const out = scratch('stage-worker');
	return { problems: stageNative({ client: 'client-a', artifact, digest: digestDir(artifact), out, clients }), out, artifact, clients };
};

describe('M1: the upload is the final, closed, prebundled module graph, bound by its actual bytes', () => {
	test('the stage record binds every uploaded file by its own hash, and the entry by bytes and hash', () => {
		const record = JSON.parse(readFileSync(path.join(okStage(), 'stage.json'), 'utf8'));
		const entry = readFileSync(path.join(ARTIFACT, 'cloudflare/_worker.js'));
		expect(record.upload).toMatchObject({ mode: 'prebundled-no-bundle', additionalModules: false, entry: { path: NATIVE_STAGED.entry, sha256: sha(entry), bytes: entry.length } });
		const files = [
			['cloudflare/_app/version.json', readFileSync(path.join(ARTIFACT, 'cloudflare/_app/version.json'))],
			['cloudflare/_worker.js', entry],
		] as const;
		expect(record.upload.files).toEqual(files.map(([p, b]) => ({ path: `artifact/${p}`, bytes: b.length, sha256: sha(b) })));
	});

	const without = (key: string) => (text: string) => text.replace(new RegExp(`\\n\\s*"${key}": [^,\\n]+,?`), '');
	test.each([
		['no_bundle', without('no_bundle')],
		['find_additional_modules', without('find_additional_modules')],
	])('a config that does not declare %s is refused (Wrangler would bundle at upload time or sweep the tree)', (key, edit) => {
		const text = edit(readFileSync(path.join(CLIENTS, 'client-a/wrangler.jsonc'), 'utf8'));
		const t = loadNativeTargets(CLIENTS);
		refusedWith(target.checkNative({ client: 'client-a', targets: t, text }), new RegExp(`${key}`));
	});
	test.each([
		['no_bundle false', '"no_bundle": true', '"no_bundle": false', /no_bundle is false, not true/],
		['find_additional_modules true', '"find_additional_modules": false', '"find_additional_modules": true', /find_additional_modules is true, not false/],
	])('%s is refused', (_what, from, to, reason) => {
		const text = readFileSync(path.join(CLIENTS, 'client-a/wrangler.jsonc'), 'utf8');
		expect(text, 'the native fixture must declare the closed upload profile').toContain(from);
		refusedWith(target.checkNative({ client: 'client-a', targets: loadNativeTargets(CLIENTS), text: text.replace(from, to) }), reason);
	});

	const unsafe: [string, string, RegExp][] = [
		['a bare package import', "import { parse } from 'devalue';\nexport default { fetch() { return new Response(String(parse)); } };\n", /devalue/],
		['a bare package re-export', "export * from 'svelte';\nexport default { fetch() { return new Response('x'); } };\n", /svelte/],
		['a relative import (nothing else is uploaded)', "import x from './server.js';\nexport default { fetch() { return new Response(x); } };\n", /\.\/server\.js/],
		['an import that escapes the stage', "import x from '../../../node_modules/devalue/index.js';\nexport default { fetch() { return new Response(x); } };\n", /node_modules/],
		['a host module outside the documented set', "import fs from 'node:fs';\nexport default { fetch() { return new Response(String(fs)); } };\n", /node:fs/],
		['a dynamic import with a literal', "export default { async fetch() { const m = await import('devalue'); return new Response(String(m)); } };\n", /dynamic import/],
		['a computed dynamic import', "export default { async fetch(r) { const m = await import(new URL(r.url).searchParams.get('m')); return new Response(String(m)); } };\n", /dynamic import/],
		['a require call', "const x = require('devalue');\nexport default { fetch() { return new Response(String(x)); } };\n", /require/],
		['a worker that is not parseable JavaScript', 'export default { fetch( {\n', /not (valid|parseable)/],
	];
	test.each(unsafe)('stage refuses an artifact whose Worker has %s, even when the target names its digest', (_what, worker, reason) => {
		const r = stageWorker(worker);
		refusedWith(r.problems, reason);
	});
	test.each(unsafe)('prebuilt refuses a stage whose Worker has %s, even with matching external pins', (_what, worker, reason) => {
		// An honest stage of the closed fixture, then the Worker swapped and the target, record and pins all moved to match: only the bundle's own content can refuse it.
		const { artifact, clients } = withWorker(worker);
		const out = okStage();
		writeFileSync(path.join(out, 'artifact/cloudflare/_worker.js'), worker);
		cpSync(path.join(clients, 'client-a/target.json'), path.join(out, 'target.json'));
		refusedWith(prebuilt(out, clients, pinsFor(clients, artifact)), reason);
	});

	// Added after GREEN as extra guards (not part of the RED set): syntax-level cases a text scan would get wrong.
	test.each([
		['an import inside a template literal expression', 'export default { fetch() { return new Response(`${import("devalue")}`); } };\n', /dynamic import/],
		['an export-from of a named binding', "export { parse } from 'devalue';\nexport default { fetch() { return new Response('x'); } };\n", /devalue/],
		['a side-effect import', "import 'devalue';\nexport default { fetch() { return new Response('x'); } };\n", /devalue/],
		['a namespace re-export', "export * as ns from './x.js';\nexport default { fetch() { return new Response('x'); } };\n", /\.\/x\.js/],
		['module.require', "const x = module.require('devalue');\nexport default { fetch() { return new Response(String(x)); } };\n", /require/],
	])('stage refuses %s', (_what, worker, reason) => refusedWith(stageWorker(worker).problems, reason));
	test('import.meta, a regex and a string that look like imports, and a very long expression chain are accepted without a stack overflow', () => {
		const chain = Array.from({ length: 30_000 }, () => 'a').join(' + ');
		const worker = `const a = 1; const u = import.meta.url; const r = /import\\(['"]x['"]\\)/; const t = \`require('x')\`; const sum = ${chain};\nexport default { fetch() { return new Response(String([u, r, t, sum])); } };\n`;
		expect(stageWorker(worker).problems).toEqual([]);
	});
	test('the documented host module (cloudflare:workers) in a closed bundle is accepted, and is recorded', () => {
		const worker = "import { env } from 'cloudflare:workers';\nexport default { fetch() { return new Response(String(env)); } };\n";
		const r = stageWorker(worker);
		expect(r.problems).toEqual([]);
		expect(JSON.parse(readFileSync(path.join(r.out, 'stage.json'), 'utf8')).upload.hostImports).toEqual(['cloudflare:workers']);
	});
	test('a comment or string that merely mentions an import is not an import', () => {
		const worker = "// import x from 'devalue'\nconst s = \"import('devalue') require('x')\";\nexport default { fetch() { return new Response(s); } };\n";
		expect(stageWorker(worker).problems).toEqual([]);
	});
});

describe('M2: prebuilt needs externally pinned reviewed identity, independent of the stage', () => {
	test('an honest stage with the reviewer pins and the reviewed clients passes through the real CLI', () => {
		const r = cli(...prebuiltArgs(okStage()));
		expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: 'TARGET PASS prebuilt client-a profile=native\n', stderr: '' });
	});

	/** Reviewed sources an attacker rewrote consistently (new D1 UUID in target and config, new Worker, new digests), staged honestly: the stage agrees with itself. */
	const forged = () => {
		const worker = 'export default { fetch() { return new Response("forged"); } };\n';
		const artifact = artifactCopy((d) => writeFileSync(path.join(d, 'cloudflare/_worker.js'), worker));
		const uuid = '00000000-0000-4000-8000-0000000f0107';
		const clients = clientsCopy((d) => {
			editJson(path.join(d, 'client-a/target.json'), (t) => ((t.d1.id = uuid), (t.runtime.artifactSha256 = digestDir(artifact))));
			writeFileSync(path.join(d, 'client-a/wrangler.jsonc'), readFileSync(path.join(CLIENTS, 'client-a/wrangler.jsonc'), 'utf8').replace('00000000-0000-4000-8000-0000000a0107', uuid));
		});
		return { stage: okStage(clients, artifact), clients, artifact };
	};
	test('a self-consistent forged stage (new D1 UUID, new Worker, every in-stage hash and the record moved together) is refused against the reviewed pins and clients', () => {
		const f = forged();
		expect(stageNative).toBeTypeOf('function');
		const r = cli(...prebuiltArgs(f.stage));
		expect(r.status, r.stdout + r.stderr).toBe(1);
		expect(r.stderr).toMatch(/pin|reviewed/);
		refusedWith(prebuilt(f.stage), /pin|reviewed/);
	});
	test('the same forged stage is refused when the forged clients directory is passed too, because the pins do not move', () => {
		const f = forged();
		refusedWith(prebuilt(f.stage, f.clients), /pin target/);
	});
	test('a stage whose target.json differs from the reviewed clients target.json is refused even when the pins are not given the staged hash', () => {
		const out = okStage();
		editJson(path.join(out, 'target.json'), (t) => (t.limits.cpu_ms = 999));
		refusedWith(prebuilt(out), /target\.json.*(differs|reviewed)|pin target/);
	});

	test.each(Object.keys(PIN_FLAGS) as (keyof Pins)[])('prebuilt without %s pin is a usage error and checks nothing', (k) => {
		const { [k]: _omitted, ...rest } = OK;
		const r = cli(...prebuiltArgs(okStage(), CLIENTS, rest));
		expect(r.status, r.stdout + r.stderr).toBe(2);
		expect(r.stdout).toBe('');
	});
	test('prebuilt called as a function without pins refuses, naming the missing external pins', () => {
		refusedWith(checkNativeStage({ client: 'client-a', stage: okStage(), clients: CLIENTS } as Parameters<typeof checkNativeStage>[0]), /pins/);
	});
	test.each(Object.keys(PIN_FLAGS) as (keyof Pins)[])('a wrong %s pin is refused', (k) => {
		const wrong = k === 'source' ? '1'.repeat(40) : sha(`not ${k}`);
		const r = cli(...prebuiltArgs(okStage(), CLIENTS, { ...OK, [k]: wrong }));
		expect(r.status, r.stdout + r.stderr).toBe(1);
		expect(r.stderr).toContain(PIN_FLAGS[k].slice(2));
	});
	test('a malformed pin is a usage error', () => {
		expect(cli(...prebuiltArgs(okStage(), CLIENTS, { ...OK, target: 'abc' })).status).toBe(2);
	});

	test('a reviewed target.json that is a symlink into the stage is refused', () => {
		const out = okStage();
		const clients = clientsCopy((d) => {
			rmSync(path.join(d, 'client-a/target.json'));
			symlinkSync(path.join(out, 'target.json'), path.join(d, 'client-a/target.json'));
		});
		refusedWith(prebuilt(out, clients), /symlink|not a regular file/);
	});
	test('a reviewed clients directory that is itself a symlink is refused', () => {
		const out = okStage();
		const link = scratch('clients-link');
		symlinkSync(CLIENTS, link);
		refusedWith(prebuilt(out, link), /symlink/);
	});
	test('a stage that sits inside the reviewed clients directory (or the reverse) is refused', () => {
		const clients = clientsCopy();
		const inside = path.join(clients, 'stage-here');
		expect(stageNative({ client: 'client-a', artifact: ARTIFACT, digest: digestDir(ARTIFACT), out: inside, clients })).not.toEqual([]);
		const out = okStage();
		mkdirSync(path.join(out, 'reviewed'));
		cpSync(CLIENTS, path.join(out, 'reviewed'), { recursive: true });
		refusedWith(prebuilt(out, path.join(out, 'reviewed')), /inside the stage|stage .* (inside|overlap)/);
	});
});

describe('L1: the native CLI rejects every unknown, override, repeated, valueless, positional and unread argument', () => {
	const stageDir = () => okStage();
	const base = (extra: string[]) => (stage: string) => [...prebuiltArgs(stage), ...extra];
	test.each([
		['an unknown flag', ['--bogus', 'x']],
		['a config override', ['--config', '/etc/passwd']],
		['an environment override', ['--env', 'prod']],
		['a name override', ['--name', 'other']],
		['a route override', ['--route', 'x.example/*']],
		['a var override', ['--var', 'A:1']],
		['a define override', ['--define', 'A:1']],
		['a compatibility-date override', ['--compatibility-date', '2020-01-01']],
		['a no-bundle flag', ['--no-bundle']],
		['a flag that is not this command (--digest)', ['--digest', sha('x')]],
		['a second --stage', ['--stage', '/tmp/elsewhere']],
		['a repeated pin', ['--pin-target', sha('other')]],
		['a repeated --clients', ['--clients', CLIENTS]],
		['a stray positional', ['extra']],
		['a flag-looking value', ['--stage=/tmp/x']],
	])('prebuilt with %s is a usage error and checks nothing', (_what, extra) => {
		const r = cli(...base(extra)(stageDir()));
		expect(r.status, r.stdout + r.stderr).toBe(2);
		expect(r.stdout).toBe('');
	});
	test.each([
		['check', ['check', 'client-a', '--profile', 'native', '--clients', CLIENTS]],
		['stage', ['stage', 'client-a', '--profile', 'native', '--clients', CLIENTS, '--artifact', ARTIFACT, '--digest', digestDir(ARTIFACT), '--out', path.join(SCRATCH, 'cli-stage-never')]],
	])('%s with an unknown or repeated flag is a usage error', (_c, args) => {
		expect(cli(...args, '--bogus', 'x').status).toBe(2);
		expect(cli(...args, '--clients', CLIENTS).status).toBe(2);
		expect(cli(...args, '--stage', '/tmp/x').status).toBe(2);
		expect(cli(...args, 'extra').status).toBe(2);
	});
	test('--profile=native is a usage error, not the legacy path', () => {
		expect(cli('check', 'client-a', '--profile=native', '--clients', CLIENTS).status).toBe(2);
	});
	test('a flag with no value is a usage error', () => {
		expect(cli('check', 'client-a', '--profile', 'native', '--clients').status).toBe(2);
		expect(cli('check', 'client-a', '--profile', 'native', '--clients', '--config', 'x').status).toBe(2);
	});
	test('a repeated --profile is a usage error', () => {
		expect(cli('check', 'client-a', '--profile', 'native', '--profile', 'native', '--clients', CLIENTS).status).toBe(2);
	});
	test('the legacy default is unchanged: an unknown flag without --profile is still ignored', () => {
		expect(cli('check', 'client-a', '--bogus')).toMatchObject({ status: 0, stdout: 'TARGET PASS check client-a\n' });
	});
});

describe('L1: the upload invocation is a checked exact no-override contract', () => {
	const contract = (pipeline as Record<string, any>).NATIVE_UPLOAD_ARGV as readonly string[] | undefined;
	const problems = (argv: string[]) => ((pipeline as Record<string, any>).nativeUploadInvocationProblems as (a: string[]) => string[])(argv);
	test('the contract is exactly wrangler deploy --config wrangler.jsonc', () => expect(contract).toEqual(['wrangler', 'deploy', '--config', 'wrangler.jsonc']));
	test('the exact argv passes', () => expect(problems([...contract!])).toEqual([]));
	test.each([
		['--name', 'x'], ['--env', 'prod'], ['--route', 'x/*'], ['--var', 'A:1'], ['--define', 'A:1'], ['--keep-vars'], ['--no-bundle'], ['--minify'],
		['--compatibility-date', '2020-01-01'], ['--config', '/etc/x'], ['--dry-run'], ['--outdir', 'x'], ['x'],
	])('an extra %s is refused', (...extra) => refusedWith(problems([...contract!, ...extra]), /exactly/));
	test('a different binary, subcommand, config or order is refused', () => {
		for (const argv of [['npx', 'wrangler', 'deploy', '--config', 'wrangler.jsonc'], ['wrangler', 'versions', 'upload', '--config', 'wrangler.jsonc'], ['wrangler', 'deploy', '--config', 'other.jsonc'], ['wrangler', 'deploy'], ['wrangler', '--config', 'wrangler.jsonc', 'deploy'], []]) refusedWith(problems(argv), /exactly/);
	});
	test('the invocation command checks the cwd is the stage root and nothing else', () => {
		const stage = okStage();
		const ok = cli('invocation', 'client-a', '--profile', 'native', '--stage', stage, '--cwd', stage, '--', 'wrangler', 'deploy', '--config', 'wrangler.jsonc');
		expect({ status: ok.status, stdout: ok.stdout }).toEqual({ status: 0, stdout: 'TARGET PASS invocation client-a profile=native\n' });
		const other = cli('invocation', 'client-a', '--profile', 'native', '--stage', stage, '--cwd', ROOT, '--', 'wrangler', 'deploy', '--config', 'wrangler.jsonc');
		expect(other.status).toBe(1);
		const override = cli('invocation', 'client-a', '--profile', 'native', '--stage', stage, '--cwd', stage, '--', 'wrangler', 'deploy', '--config', 'wrangler.jsonc', '--env', 'prod');
		expect(override.status).toBe(1);
	});
});

describe('L2: duplicate JSON keys are refused (a bounded strict parse, never config evaluation)', () => {
	const config = () => readFileSync(path.join(CLIENTS, 'client-a/wrangler.jsonc'), 'utf8');
	test.each([
		['a top-level key repeated with the same value', '"workers_dev": false,', '"workers_dev": false, "workers_dev": false,'],
		['a top-level key repeated with another value (last wins in JSON.parse)', '"workers_dev": false,', '"workers_dev": true, "workers_dev": false,'],
		['a nested key repeated', '"zone_id": "db7c322907320aba562d64015ee7d673",', '"zone_id": "f", "zone_id": "db7c322907320aba562d64015ee7d673",'],
	])('a Wrangler config with %s is refused', (_what, from, to) => {
		const text = config().replace(from, to);
		expect(text).not.toBe(config());
		refusedWith(target.checkNative({ client: 'client-a', targets: loadNativeTargets(CLIENTS), text }), /duplicate/i);
	});
	test('a target.json with a repeated key is refused by the native loader', () => {
		const clients = clientsCopy((d) => {
			const f = path.join(d, 'client-a/target.json');
			writeFileSync(f, readFileSync(f, 'utf8').replace('"workersDev": false,', '"workersDev": true, "workersDev": false,'));
		});
		expect(() => loadNativeTargets(clients)).toThrow(/duplicate/i);
	});
	test('a staged target.json with a repeated key is refused by stage and prebuilt', () => {
		const clients = clientsCopy((d) => {
			const f = path.join(d, 'client-a/target.json');
			writeFileSync(f, readFileSync(f, 'utf8').replace('"workersDev": false,', '"workersDev": false, "workersDev": false,'));
		});
		refusedWith(stageNative({ client: 'client-a', artifact: ARTIFACT, digest: digestDir(ARTIFACT), out: scratch('dup-stage'), clients }), /duplicate/i);
	});
});

describe('L3: stage and prebuilt refuse hardlinks and read through descriptors', () => {
	test.each([
		['target.json', 'client-a/target.json'],
		['a migration file', 'client-a/migrations/0001_synthetic.sql'],
	])('stage refuses a hardlinked source %s', (_what, rel) => {
		const clients = clientsCopy((d) => linkSync(path.join(d, rel), path.join(SCRATCH, `hard-${++n}`)));
		refusedWith(stageNative({ client: 'client-a', artifact: ARTIFACT, digest: digestDir(ARTIFACT), out: scratch('hard-stage'), clients }), /hard link|hardlink/i);
	});
	test('stage refuses a hardlinked artifact file', () => {
		const artifact = artifactCopy((d) => linkSync(path.join(d, 'cloudflare/_worker.js'), path.join(SCRATCH, `hard-${++n}`)));
		refusedWith(stageNative({ client: 'client-a', artifact, digest: digestDir(artifact), out: scratch('hard-stage'), clients: CLIENTS }), /hard link|hardlink/i);
	});
	test.each(['wrangler.jsonc', 'artifact/cloudflare/_worker.js', 'migrations/0001_synthetic.sql'])('prebuilt refuses a staged %s that gained a second hard link', (rel) => {
		const out = okStage();
		linkSync(path.join(out, rel), path.join(SCRATCH, `hard-${++n}`));
		refusedWith(prebuilt(out), /hard link|hardlink/i);
	});

	const readRegular = (target as Record<string, any>).readRegular as (file: string, root?: string) => Buffer;
	test('readRegular reads a regular file', () => {
		const f = path.join(scratch('rr'));
		writeFileSync(f, 'abc');
		expect(readRegular(f, SCRATCH).toString()).toBe('abc');
	});
	test('readRegular refuses a FIFO without blocking', () => {
		const f = scratch('fifo');
		expect(spawnSync('mkfifo', [f]).status).toBe(0);
		expect(() => readRegular(f, SCRATCH)).toThrow(/not a regular file/);
	});
	test('readRegular refuses a symlink and a hard link', () => {
		const f = scratch('rr');
		writeFileSync(f, 'abc');
		const s = scratch('sym');
		symlinkSync(f, s);
		expect(() => readRegular(s, SCRATCH)).toThrow(/symlink|not a regular file/);
		linkSync(f, scratch('hard'));
		expect(() => readRegular(f, SCRATCH)).toThrow(/hard link/i);
	});
	test('readRegular refuses a path that escapes its root through a swapped directory', () => {
		const root = scratch('root');
		const outside = scratch('outside');
		mkdirSync(root);
		mkdirSync(outside);
		writeFileSync(path.join(outside, 'secret'), 's');
		symlinkSync(outside, path.join(root, 'sub'));
		expect(() => readRegular(path.join(root, 'sub/secret'), root)).toThrow(/outside|escape|symlink/);
	});
});
