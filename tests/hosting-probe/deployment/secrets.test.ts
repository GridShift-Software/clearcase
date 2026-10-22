import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { WHOLE_LINE_OPTIONS } from '../../../deploy/probes/secrets.ts';

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
const found = (process.env.PATH ?? '').split(':').map((d) => path.join(d, 'node')).find((p) => {
	try {
		accessSync(p, constants.X_OK);
	} catch {
		return false;
	}
	return spawnSync(p, ['-p', 'typeof Bun'], { encoding: 'utf8' }).stdout.trim() === 'undefined';
});
if (!found) throw new Error('secrets.test.ts needs a real Node (>= 22) on PATH past Bun\'s `node` stand-in, and none was found among: ' + (process.env.PATH ?? '(PATH is unset)'));
const NODE: string = found;

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
		writeFileSync(path.join(SCRATCH, 'exit.cjs'), 'process.exit(7);\n');
		expect(reader(['run', 'synthetic', '--', NODE, path.join(SCRATCH, 'exit.cjs')]).status).toBe(7);
	});
});

describe('a grandchild gets neither the pipe nor its variable, whether or not the child reads it (M4)', () => {
	test.each(['fd', 'env'])('--to %s: a child that never reads the values leaves nothing for `sh -c "sh -c ..."` to read from fd 3', (to) => {
		const code = [
			"const { execFileSync } = require('node:child_process');",
			"const viaSh = execFileSync('sh', ['-c', 'sh -c \"cat <&3\" 2>/dev/null; echo end'], { encoding: 'utf8' });",
			"console.log(JSON.stringify({ variable: 'CLEARCASE_SECRETS_FD' in process.env, shellEnv: execFileSync('sh', ['-c', 'env'], { encoding: 'utf8' }).includes('CLEARCASE_SECRETS_FD'), viaSh }));",
		].join('\n');
		writeFileSync(path.join(SCRATCH, 'grandchild.cjs'), `${code}\n`);
		const r = reader(['run', 'synthetic', '--keys', 'SYNTHETIC_TOKEN', '--to', to, '--', NODE, path.join(SCRATCH, 'grandchild.cjs')]);
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
		writeFileSync(path.join(SCRATCH, 'argv.cjs'), 'console.log(process.argv.slice(2).join(" "));\n');
		const r = reader(['run', 'synthetic', '--', NODE, path.join(SCRATCH, 'argv.cjs'), 'import', '--required', '--important']);
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe('import --required --important');
	});
});

