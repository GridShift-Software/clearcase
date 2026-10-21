import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
		expect(seen.fd3AtStart).toBe('closed'); // a preload took the values and closed fd 3 before the child's own code ran, in both modes
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

describe('a grandchild gets neither the pipe nor its variable, whether or not the child reads it (M4)', () => {
	test.each(['fd', 'env'])('--to %s: a child that never reads the values leaves nothing for `sh -c "sh -c ..."` to read from fd 3', (to) => {
		const code = [
			"const { execFileSync } = require('node:child_process');",
			"const viaSh = execFileSync('sh', ['-c', 'sh -c \"cat <&3\" 2>/dev/null; echo end'], { encoding: 'utf8' });",
			"console.log(JSON.stringify({ variable: 'CLEARCASE_SECRETS_FD' in process.env, shellEnv: execFileSync('sh', ['-c', 'env'], { encoding: 'utf8' }).includes('CLEARCASE_SECRETS_FD'), viaSh }));",
		].join('\n');
		const r = reader(['run', 'synthetic', '--keys', 'SYNTHETIC_TOKEN', '--to', to, '--', NODE, '-e', code]);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).not.toContain(VALUE);
		expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toEqual({ variable: false, shellEnv: false, viaSh: 'end\n' });
	});

	test.each(['fd', 'env'])('--to %s: a command that is not a real Node is refused before it starts, because only Node can close fd 3 first', (to) => {
		const marker = path.join(SCRATCH, `ran-${to}`);
		const script = path.join(SCRATCH, `not-node-${to}`);
		writeFileSync(script, `#!/bin/sh\necho ran > ${marker}\n`, { mode: 0o755 });
		for (const command of [[script], ['/bin/sh', '-c', 'true'], [process.execPath, '-e', '0']]) {
			const r = reader(['run', 'synthetic', '--to', to, '--', ...command]);
			expect(r.status, command.join(' ')).toBe(2);
			expect(r.stderr).toMatch(/secrets: refused: .*not a real Node/);
		}
		expect(existsSync(marker)).toBe(false);
	});
});

describe('a command that cannot start is a refusal with no stack trace, and --to env starts nothing first (L1)', () => {
	test.each(['fd', 'env'])('--to %s: a command that does not exist', (to) => {
		const r = reader(['run', 'synthetic', '--to', to, '--', path.join(SCRATCH, 'no-such-command')]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^secrets: refused: .*(no-such-command)/m);
		expect(r.stderr).not.toMatch(/\n\s+at |\.ts:\d+/);
		expect(`${r.stdout}${r.stderr}`).not.toContain(VALUE);
	});

	test('--to env does not run the command once without the secrets before it refuses', () => {
		const marker = path.join(SCRATCH, 'ran-before-refusal');
		const script = path.join(SCRATCH, 'probe-me');
		writeFileSync(script, `#!/bin/sh\necho "$@" >> ${marker}\n`, { mode: 0o755 });
		expect(reader(['run', 'synthetic', '--to', 'env', '--', script]).status).toBe(2);
		expect(existsSync(marker)).toBe(false);
	});

	test('a command that exists but cannot be executed is a refusal too', () => {
		const file = path.join(SCRATCH, 'not-executable');
		writeFileSync(file, 'echo hi\n', { mode: 0o644 });
		const r = reader(['run', 'synthetic', '--to', 'fd', '--', file]);
		expect(r.status).toBe(2);
		expect(r.stderr).not.toMatch(/\n\s+at /);
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
	test('an option without its value, or an unknown option, rather than passing every key', () => {
		refused(run('synthetic', ['--keys']), /usage/);
		refused(run('synthetic', ['--to']), /usage/);
		refused(run('synthetic', ['--key', 'SYNTHETIC_TOKEN']), /usage/);
		refused(run('synthetic', ['--keys', 'SYNTHETIC_TOKEN', '--keys', 'OTHER']), /usage/);
	});
	test('a refused read starts no child', () => {
		synthetic(undefined, 0o644);
		expect(run().stdout).not.toContain('child ran');
	});
});

describe("a preload or loader in the child's arguments is refused before the child starts (L1)", () => {
	// Node runs these before the entry, so they would run before the reader's own preload could be relied on to be first.
	const forms: string[][] = [['-r', 'x.cjs'], ['--require', 'x.cjs'], ['--require=x.cjs'], ['--import', 'x.mjs'], ['--import=x.mjs'], ['--loader', 'x.mjs'], ['--loader=x.mjs'], ['--experimental-loader', 'x.mjs']];
	test.each(forms)('%s', (...flag) => {
		const marker = path.join(SCRATCH, `ran-${flag[0]!.replaceAll('-', '')}`);
		writeFileSync(path.join(SCRATCH, 'x.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
		for (const to of ['fd', 'env']) {
			const r = reader(['run', 'synthetic', '--to', to, '--', NODE, ...flag, '-e', '0']);
			expect(r.status, `${flag.join(' ')} (${to})`).toBe(2);
			expect(r.stderr).toContain(`secrets: refused: ${flag[0]!.split('=')[0]} in the command's arguments`);
			expect(`${r.stdout}${r.stderr}`).not.toContain(VALUE);
		}
		expect(existsSync(marker)).toBe(false);
	});

	test('an argument that only contains one of the flags is passed on', () => {
		const r = reader(['run', 'synthetic', '--', NODE, '-e', 'console.log(process.argv.slice(1).join(" "))', '--', 'import', '--required', '--important']);
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe('import --required --important');
	});
});
