// `list/page-<n>.json` (200 rows each, at least one page) and `list/facets.json`, from the version's chronology list.
import { listJson } from '../../../src/lib/local-case/documents.server.ts';
import type { ChronologyListRow } from '../../../src/lib/local-case/model.ts';
import { LIST_PAGE_ROWS, type FacetCounts, type FacetsShard, type ListPage } from '../../../src/lib/views/payloads/list.ts';
import type { ShardModule } from '../types.ts';

function counts(values: Iterable<string>): FacetCounts {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export default {
  name: 'list',
  async build({ store, resultsVersion, json }) {
    const rows = JSON.parse(listJson(store, resultsVersion)!.json) as ChronologyListRow[];
    const pages = Math.max(1, Math.ceil(rows.length / LIST_PAGE_ROWS));
    const out = Array.from({ length: pages }, (_, i) => {
      const page: ListPage = { page: i + 1, pages, total: rows.length, rows: rows.slice(i * LIST_PAGE_ROWS, (i + 1) * LIST_PAGE_ROWS) };
      return json(`list/page-${i + 1}.json`, page);
    });
    const facets: FacetsShard = {
      bundles: counts(rows.map((r) => r.bundle)),
      docTypes: counts(rows.map((r) => r.docType)),
      textStatuses: counts(rows.map((r) => r.textStatus)),
      years: counts(rows.flatMap((r) => (/^\d{4}/.test(r.date) ? [r.date.slice(0, 4)] : []))),
    };
    return [...out, json('list/facets.json', facets)];
  },
} satisfies ShardModule;
