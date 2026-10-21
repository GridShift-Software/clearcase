// The one way a ClearCase run reads a credential (GRS-107; the 17 October secrets decision on GRS-26). It reads
// $HOME/.config/clearcase/secrets/<name>.env and nothing else, refuses that directory unless it is a real directory the
// caller owns with no group or other access (700 or stricter) and the file unless it is a regular file the caller owns
// with mode 600 or stricter, never prints a value, and hands the values to exactly one child over a pipe on fd 3, never
// through an environment, so the child's grandchildren cannot inherit them:
//
//   bun deploy/probes/secrets.ts run <name> [--keys K1,K2] [--to fd|env] -- <command> [args...]
//
// --to fd (the default): the child reads the pipe itself, through takeSecrets() in secrets-child.mjs.
// --to env: for a Node tool that reads its credential from process.env (cf, Wrangler, Void). The command must be a real
// Node; the reader adds --import secrets-env.mjs, which takes the values off the pipe and serves them from process.env
// without making them enumerable, so neither the tool's children (whose environment Node builds from the enumerable
// keys) nor a copy of process.env carries them. A tool that names a key and passes it on by hand still can.
//
// Exit codes: the child's, or 2 when the reader refuses (the message names the path, mode, key or line, never a value).
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { constants as os } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const ENV_PRELOAD = path.join(import.meta.dirname, 'secrets-env.mjs');

export class Refusal extends Error {}

/** The secrets directory under `home`: never configurable, so a caller cannot point the reader at another file. */
export const secretsDir = (home: string) => path.join(home, '.config', 'clearcase', 'secrets');

function private_(what: string, st: { uid: number; mode: number }, limit: string) {
	if (st.uid !== process.getuid!()) throw new Refusal(`${what} is owned by uid ${st.uid}, not the caller`);
	if (st.mode & 0o077) throw new Refusal(`${what} has mode ${(st.mode & 0o777).toString(8)}; it must be ${limit} or stricter`);
}

/** Reads and parses one secrets file; every refusal names the path, a mode, a key or a line number, never a value. */
export function readSecrets(a: { home: string | undefined; name: string; keys?: string[] }): Map<string, string> {
	if (!a.home || !path.isAbsolute(a.home)) throw new Refusal('HOME is not an absolute path');
	if (!SECRET_NAME.test(a.name)) throw new Refusal(`${JSON.stringify(a.name)} is not a secrets file name ([a-z0-9-])`);
	const dir = secretsDir(a.home);
	const file = path.join(dir, `${a.name}.env`);
	let dirStat;
	try {
		dirStat = lstatSync(dir);
	} catch {
		throw new Refusal(`${dir} does not exist`);
	}
	if (!dirStat.isDirectory()) throw new Refusal(`${dir} is not a directory (a symlink is refused)`);
	private_(dir, dirStat, '700');
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (e) {
		throw new Refusal(`${file} cannot be opened (${(e as NodeJS.ErrnoException).code}); a symlink is refused`);
	}
	let text: string;
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Refusal(`${file} is not a regular file`);
		private_(file, st, '600');
		text = readFileSync(fd, 'utf8');
	} finally {
		closeSync(fd);
	}
	const secrets = new Map<string, string>();
	text.split('\n').forEach((line, i) => {
		if (!line.trim() || line.trimStart().startsWith('#')) return;
		const eq = line.indexOf('=');
		const key = eq < 0 ? '' : line.slice(0, eq);
		if (!KEY.test(key)) throw new Refusal(`${file} line ${i + 1} is not KEY=VALUE`);
		if (secrets.has(key)) throw new Refusal(`${file} sets ${key} twice`);
		if (line.slice(eq + 1).includes('\r')) throw new Refusal(`${file} line ${i + 1} (${key}) has a carriage return`);
		secrets.set(key, line.slice(eq + 1));
	});
	if (!a.keys) return secrets;
	const missing = a.keys.filter((k) => !secrets.has(k));
	if (missing.length) throw new Refusal(`${file} has no ${missing.join(', ')}`);
	return new Map(a.keys.map((k) => [k, secrets.get(k)!]));
}

/** True when `command` runs real Node (not Bun's `node` stand-in), which --to env needs for its preload. */
function isRealNode(command: string): boolean {
	const r = spawnSync(command, ['-p', 'typeof Bun === "undefined" && process.release.name === "node"'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
	return r.status === 0 && r.stdout.trim() === 'true';
}

/** Runs `command` with the secrets on its fd 3 and resolves with its exit code. The child's environment is the caller's, less any variable named like a secret. */
export function runWithSecrets(a: { secrets: Map<string, string>; to: 'fd' | 'env'; command: string[]; env?: NodeJS.ProcessEnv }): Promise<number> {
	const [cmd, ...args] = a.command;
	if (!cmd) throw new Refusal('no command after --');
	if (a.to === 'env' && !isRealNode(cmd)) throw new Refusal(`--to env runs a Node tool, and ${cmd} is not a real Node`);
	const env = Object.fromEntries(Object.entries(a.env ?? process.env).filter(([k]) => !a.secrets.has(k) && k !== 'NODE_OPTIONS')) as Record<string, string>;
	env.CLEARCASE_SECRETS_FD = '3';
	const argv = a.to === 'env' ? [`--import=${ENV_PRELOAD}`, ...args] : args;
	const child = spawn(cmd, argv, { env, stdio: ['inherit', 'inherit', 'inherit', 'pipe'] });
	const pipe = child.stdio[3] as NodeJS.WritableStream;
	pipe.on('error', () => {}); // a child that exits without reading closes the pipe; its exit code tells the caller
	pipe.end([...a.secrets].map(([k, v]) => `${k}=${v}\n`).join(''));
	const forward = (signal: NodeJS.Signals) => child.kill(signal);
	for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, forward);
	return new Promise((resolve) =>
		child.once('close', (code, signal) => {
			for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(s, forward);
			resolve(code ?? (signal ? 128 + os.signals[signal] : 1));
		}),
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2);
	const dash = argv.indexOf('--');
	const [command, name, ...opts] = dash < 0 ? argv : argv.slice(0, dash);
	const opt = (flag: string) => {
		const i = opts.indexOf(flag);
		return i < 0 ? undefined : opts[i + 1];
	};
	try {
		if (command !== 'run' || !name || dash < 0) throw new Refusal('usage: secrets.ts run <name> [--keys K1,K2] [--to fd|env] -- <command> [args...]');
		const to = opt('--to') ?? 'fd';
		if (to !== 'fd' && to !== 'env') throw new Refusal('--to is fd or env');
		const secrets = readSecrets({ home: process.env.HOME, name, keys: opt('--keys')?.split(',') });
		process.exitCode = await runWithSecrets({ secrets, to, command: argv.slice(dash + 1) });
	} catch (e) {
		if (!(e instanceof Refusal)) throw e;
		console.error(`secrets: refused: ${e.message}`);
		process.exitCode = 2;
	}
}
