// A fresh production build of one exact revision in an isolated directory, never in the caller's worktree:
// `git archive <rev>` into <dir>/src, the worktree's installed node_modules reflinked (or copied) next to it after
// checking that bun.lock is byte-identical, then `bun run --bun build` there. The build stamp records the revision.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BUN } from './server.mjs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

export function isolatedBuild({ repo, rev = 'HEAD', dir, log = (m) => console.error(m) }) {
	const full = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', `${rev}^{commit}`], { encoding: 'utf8' }).trim();
	const src = join(dir, 'src');
	rmSync(src, { recursive: true, force: true });
	mkdirSync(src, { recursive: true });
	execFileSync('bash', ['-c', `git -C "$0" archive --format=tar "$1" | tar -x -C "$2"`, repo, full, src]);
	if (!existsSync(join(src, 'bun.lock'))) throw new Error(`${full} has no bun.lock`);
	if (sha(join(src, 'bun.lock')) !== sha(join(repo, 'bun.lock'))) throw new Error(`bun.lock at ${full} differs from the installed one in ${repo}; install that revision separately`);
	const cp = spawnSync('cp', ['-a', '--reflink=auto', join(repo, 'node_modules'), join(src, 'node_modules')], { encoding: 'utf8' });
	if (cp.status !== 0) throw new Error(`copying node_modules failed: ${cp.stderr}`);
	const t0 = performance.now();
	const b = spawnSync(BUN, ['run', '--bun', 'build'], { cwd: src, encoding: 'utf8', env: { ...process.env, CLEARCASE_SOURCE_REVISION: full } });
	log(`isolated build of ${full.slice(0, 12)} in ${src}: exit ${b.status} (${Math.round(performance.now() - t0)} ms)`);
	if (b.status !== 0) throw new Error(`build failed:\n${(b.stdout + b.stderr).slice(-3000)}`);
	const stamp = JSON.parse(readFileSync(join(src, 'build', 'clearcase-build.json'), 'utf8'));
	return { revision: full, src, buildDir: join(src, 'build'), stamp, buildMs: performance.now() - t0, lockSha256: sha(join(src, 'bun.lock')) };
}
