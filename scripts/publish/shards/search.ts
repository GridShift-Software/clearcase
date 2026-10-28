// `search/index.json`: one row per document with what search reads (ref, file name, subject, sender, to, cc, excerpt)
// and what its filters and result lines show. No full text: search reads the excerpt only, as the local app does.
import { searchRowsOf } from '../../../src/lib/views/evidence/rows.server.ts';
import { indexRow, type SearchIndex } from '../../../src/lib/views/evidence/search.ts';
import type { ShardModule } from '../types.ts';

export default {
  name: 'search',
  async build({ store, resultsVersion, json }) {
    const found = searchRowsOf(store, resultsVersion);
    if (!found) throw new Error('the version has no document rows to index');
    // The local page says which documents a failed row provider left out; a published index has no such line, so it must not lose any.
    if (found.failed.length) throw new Error(`${found.failed.length} document rows failed, so the search index would leave documents out`);
    const index: SearchIndex = { rows: found.rows.map(indexRow) };
    return [json('search/index.json', index)];
  },
} satisfies ShardModule;