describe('every Node option before the entry is refused unless it is on the allow-list (polish C, L1)', () => {
	// --env-file and --experimental-config-file hand Node options to the child (NODE_OPTIONS=--require, nodeOptions.require) with no loader flag in argv.
	const marker = () => path.join(SCRATCH, 'ran-option');
	const files = () => {
		writeFileSync(path.join(SCRATCH, 'x.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker())}, 'ran');\n`);
		writeFileSync(path.join(SCRATCH, 'pre.env'), `NODE_OPTIONS=--require ${path.join(SCRATCH, 'x.cjs')}\n`);
		writeFileSync(path.join(SCRATCH, 'pre.json'), JSON.stringify({ nodeOptions: { require: [path.join(SCRATCH, 'x.cjs')] } }));
	};
	const refusedForms: [string, string[]][] = [
		['--env-file=', ['--env-file=pre.env']],
		['--env-file ', ['--env-file', 'pre.env']],
		['--env-file-if-exists=', ['--env-file-if-exists=pre.env']],
		['--env-file-if-exists ', ['--env-file-if-exists', 'pre.env']],
		['--experimental-config-file=', ['--experimental-config-file=pre.json']],
		['--experimental-config-file ', ['--experimental-config-file', 'pre.json']],
		['an option no list names (--conditions=)', ['--conditions=x']],
		['an option no list names (--inspect)', ['--inspect']],
		['a short option no list names (-C)', ['-C', 'x']],
	];
	test.each(refusedForms)('%s', (_name, flag) => {
		files();
		for (const to of ['fd', 'env']) {
			const r = reader(['run', 'synthetic', '--to', to, '--', NODE, ...flag, '-e', '0']);
			expect(r.status, `${flag.join(' ')} (${to})`).toBe(2);
			expect(r.stderr).toMatch(/secrets: refused: .*(Node option|before the entry)/);
			expect(`${r.stdout}${r.stderr}`).not.toContain(VALUE);
		}
		expect(existsSync(marker())).toBe(false);
	});

	test('Node reads these three from anywhere before a `--`, so they are refused after -e and after the script too', () => {
		files();
		const args: string[][] = [['-e', '0', '--env-file=pre.env'], ['--env-file=pre.env', 'x.cjs'], ['--env-file', 'pre.env', 'x.cjs'], ['x.cjs', '--env-file=pre.env'], ['x.cjs', '--env-file-if-exists', 'pre.env'], ['x.cjs', '--experimental-config-file=pre.json']];
		for (const a of args) expect(reader(['run', 'synthetic', '--', NODE, ...a]).status, a.join(' ')).toBe(2);
		expect(existsSync(marker())).toBe(false);
	});

	test('the options the allow-list accepted are refused now (escalation), and a script with arguments of its own (after `--` too) still runs', () => {
		files();
		const script = path.join(SCRATCH, 'args.cjs');
		writeFileSync(script, 'console.log(process.argv.slice(2).join(" "));\n');
		const run = (...args: string[]) => reader(['run', 'synthetic', '--', NODE, ...args]);
		for (const args of [['--no-warnings', '--max-old-space-size=256', '-p', '1 + 1'], ['--no-warnings', script, 'a'], [script, '--', '--env-file=pre.env'], ['--eval=console.log(7)']]) {
			const r = run(...args);
			expect(r.status, args.join(' ')).toBe(2);
			expect(r.stdout).toBe('');
		}
		expect(run(script, 'a', '-x', '--y=1').stdout.trim()).toBe('a -x --y=1');
		expect(run(script, 'a', '--', '-x').stdout.trim()).toBe('a -- -x');
		expect(existsSync(marker())).toBe(false);
	});
});

describe('forms that passed the reader and ran another preload, or none, with fd 3 open (escalation of polish C, L1)', () => {
	// pre.env and pre.json hand Node NODE_OPTIONS=--require x.cjs and nodeOptions.require, node.config.json in the cwd is
	// what --experimental-default-config-file reads, and y.cjs is an entry that only marks that it ran.
	const option = () => path.join(SCRATCH, 'ran-option');
	const entry = () => path.join(SCRATCH, 'ran-entry');
	const files = () => {
		const x = path.join(SCRATCH, 'x.cjs');
		writeFileSync(x, `require('node:fs').writeFileSync(${JSON.stringify(option())}, 'ran');\n`);
		writeFileSync(path.join(SCRATCH, 'y.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(entry())}, 'ran');\n`);
		writeFileSync(path.join(SCRATCH, 'pre.env'), `NODE_OPTIONS=--require ${x}\n`);
		writeFileSync(path.join(SCRATCH, 'pre.json'), JSON.stringify({ nodeOptions: { require: [x] } }));
		writeFileSync(path.join(SCRATCH, 'node.config.json'), JSON.stringify({ nodeOptions: { require: [x] } }));
	};
	const forms: [string, string[]][] = [
		['-p is a flag, not a value skip: -p --env-file=pre.env', ['-p', '--env-file=pre.env']],
		['-p is a flag, not a value skip: -p --experimental-default-config-file', ['-p', '--experimental-default-config-file']],
		['--experimental-default-config-file after the entry', ['y.cjs', '--experimental-default-config-file']],
		["--experimental-config-file= after the entry's --", ['y.cjs', '--', '--experimental-config-file=pre.json']],
		['--experimental-config-file= after a -- before the entry', ['--', 'y.cjs', '--experimental-config-file=pre.json']],
		["inspect as the entry: Node's debugger, which never runs the reader's preload and starts the entry with CLEARCASE_SECRETS_FD", ['inspect', '--port=0', '--probe', 'y.cjs:1', '--expr', '1', 'y.cjs']],
	];
	test.each(forms)('%s', (_name, args) => {
		files();
		for (const to of ['fd', 'env']) {
			const r = reader(['run', 'synthetic', '--to', to, '--', NODE, ...args]);
			expect(r.status, `${args.join(' ')} (${to})`).toBe(2);
			expect(r.stderr).toMatch(/^secrets: refused: /m);
			expect(`${r.stdout}${r.stderr}`).not.toContain(VALUE);
		}
		expect(existsSync(option()), 'a --require preload ran').toBe(false);
		expect(existsSync(entry()), 'the entry ran').toBe(false);
	});
});

describe('the command is <node> <entry> [args...], and no argument starts with a whole-command-line option (escalation)', () => {
	const entry = () => path.join(SCRATCH, 'ran-entry');
	const run = (...args: string[]) => reader(['run', 'synthetic', '--', NODE, ...args]);
	const files = () => {
		writeFileSync(path.join(SCRATCH, 'y.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(entry())}, process.argv.slice(2).join(' '));\n`);
		writeFileSync(path.join(SCRATCH, 'pre.env'), 'NODE_OPTIONS=--title=cc-pre\n');
	};

	test.each([
		['no entry', []],
		['- (the program on stdin)', ['-']],
		['an empty entry', ['']],
		['a bare file name, with no /', ['y.cjs']],
		['a bare file name after an option the allow-list accepted', ['--no-warnings', 'y.cjs']],
	])('refused: %s', (_name, args) => {
		files();
		const r = run(...(args as string[]));
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^secrets: refused: .*(no entry|before the entry|has no \/)/m);
		expect(existsSync(entry())).toBe(false);
	});

	test.each([
		['an option-file name with a suffix', ['./y.cjs', '--env-filex=pre.env']],
		['--env-file-if-exists after the entry, in its own argument', ['./y.cjs', '--env-file-if-exists', 'pre.env']],
		['--experimental-default-config-file= after the entry', ['./y.cjs', '--experimental-default-config-file=x']],
		['--experimental-config-file after a program argument and a --', ['./y.cjs', 'a', '--', '--experimental-config-file', 'pre.json']],
	])('refused wherever it stands: %s', (_name, args) => {
		files();
		const r = run(...args);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^secrets: refused: --[a-z-]+ in the command's arguments is read by Node wherever it stands/m);
		expect(existsSync(entry())).toBe(false);
	});

	test('a path entry runs, with its arguments as the program gave them', () => {
		files();
		for (const [args, seen] of [[['./y.cjs'], ''], [[path.join(SCRATCH, 'y.cjs'), '-r', 'x.cjs', '--import=x.mjs', '--', '--env'], '-r x.cjs --import=x.mjs -- --env'], [['./y.cjs', 'inspect'], 'inspect']] as const) {
			rmSync(entry(), { force: true });
			expect(run(...args).status, args.join(' ')).toBe(0);
			expect(readFileSync(entry(), 'utf8')).toBe(seen);
		}
	});
});

describe("WHOLE_LINE_OPTIONS is the set of options the Node these tests run reads from its whole command line (escalation)", () => {
	// Every name in Node's own option table (internal/options, behind --expose-internals) and every alias, after the
	// entry and after a `--`: bare, =<file>, <file> as the next argument, and with a suffix, so that a scan by prefix
	// shows too. <file> is a dotenv file that sets NODE_OPTIONS, and the cwd holds a node.config.json that is not JSON.
	// A form acts when Node's option values, environment, title, exit status, stdout or stderr, or the files in the cwd,
	// differ from a run without it. The forms the reader does not refuse go in one run, split until it names any that act.
	const SCAN = path.join(SCRATCH, 'node-scan');
	const DUMP = path.join(REPO, '.local/hosting-probe/deployment', `node-dump-${process.pid}.cjs`);
	afterAll(() => rmSync(DUMP, { force: true }));
	const dump = () => {
		mkdirSync(path.dirname(DUMP), { recursive: true });
		writeFileSync(DUMP, "const o = require('internal/options');\nconst opts = {};\nfor (const k of o.getCLIOptionsInfo().options.keys()) opts[k] = o.getOptionValue(k);\nconsole.log(JSON.stringify({ opts, env: Object.fromEntries(Object.entries(process.env).sort()), execArgv: process.execArgv, title: process.title }));\n");
	};
	let runs = 0;
	const observe = (args: string[]) => {
		const cwd = path.join(SCAN, `run-${runs++}`);
		mkdirSync(cwd, { recursive: true });
		const file = path.join(cwd, 'options.env');
		writeFileSync(file, 'NODE_OPTIONS=--title=cc-scan\nCC_SCAN=1\n');
		writeFileSync(path.join(cwd, 'node.config.json'), '{ not json');
		const r = spawnSync(NODE, ['--expose-internals', DUMP, ...args.map((a) => a.replaceAll('<file>', file))], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd }, maxBuffer: 16 << 20 });
		const seen = JSON.stringify({ status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, files: readdirSync(cwd).sort(), file: readFileSync(file, 'utf8') }).replaceAll(cwd, '<cwd>');
		rmSync(cwd, { recursive: true, force: true });
		return seen;
	};
	const table = (): string[] => {
		const r = spawnSync(NODE, ['--expose-internals', '-p', "const i = require('internal/options').getCLIOptionsInfo(); JSON.stringify([...i.options.keys(), ...i.aliases.keys()])"], { encoding: 'utf8' });
		if (r.status !== 0) throw new Error(`${NODE} gave no option table through --expose-internals and internal/options, so the scan cannot run: ${r.stderr.slice(0, 300)}`);
		return JSON.parse(r.stdout);
	};
	const forms = (name: string) => {
		const base = name.replace(/=$/, '');
		return [[base], [`${base}=<file>`], [base, '<file>'], [`${base}x=<file>`], [`${base}-x`]];
	};
	const refusedByReader = (form: string[]) => form.some((arg) => WHOLE_LINE_OPTIONS.some((option) => arg.startsWith(option)));
	const placements = { 'after the entry': (args: string[]) => args, "after the entry's --": (args: string[]) => ['--', ...args] };

	test('no option the reader lets through acts after the entry or after a --', () => {
		dump();
		const names = table();
		expect(names.length).toBeGreaterThan(200);
		const group = [...new Set(names)].flatMap(forms).filter((f) => !refusedByReader(f));
		const acting: string[] = [];
		for (const [where, place] of Object.entries(placements)) {
			const control = observe(place([]));
			const split = (g: string[][]): string[][] => (!g.length || observe(place(g.flat())) === control ? [] : g.length === 1 ? g : [...split(g.slice(0, g.length >> 1)), ...split(g.slice(g.length >> 1))]);
			acting.push(...split(group).map((f) => `${f.join(' ')} (${where})`));
		}
		expect(acting, `Node ${NODE} acts on options the reader does not refuse; add them to WHOLE_LINE_OPTIONS`).toEqual([]);
	});

	test('every one of them that this Node has acts there, so the list is not stale and the scan can see one', () => {
		dump();
		const names = new Set(table());
		const known = WHOLE_LINE_OPTIONS.filter((option) => names.has(option));
		expect(known).toContain('--env-file');
		const acts = (option: string) => Object.values(placements).some((place) => {
			const control = observe(place([]));
			return forms(option).some((f) => observe(place(f)) !== control);
		});
		expect(known.filter((option) => !acts(option)), 'in WHOLE_LINE_OPTIONS, but this Node does not act on it after the entry').toEqual([]);
	});
});
