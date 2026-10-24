import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Reviewed historical input, not a replacement for the current checkout's judging policy.
const SOURCE = '105c4fa8ccf9e5850d082a502ef2705a85d70301';
const MANIFEST_SHA256 = 'a918e058fbd538383467d73a4844a1bb8356bf58aad5c2ba71537902ba99d79e';
const ASSETS = ['test_guard.mjs', 'agent_tools.py', '_common.sh', 'skills.lock.json', 'test-guard', 'fix-round-guard'];
const fail = (): never => { throw new Error('canonical DEV105 reader fixture integrity failure'); };

// Input validation follows Git semantics: only the owner-executable bit is recorded (100644/100755);
// group/other bits come from the cloner's umask. Special bits are always refused; owner must be able to read.
function regularFile(path: string, mode: number): Buffer {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7000) !== 0 || (stat.mode & 0o400) === 0
		|| ((stat.mode & 0o100) !== 0) !== ((mode & 0o100) !== 0)) fail();
	return readFileSync(path);
}

/** Materialize only the six byte/mode-frozen readers. Never fetch or substitute current readers. */
export function materializeDev105Reader(destination: string, sourceCommit: string, fixtureRoot = import.meta.dirname): void {
	const rootStat = lstatSync(fixtureRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || sourceCommit !== SOURCE) fail();
	const manifestBytes = regularFile(join(fixtureRoot, 'manifest.json'), 0o644);
	if (createHash('sha256').update(manifestBytes).digest('hex') !== MANIFEST_SHA256) fail();
	const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
		commit: string; assets: { path: string; blob: string; sha256: string; mode: string }[];
	};
	if (manifest.commit !== SOURCE || manifest.assets.length !== ASSETS.length) fail();
	// Verify every input before writing any executable reader into the synthetic workspace.
	const verified = manifest.assets.map((asset, index) => {
		const name = ASSETS[index];
		if (!name) fail();
		if (asset.path !== `scripts/agent-tools/${name}` || basename(asset.path) !== name
			|| !['100644', '100755'].includes(asset.mode)) fail();
		const mode = Number.parseInt(asset.mode.slice(-3), 8);
		const bytes = regularFile(join(fixtureRoot, name), mode);
		if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256
			|| createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== asset.blob) fail();
		return { name, bytes, mode };
	});
	mkdirSync(destination, { recursive: true });
	const destinationStat = lstatSync(destination);
	if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink() || readdirSync(destination).length) fail();
	for (const { name, bytes, mode } of verified) {
		writeFileSync(join(destination, name), bytes, { flag: 'wx', mode });
		chmodSync(join(destination, name), mode);
	}
}
