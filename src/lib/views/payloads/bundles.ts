import type { OriginalLinks } from '../../local-case/model.ts';

/** `bundle-paths.json`: each package path a bundle cites, resolved to a document ref or a package-file asset key. */
export interface BundlePathsShard {
	paths: Record<string, { ref?: string; assetKey?: string; presentation: OriginalLinks['presentation'] }>;
}
