import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { materializeDev105Reader } from './fixtures/reviewed-python-dev105/materialize';

const SOURCE = '105c4fa8ccf9e5850d082a502ef2705a85d70301';
const FIXTURE = join(import.meta.dirname, 'fixtures/reviewed-python-dev105');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'cc-dev105-assets-')); roots.push(root);
	const source = join(root, 'source'); cpSync(FIXTURE, source, { recursive: true });
	return { source, target: join(root, 'trusted') };
}

it('materializes exactly the canonical old reader bytes, Git blobs and executable modes without history', () => {
	const { source, target } = workspace();
	materializeDev105Reader(target, SOURCE, source);
	const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
	expect(manifest.commit).toBe(SOURCE);
	expect(manifest.assets).toHaveLength(6);
	for (const asset of manifest.assets) {
		const name = asset.path.slice('scripts/agent-tools/'.length);
		const bytes = readFileSync(join(target, name));
		expect(bytes.equals(readFileSync(join(source, name)))).toBe(true);
		expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
		expect(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')).toBe(asset.blob);
		expect(lstatSync(join(target, name)).mode & 0o777).toBe(Number.parseInt(asset.mode.slice(-3), 8));
	}
});

it.each(['commit', 'path', 'order', 'hash', 'extra'])('refuses an altered %s manifest before writing readers', variant => {
	const { source, target } = workspace();
	const path = join(source, 'manifest.json');
	const manifest = JSON.parse(readFileSync(path, 'utf8'));
	if (variant === 'commit') manifest.commit = '0'.repeat(40);
	if (variant === 'path') manifest.assets[0].path = '../outside';
	if (variant === 'order') manifest.assets.reverse();
	if (variant === 'hash') manifest.assets[0].sha256 = '0'.repeat(64);
	if (variant === 'extra') manifest.assets.push(manifest.assets[0]);
	writeFileSync(path, JSON.stringify(manifest));
	expect(() => materializeDev105Reader(target, SOURCE, source)).toThrow();
	expect(existsSync(target)).toBe(false);
});

it.each(['missing', 'bytes', 'mode', 'privileged-mode', 'symlink'])('refuses a %s asset before writing any executable reader', variant => {
	const { source, target } = workspace();
	const path = join(source, 'fix-round-guard');
	if (variant === 'missing') rmSync(path);
	if (variant === 'bytes') writeFileSync(path, readFileSync(path, 'utf8') + '\n');
	if (variant === 'mode') chmodSync(path, 0o644);
	if (variant === 'privileged-mode') chmodSync(path, 0o4755);
	if (variant === 'symlink') { rmSync(path); symlinkSync(join(FIXTURE, 'fix-round-guard'), path); }
	expect(() => materializeDev105Reader(target, SOURCE, source)).toThrow();
	expect(existsSync(target)).toBe(false);
});

it('refuses a substituted expected source commit', () => {
	const { source, target } = workspace();
	expect(() => materializeDev105Reader(target, '0'.repeat(40), source)).toThrow();
	expect(existsSync(target)).toBe(false);
});

it('refuses to overwrite an existing reader destination', () => {
	const { source, target } = workspace();
	mkdirSync(target); writeFileSync(join(target, 'test-guard'), 'sentinel');
	expect(() => materializeDev105Reader(target, SOURCE, source)).toThrow();
	expect(readFileSync(join(target, 'test-guard'), 'utf8')).toBe('sentinel');
});

it.each(['0002', '0077'])('accepts a true Git checkout of the fixture made under umask %s', umask => {
	const root = mkdtempSync(join(tmpdir(), 'cc-dev105-umask-')); roots.push(root);
	const run = (cwd: string, script: string) => execFileSync('sh', ['-c', script], {
		cwd, stdio: 'pipe', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
	});
	const origin = join(root, 'origin'); mkdirSync(origin);
	cpSync(FIXTURE, join(origin, 'fx'), { recursive: true });
	run(origin, 'git init -q . && git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m fx');
	run(root, `umask ${umask} && git clone -q file://${origin} checkout`);
	const source = join(root, 'checkout/fx');
	expect(lstatSync(join(source, 'test-guard')).mode & 0o111).not.toBe(0);
	expect(lstatSync(join(source, 'agent_tools.py')).mode & 0o111).toBe(0);
	const target = join(root, 'trusted');
	materializeDev105Reader(target, SOURCE, source);
	expect(lstatSync(join(target, 'test-guard')).mode & 0o777).toBe(0o755);
	expect(lstatSync(join(target, 'agent_tools.py')).mode & 0o777).toBe(0o644);
});
