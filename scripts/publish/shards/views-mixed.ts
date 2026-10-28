// Ticket 14b: immutable processed halves. User-work rows are read only when the page opens.
import { filingsPure } from '../../../src/lib/views/evidence/filings.server.ts';
import { evidenceRows } from '../../../src/lib/views/evidence/rows.server.ts';
import { authoritiesPure, crossexamPure } from '../../../src/lib/views/litigation/register.server.ts';
import { enforcementPure } from '../../../src/lib/views/litigation/enforcement.server.ts';
import { HEADS_FILE } from '../../../src/lib/views/litigation/heads.ts';
import { paymentsPure, interestPure, settlementPure } from '../../../src/lib/views/quantum/data.server.ts';
import { infoRequiredPure } from '../../../src/lib/views/payloads/info-required.server.ts';
import { exportFileName, viewText } from '../../../src/lib/local-case/results.server.ts';
import type { ShardModule } from '../types.ts';

export default {
  name: 'views-mixed',
  async build({ pure, json }) {
    const seeds = (dataset: string) => pure.store.seeds(pure.vid).filter((s) => s.dataset_key === dataset)
      .map((s) => ({ datasetKey: s.dataset_key, seedId: s.seed_id, seedSha256: s.seed_sha256, record: JSON.parse(s.record_json) }));
    return [
      json('view/filings_tab.json', { ...filingsPure(pure), seeds: seeds('filings') }),
      json('view/payments_tab.json', paymentsPure(pure)),
      json('view/interest_calc_tab.json', interestPure(pure)),
      json('view/settlement_tab.json', settlementPure(pure)),
      json('view/enforcement_tab.json', enforcementPure(pure)),
      json('view/crossexam_tab.json', { ...crossexamPure(pure), seeds: seeds('lit-crossexam-seed') }),
      json('view/authorities_tab.json', authoritiesPure(pure)),
      json('view/info_required_tab.json', infoRequiredPure(pure)),
      // Heads starts as an empty user register. Its reference index resolves user-entered citations without another read.
      json('view/heads_tab.json', {
        caption: viewText(pure.vc, 'heads_tab', 'exportCaption'),
        exportName: exportFileName(pure.vc, 'heads_tab', HEADS_FILE),
        known: (evidenceRows(pure.store, pure.vid)?.rows ?? []).map((r) => r.ref),
      }),
    ];
  },
} satisfies ShardModule;
