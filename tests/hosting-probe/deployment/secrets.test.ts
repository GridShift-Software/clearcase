import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

const REPO = path.join(import.meta.dirname, '../../..');
const READER = path.join(REPO, 'deploy/probes/secrets.ts');
const CHILD = path.join(import.meta.dirname, 'fixtures/secret-child.mjs');
const SCRATCH = path.join(REPO, '.local/hosting-probe/deployment', `secrets-${process.pid}`);
const HOME = path.join(SCRATCH, 'home');
const DIR = path.join(HOME, '.config/clearcase/secrets');
const FILE = path.join(DIR, 'synthetic.env');
const VALUE = `cc-synthetic-${randomBytes(16).toString('hex')}`;
const SHA = createHash('sha256').update(VALUE).digest('hex');
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** The first `node` on PATH that is real Node: under `bun run --bun`, the first one is Bun's stand-in. */
const NODE = (process.env.PATH ?? '').split(':').map((d) => path.join(d, 'node')).find((p) => {
	try {
		accessSync(p, constants.X_OK);
	} catch {
		return false;
	}
	return spawnSync(p, ['-p', 'typeof Bun'], { encoding: 'utf8' }).stdout.trim() === 'undefined';
})!;

function synthetic(contents = `# synthetic, GRS-107\nSYNTHETIC_TOKEN=${VALUE}\nOTHER_TOKEN=cc-synthetic-other\n`, fileMode = 0o600, dirMode = 0o700) {
	rmSync(SCRATCH, { recursive: true, force: true });
	mkdirSync(DIR, { recursive: true });
	writeFileSync(FILE, contents);
	chmodSync(FILE, fileMode);
	chmodSync(DIR, dirMode);
}

const reader = (args: string[], env: Record<string, string | undefined> = { HOME }) =>
	spawnSync(process.execPath, [READER, ...args], { cwd: SCRATCH, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv });

beforeEach(() => synthetic());

describe('one child gets the values; its children and environment do not', () => {
	test.each(['env', 'fd'])('--to %s', (to) => {
		const r = reader(['run', 'synthetic', '--keys', 'SYNTHETIC_TOKEN', '--to', to, '--', NODE, CHILD, to], { HOME, SYNTHETIC_TOKEN: 'cc-stale-exported-value' });
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).not.toContain(VALUE);
		const seen = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
		expect(seen.sees).toBe(SHA);
		expect(seen.fd3AtStart).toBe(to === 'fd' ? 'socket' : 'closed');
		expect(seen.fd3AfterTake).toBe('closed');
		expect([seen.initialEnviron, seen.enumerable, seen.jsonCopy, seen.fdVariable]).toEqual([false, false, false, false]);
		expect(seen.grandchildren).toHaveLength(6);
		for (const g of seen.grandchildren) expect(g, g.via).toMatchObject({ key: false, value: false, pipe: false });
	});

	test('only the selected keys are passed', () => {
		const r = reader(['run', 'synthetic', '--keys', 'OTHER_TOKEN', '--to', 'env', '--', NODE, CHILD, 'env']);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!).sees).toBeNull();
	});

	test("the child's exit code is the reader's", () => {
		expect(reader(['run', 'synthetic', '--', NODE, '-e', 'process.exit(7)']).status).toBe(7);
	});
});

describe('refusals name the path, mode, key or line, never a value', () => {
	const refused = (r: ReturnType<typeof reader>, reason: RegExp) => {
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(reason);
		expect(`${r.stdout}${r.stderr}`).not.toContain(VALUE);
	};
	const run = (name = 'synthetic', extra: string[] = []) => reader(['run', name, ...extra, '--', NODE, '-e', 'console.log("child ran")']);

	test.each([0o644, 0o640, 0o604, 0o660])('a file with mode %o', (mode) => (synthetic(undefined, mode), refused(run(), /has mode \d+; it must be 600 or stricter/)));
	test.each([0o755, 0o750, 0o701, 0o770])('a directory with mode %o', (mode) => (synthetic(undefined, 0o600, mode), refused(run(), /has mode \d+; it must be 700 or stricter/)));
	test('a symlinked file', () => {
		rmSync(FILE);
		writeFileSync(path.join(SCRATCH, 'elsewhere.env'), `SYNTHETIC_TOKEN=${VALUE}\n`, { mode: 0o600 });
		symlinkSync(path.join(SCRATCH, 'elsewhere.env'), FILE);
		refused(run(), /symlink is refused/);
	});
	test('a symlinked directory', () => {
		rmSync(DIR, { recursive: true });
		mkdirSync(path.join(SCRATCH, 'real-secrets'), { mode: 0o700 });
		writeFileSync(path.join(SCRATCH, 'real-secrets/synthetic.env'), `SYNTHETIC_TOKEN=${VALUE}\n`, { mode: 0o600 });
		symlinkSync(path.join(SCRATCH, 'real-secrets'), DIR);
		refused(run(), /is not a directory/);
	});
	test.each(['../synthetic', 'Synthetic', 'synthetic.env', '.hidden', ''])('the name %j', (name) => refused(run(name), /usage|is not a secrets file name/));
	test('a missing file', () => refused(run('absent'), /cannot be opened \(ENOENT\)/));
	test('a missing key', () => refused(run('synthetic', ['--keys', 'SYNTHETIC_TOKEN,ABSENT_TOKEN']), /has no ABSENT_TOKEN/));
	test('a malformed line, without echoing it', () => (synthetic(`SYNTHETIC_TOKEN=${VALUE}\n${VALUE}\n`), refused(run(), /line 2 is not KEY=VALUE/)));
	test('a key set twice', () => (synthetic(`SYNTHETIC_TOKEN=${VALUE}\nSYNTHETIC_TOKEN=${VALUE}\n`), refused(run(), /sets SYNTHETIC_TOKEN twice/)));
	test('no HOME, or a relative one', () => {
		refused(reader(['run', 'synthetic', '--', NODE, '-e', '0'], {}), /HOME is not an absolute path/);
		refused(reader(['run', 'synthetic', '--', NODE, '-e', '0'], { HOME: 'relative/home' }), /HOME is not an absolute path/);
	});
	test('--to env with a command that is not real Node', () => {
		refused(reader(['run', 'synthetic', '--to', 'env', '--', '/bin/sh', '-c', 'true']), /not a real Node/);
		refused(reader(['run', 'synthetic', '--to', 'env', '--', process.execPath, '-e', '0']), /not a real Node/);
	});
	test('a refused read starts no child', () => {
		synthetic(undefined, 0o644);
		expect(run().stdout).not.toContain('child ran');
	});
});
