import type { CaseStore } from '../../local-case/store.server.ts';
import type { BundlePathsShard } from '../payloads/bundles.ts';
import { documentRows } from '../../local-case/documents.server.ts';
import { pathIndex } from './links.ts';
export function bundlePaths(store: CaseStore, vid: string): BundlePathsShard {
	const paths: BundlePathsShard['paths'] = {};
	const index = pathIndex(
		documentRows(store, vid).rows.map((r) => ({
			ref: r.ref,
			ord: r.ord,
			originalPath: r.state.original?.path ?? null,
			url: typeof r.row.url === 'string' ? r.row.url : null,
		})),
	);
	for (const [path, ref] of index)
		paths[path] = { ref, presentation: 'viewer' };
	for (const f of store.packageFileAssets(vid))
		if (!Object.hasOwn(paths, f.indexed_path))
			paths[f.indexed_path] = { assetKey: f.key, presentation: null };
	return { paths };
}
export function availablePaths(shard: BundlePathsShard) {
	return new Map(
		Object.entries(shard.paths).flatMap(([path, v]) =>
			v.ref ? [[path, v.ref] as const] : [],
		),
	);
}
