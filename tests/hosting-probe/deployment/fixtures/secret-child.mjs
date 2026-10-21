// The one child of the secrets reader (GRS-107 secrets.test.ts). `env` mode reads SYNTHETIC_TOKEN from process.env (the
// preload served it); `fd` mode takes it off the pipe itself. It reports hashes and booleans, never the value: whether
// its own initial environment, its enumerable env or a JSON copy holds the value, and what each grandchild got through
// each way of starting one.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { takeSecrets } from '../../../../deploy/probes/secrets-child.mjs';

const mode = process.argv[2];
const link = (fd) => {
	try {
		return readlinkSync(`/proc/self/fd/${fd}`);
	} catch {
		return 'closed';
	}
};
// fd mode: the reader's pipe, before this child takes the values off it; env mode: what fd 3 is after the preload took them
const fd3AtStart = link(3);
const value = mode === 'fd' ? takeSecrets().get('SYNTHETIC_TOKEN') : process.env.SYNTHETIC_TOKEN;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const grandchild = path.join(import.meta.dirname, 'secret-grandchild.mjs');
const report = (via, out) => {
	const g = JSON.parse(out);
	return { via, key: g.keys.includes('SYNTHETIC_TOKEN'), value: value !== undefined && g.hashes.includes(sha(value)), pipe: g.fds.includes(fd3AtStart) };
};
const asyncChild = (env) =>
	new Promise((resolve) => {
		let out = '';
		const c = spawn(process.execPath, [grandchild], { env, stdio: ['ignore', 'pipe', 'inherit'] });
		c.stdout.on('data', (d) => (out += d));
		c.on('close', () => resolve(out));
	});
const shell = spawnSync('sh', ['-c', 'tr "\\0" "\\n" < /proc/self/environ; ls -l /proc/self/fd/'], { encoding: 'utf8' }).stdout;
const grandchildren = [
	report('spawnSync, inherited env', spawnSync(process.execPath, [grandchild], { encoding: 'utf8' }).stdout),
	report('execFileSync, inherited env', execFileSync(process.execPath, [grandchild], { encoding: 'utf8' })),
	report('spawn, inherited env', await asyncChild(undefined)),
	report('spawn, { ...process.env }', await asyncChild({ ...process.env })),
	report('spawn, Object.assign copy', await asyncChild(Object.assign({}, process.env))),
	{ via: 'sh -c, /proc/self/environ', key: /^SYNTHETIC_TOKEN=/m.test(shell), value: value !== undefined && shell.includes(value), pipe: shell.includes(fd3AtStart) },
];
const environ = readFileSync('/proc/self/environ', 'utf8');
console.log(JSON.stringify({
	sees: value === undefined ? null : sha(value),
	fd3AtStart: fd3AtStart.replace(/:\[\d+\]$/, ''),
	fd3AfterTake: fd3AtStart !== 'closed' && link(3) === fd3AtStart ? 'still open' : 'closed',
	initialEnviron: value !== undefined && environ.includes(value),
	enumerable: Object.keys(process.env).includes('SYNTHETIC_TOKEN'),
	jsonCopy: value !== undefined && JSON.stringify(process.env).includes(value),
	fdVariable: 'CLEARCASE_SECRETS_FD' in process.env,
	grandchildren,
}));
