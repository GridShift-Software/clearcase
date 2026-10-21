// The one way a ClearCase run reads a credential (GRS-107; the 17 October secrets decision on GRS-26). It reads
// $HOME/.config/clearcase/secrets/<name>.env and nothing else, refuses that directory unless it is a real directory the
// caller owns with no group or other access (700 or stricter) and the file unless it is a regular file the caller owns
// with mode 600 or stricter, never prints a value, and hands the values to exactly one child over a pipe on fd 3, never
// through an environment:
//
//   bun deploy/probes/secrets.ts run <name> [--keys K1,K2] [--to fd|env] -- <command> [args...]
//
// The command must be a real Node (its resolved file is named node; Bun's `node` stand-in is not), in both modes, and
// anything else is refused before it starts. The reader adds `--import <preload>`, and the preload takes the values off
// fd 3, closes fd 3 and deletes CLEARCASE_SECRETS_FD before the child's own code runs, so no process the child starts
// can inherit the pipe or the variable, whether or not the child ever asks for the values.
//   --to fd (the default): the preload keeps the values in memory for the child's one call to takeSecrets()
//     in secrets-child.mjs.
//   --to env: for a Node tool that reads its credential from process.env (cf, Wrangler, Void). The preload serves the
//     values from process.env without making them enumerable, so neither the tool's children (whose environment Node
//     builds from the enumerable keys) nor a copy of process.env carries them. A tool that names a key and passes it on
//     by hand still can, and so can a child that reads takeSecrets() and hands the values on.
// What holds: no value reaches argv, an inherited environment, a log, an error or a receipt, and no descendant inherits fd 3.
// What does not: the check that the command is Node reads its resolved file name and does not run it, so a program that
// is not Node but is named node gets fd 3 open (it is the caller's own command); a process of the same uid can read the
// file itself, ptrace the child, or swap a directory above the secrets directory between the check and the open.
//
// Exit codes: the child's, or 2 when the reader refuses (the message names the path, mode, key or line, never a value).
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { constants as os } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const ENV_PRELOAD = path.join(import.meta.dirname, 'secrets-env.mjs');
export const FD_PRELOAD = path.join(import.meta.dirname, 'secrets-fd.mjs');

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
	let dirStat, real: string;
	try {
		dirStat = lstatSync(dir);
		real = realpathSync(dir);
	} catch {
		throw new Refusal(`${dir} does not exist`);
	}
	if (!dirStat.isDirectory()) throw new Refusal(`${dir} is not a directory (a symlink is refused)`);
	private_(dir, dirStat, '700');
	// Resolve the directory once and use that path for the file, so a link in the path is not followed again at the open.
	const file = path.join(real, `${a.name}.env`);
	let before;
	try {
		before = lstatSync(file);
	} catch (e) {
		throw new Refusal(`${file} cannot be opened (${(e as NodeJS.ErrnoException).code}); a symlink is refused`);
	}
	if (before.isSymbolicLink()) throw new Refusal(`${file} is a symlink; a symlink is refused`);
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (e) {
		throw new Refusal(`${file} cannot be opened (${(e as NodeJS.ErrnoException).code}); a symlink is refused`);
	}
	let text: string;
	try {
		const st = fstatSync(fd);
		if (st.dev !== before.dev || st.ino !== before.ino) throw new Refusal(`${file} changed between the check and the open`);
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

/** The file `command` names, looked up on `searchPath` when it has no slash: an executable regular file, or null. Nothing is run. */
function resolveCommand(command: string, searchPath: string | undefined): string | null {
	const candidates = command.includes('/') ? [path.resolve(command)] : (searchPath ?? '/usr/bin:/bin').split(':').filter(Boolean).map((d) => path.resolve(d, command));
	return (
		candidates.find((c) => {
			try {
				accessSync(c, constants.X_OK);
				return statSync(c).isFile();
			} catch {
				return false;
			}
		}) ?? null
	);
}

/** True when the file really is Node, judged by its resolved name and never by running it: Bun's `node` stand-in resolves to bun. */
const isRealNode = (file: string) => /^node(js)?\d*(\.\d+)*$/.test(path.basename(realpathSync(file)));

/**
 * Runs `command`, a real Node, with the secrets on its fd 3 and a preload that takes them off it, and resolves with its
 * exit code. The child's environment is the caller's, less any variable named like a secret. Throws a Refusal, before
 * anything starts, for a command that is not found, not executable or not Node.
 */
export function runWithSecrets(a: { secrets: Map<string, string>; to: 'fd' | 'env'; command: string[]; env?: NodeJS.ProcessEnv }): Promise<number> {
	const [cmd, ...args] = a.command;
	if (!cmd) throw new Refusal('no command after --');
	const env = Object.fromEntries(Object.entries(a.env ?? process.env).filter(([k]) => !a.secrets.has(k) && k !== 'NODE_OPTIONS')) as Record<string, string>;
	const file = resolveCommand(cmd, env.PATH);
	if (!file) throw new Refusal(`${cmd} cannot be started: not found, not executable, or not a file`);
	if (!isRealNode(file)) throw new Refusal(`--to ${a.to} runs a Node tool, and ${cmd} is not a real Node`);
	env.CLEARCASE_SECRETS_FD = '3'; // read and deleted by the preload before the child's own code runs
	const child = spawn(file, [`--import=${a.to === 'env' ? ENV_PRELOAD : FD_PRELOAD}`, ...args], { env, stdio: ['inherit', 'inherit', 'inherit', 'pipe'] });
	const forward = (signal: NodeJS.Signals) => child.kill(signal);
	const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
	for (const s of signals) process.on(s, forward);
	return new Promise((resolve, reject) => {
		const pipe = child.stdio[3] as NodeJS.WritableStream | null;
		pipe?.on('error', () => {}); // a child that exits without reading closes the pipe; its exit code tells the caller
		pipe?.end([...a.secrets].map(([k, v]) => `${k}=${v}\n`).join(''));
		child.once('error', (e) => {
			for (const s of signals) process.off(s, forward);
			reject(new Refusal(`${cmd} cannot be started (${(e as NodeJS.ErrnoException).code ?? 'error'})`));
		});
		child.once('close', (code, signal) => {
			for (const s of signals) process.off(s, forward);
			resolve(code ?? (signal ? 128 + os.signals[signal] : 1));
		});
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2);
	const dash = argv.indexOf('--');
	const [command, name, ...opts] = dash < 0 ? argv : argv.slice(0, dash);
	const usage = 'usage: secrets.ts run <name> [--keys K1,K2] [--to fd|env] -- <command> [args...]';
	const given = new Map<string, string>();
	const opt = (flag: string) => given.get(flag);
	try {
		if (command !== 'run' || !name || dash < 0) throw new Refusal(usage);
		// Each option once and with its value: a dropped --keys value must not widen the read to every key.
		for (let i = 0; i < opts.length; i += 2) {
			const [flag, value] = [opts[i]!, opts[i + 1]];
			if (!['--keys', '--to'].includes(flag) || value === undefined || value.startsWith('--') || given.has(flag)) throw new Refusal(usage);
			given.set(flag, value);
		}
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
