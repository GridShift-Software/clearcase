import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { scanPaths } from '../../../deploy/probes/scan.ts';

// The final summary refers to this manifest, so exclude only that summary and its failure report.
// summary-scan.json is the pre-scan snapshot and remains immutable for independent verification.
export function artifacts(runDir, buildDir) {
	const out = [];
	function walk(root, name, at = root) {
		if (!existsSync(at)) return;
		if (lstatSync(at).isSymbolicLink()) throw new Error('artifact symlink refused');
		if (lstatSync(at).isDirectory()) {
			for (const e of readdirSync(at).sort()) {
				const rel = path.relative(root, path.join(at, e)).split(path.sep).join('/');
				if (name === 'run' && ['summary.json', 'failure.json'].includes(rel)) continue;
				if (name === 'run' && /^(?:a\/|c\/)?cache\/bun$/.test(rel)) continue;
				walk(root, name, path.join(at, e));
			}
		} else {
			const bytes = readFileSync(at);
			out.push({ root: name, path: path.relative(root, at).split(path.sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
		}
	}
	walk(runDir, 'run'); walk(buildDir, 'build');
	return out;
}
export function scanArtifacts(runDir, buildDir, canaries) {
	const manifest = artifacts(runDir, buildDir);
	const scan = scanPaths({ roots: manifest.map((f) => path.join(f.root === 'run' ? runDir : buildDir, f.path)), canaries });
	return { files: scan.files, hits: scan.hits.length, manifest };
}
export function completeCoverage(manifest) {
	const has = (root, match) => manifest.some((f) => f.root === root && match.test(f.path));
	return has('build', /^cloudflare\/_worker\.js$/) && has('run', /^logs\/build\.log$/) && has('run', /^summary-scan\.json$/) &&
		['a', 'c'].every((c) => has('run', new RegExp(`^${c}/logs/serve-\\d+\\.log$`)) && has('run', new RegExp(`^${c}/persist/client/`)) && has('run', new RegExp(`^${c}/persist/staff/`)));
}
