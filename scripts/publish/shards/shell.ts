// `shell.json`: the local `[vid]` layout's version record (src/routes/v/[vid]/+layout.server.ts) and the document count.
import { caseName } from '../../../src/lib/components/titles.ts';
import type { OverviewModel } from '../../../src/lib/local-case/model.ts';
import { viewText } from '../../../src/lib/local-case/results.server.ts';
import type { ShellShard } from '../../../src/lib/views/payloads/shell.ts';
import type { ShardModule } from '../types.ts';

export default {
  name: 'shell',
  async build({ store, resultsVersion, vc, json }) {
    const v = store.getVersion(resultsVersion)!;
    const o = JSON.parse(v.overview) as OverviewModel;
    const name = caseName(o);
    const params = { caseName: name, resultsVersion: v.id };
    const shell: ShellShard = {
      version: {
        id: v.id, caseId: v.case_id, caseName: name, importId: v.import_id, verdict: v.verdict, created: v.created, inputRevisionId: v.input_revision_id,
        titleName: viewText(vc, '_shell', 'documentTitle', params) ?? name,
        brand: viewText(vc, '_shell', 'brandName', params) ?? name,
      },
      documents: o.counts.documents,
    };
    return [json('shell.json', shell)];
  },
} satisfies ShardModule;
