// `originals.json`: every asset of the package by id, with what the originals routes need to name and serve its bytes.
import { mediaFamily } from '../../originals/manifest.ts';
import type { ShardModule } from '../types.ts';

export interface OriginalEntry {
  id: string; sha256: string | null; size: number | null; mediaType: string; filename: string | null; parent: string | null; downloadOnly: boolean; status: string;
}

export default {
  name: 'originals',
  async build({ store, resultsVersion, json }) {
    const entries: OriginalEntry[] = store.projectionRows(resultsVersion).assets.map((a) => ({
      id: a.key, sha256: a.sha256, size: a.size, mediaType: a.media_type,
      filename: a.indexed_path?.split('/').pop() ?? a.member, parent: a.parent_ref,
      downloadOnly: a.download_only === 1 || mediaFamily(a.media_type) === 'download', status: a.status,
    }));
    return [json('originals.json', entries)];
  },
} satisfies ShardModule;
