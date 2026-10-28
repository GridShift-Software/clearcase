import type { BundlePathsShard } from '../payloads/bundles.ts';
import { linkedName } from './caselines.ts';
export function bundleLinks(shard: BundlePathsShard, caseId: string) {
	const files: Record<string, string> = {},
		downloads: Record<string, string> = {};
	const paths = new Map<string, string>();
	for (const [path, v] of Object.entries(shard.paths)) {
		// Package-file PDFs are not uploaded. Resolve original links lazily through the authorized originals route.
		if (!v.ref) continue;
		paths.set(path, v.ref);
		const href = `/cases/${encodeURIComponent(caseId)}/originals/${encodeURIComponent(v.ref)}`;
		files[v.ref] = href + '/view';
		downloads[v.ref] = href + '?download=1';
	}
	return { paths, files, downloads };
}
export { linkedName };
