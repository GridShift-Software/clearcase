// Shared runtime plumbing for the real-v5 lanes (tests/e2e/pilot/v5-lanes.mjs) and the CC-03 measurement
// (scripts/measure/cc03.mjs): self-isolation into the offline namespace, host and tool identities, hashing and the
// fixture-tree stamp. Nothing here knows any case value; every path and expectation comes from the local config.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { readStamp } from '../lib/fresh-build.ts';

export const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
export const OFFLINE_SH = join(REPO, 'tests', 'e2e', 'pilot', 'offline.sh');
/** Ports reserved for these runners: servers 43700-43898, canary 43899. */
export const PORTS = { first: 43700, last: 43898, canary: 43899 };

const which = (c) => spawnSync('bash', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
const chromePath = () => process.env.CLEARCASE_CHROMIUM ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`;

/**
 * Outside the namespace: check the tools, then re-exec `bun <self> <args>` as
 *   unshare -rn env OUTER_UID=$(id -u) OUTER_GID=$(id -g) tests/e2e/pilot/offline.sh bun <self> <args>
 * and exit with its status. Inside (CLEARCASE_OFFLINE=1) it returns. There is no online fallback.
 */
export function ensureOffline(self, { needChromium = true } = {}) {
	if (process.env.CLEARCASE_OFFLINE === '1') {
		if (process.env.CANARY_PORT !== String(PORTS.canary)) { console.error(`CANARY_PORT must be ${PORTS.canary} inside the namespace`); process.exit(2); }
		return;
	}
	const missing = [];
	for (const t of ['unshare', 'ip']) if (!which(t)) missing.push(t);
	if (needChromium && !existsSync(chromePath())) missing.push(`Chromium (${chromePath()}; set CLEARCASE_CHROMIUM)`);
	if (!process.versions.bun) missing.push('Bun (run with bun)');
	if (missing.length) { console.error(`missing prerequisites: ${missing.join(', ')}; refusing to run (no online fallback)`); process.exit(2); }
	const uid = process.getuid(), gid = process.getgid();
	const args = ['-rn', 'env', `OUTER_UID=${uid}`, `OUTER_GID=${gid}`, `CANARY_PORT=${PORTS.canary}`, OFFLINE_SH, process.execPath, self, ...process.argv.slice(2)];
	console.error(`re-exec offline: unshare ${args.join(' ')}`);
	const r = spawnSync('unshare', args, { stdio: 'inherit', cwd: process.cwd() });
	if (r.error) { console.error(`unshare failed: ${r.error.message}`); process.exit(2); }
	process.exit(r.status ?? 1);
}

export const sha256File = (p) => new Promise((res, rej) => {
	const h = createHash('sha256');
	createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});
/** sha256, CRC-32 (hex, 8 digits) and size of a file, streamed. */
export const digestFile = (p) => new Promise((res, rej) => {
	const h = createHash('sha256');
	let c = 0, n = 0;
	createReadStream(p).on('data', (d) => { h.update(d); c = crc32(d, c); n += d.length; }).on('end', () => res({ sha256: h.digest('hex'), crc32: (c >>> 0).toString(16).padStart(8, '0'), size: n })).on('error', rej);
});
export const sha256Bytes = (b) => createHash('sha256').update(b).digest('hex');

/** Names, sizes, mtimes and modes of every entry: proves the fixture tree is unchanged by a run. */
export function treeStamp(dir) {
	const p = spawnSync('find', [dir, '-printf', '%P|%s|%T@|%m\n'], { encoding: 'utf8', maxBuffer: 1 << 28 });
	if (p.status !== 0) throw new Error(`find ${dir} failed`);
	return sha256Bytes(p.stdout.split('\n').sort().join('\n'));
}

export function gitIdentity(repo = REPO) {
	const g = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout;
	const status = g(['status', '--porcelain']).split('\n').filter(Boolean);
	return { head: g(['rev-parse', 'HEAD']).trim(), branch: g(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), dirty: status.length > 0, dirtyPaths: status.map((l) => l.slice(3)) };
}

export function hostIdentity() {
	const cpus = os.cpus();
	return {
		hostname: os.hostname(), cpu: cpus[0]?.model ?? null, logicalCpus: cpus.length, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
		kernel: `${os.type()} ${os.release()}`, platform: process.platform, arch: process.arch,
	};
}

export function bunIdentity() {
	const v = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim();
	return { path: process.execPath, version: v, revision: spawnSync(process.execPath, ['--revision'], { encoding: 'utf8' }).stdout.trim() };
}

export function chromiumIdentity() {
	const p = chromePath();
	let version = null;
	try { version = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim(); } catch (e) { version = `unknown (${e.message.slice(0, 120)})`; }
	return { path: p, version };
}

/** Which build the run uses: E2E_ROOT/E2E_BUILD_DIR, else the worktree's ./build. */
export function buildFromEnv() {
	const root = resolve(process.env.E2E_ROOT ?? REPO);
	const buildDir = resolve(process.env.E2E_BUILD_DIR ?? join(root, 'build'));
	const stampFile = join(buildDir, 'clearcase-build.json');
	if (!existsSync(join(buildDir, 'handler.js')) || !existsSync(stampFile)) return { root, buildDir, stamp: null, problem: `no production build at ${buildDir} (run bun run --bun build, or pass --isolated)` };
	return { root, buildDir, stamp: readStamp(buildDir), problem: null };
}

/** Listening TCP sockets on the given ports, from `ss` (iproute2) inside this namespace. */
export function listeners(ports) {
	const r = spawnSync('ss', ['-ltnH'], { encoding: 'utf8' });
	if (r.status !== 0) return { error: r.stderr || 'ss failed' };
	return r.stdout.split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)[3]).filter((a) => ports.some((p) => a.endsWith(`:${p}`)));
}

export const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
export const stats = (xs) => xs.length ? { n: xs.length, minMs: +Math.min(...xs).toFixed(1), p50Ms: +q(xs, 0.5).toFixed(1), p95Ms: +q(xs, 0.95).toFixed(1), maxMs: +Math.max(...xs).toFixed(1), meanMs: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) } : { n: 0 };
