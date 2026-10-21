// The revision a GRS-21 result was produced at: the checked-out HEAD, whether the tree was clean, and the revision the
// build under test was made from (build/clearcase-build.json). Written into acceptance/summary.json and layout.json;
// scripts/verify/matrix.mjs refuses any input whose stamp is not the SHA it is written for.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitEnv } from '../browser-lock.mjs';

/** `{ head, dirty, build: { revision, dirty } | null }`; head is null when git cannot say. */
export function revisionStamp(root, buildDir = join(root, 'build')) {
	const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', env: gitEnv() });
	const head = git('rev-parse', 'HEAD');
	const status = git('status', '--porcelain', '--untracked-files=normal');
	let build = null;
	try { const b = JSON.parse(readFileSync(join(buildDir, 'clearcase-build.json'), 'utf8')); build = { revision: b.revision ?? null, dirty: b.dirty ?? null }; } catch { /* no stamp: the matrix blocks */ }
	return { head: head.status === 0 ? head.stdout.trim() : null, dirty: status.status === 0 ? status.stdout.trim() !== '' : null, build };
}
