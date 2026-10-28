// The filings register's actions over the user-work adapter (sprint ticket 17b). Each write is one `putRow`, `deleteRow` or
// `putSeedOverlay`, which is one D1 batch with its audit, and names the version the write's own read found, so a change made in
// between is refused. A save also checks the version the page showed (the row's fields digest) before it writes.
import { viewSeeds, type SeedRow } from '$lib/case-package/user-work';
import { REGISTER_STORE, SEED_DATASET, type SeedViewLike } from '$lib/views/evidence/filings';
import type { FilingsPort, FilingsPortOf } from '$lib/views/evidence/filings-actions.server';
import { shard } from '$lib/views/hosted/payloads.server';
import { hostedWork } from '$lib/views/hosted/work-adapter.server';
import { operationOf, statusOf, writeScope } from '$lib/views/litigation/hosted.server';
import { refuse } from '$lib/server/runtime/hosted/http';

export const hostedFilingsPort: FilingsPortOf = ({ locals, params }): FilingsPort => {
  const { caseId, resultsVersion: rv } = writeScope(params);
  // the versions the last read found, by row and by seed
  const rowVersion = new Map<string, string>(), overlayVersion = new Map<string, string>();
  const readWork = () => locals.userWork.readViewWork({ caseId, store: REGISTER_STORE, datasetKey: SEED_DATASET }).catch((e: unknown) => refuse(e));
  const work = (operationId: string, version: string | undefined) => hostedWork(locals, caseId, rv, { operationId, version: version ?? '' });
  return {
    caseId,
    queued: (fn) => fn(),
    async rows() {
      const saved = await readWork();
      for (const r of saved.rows) rowVersion.set(r.rowId, r.version);
      return saved.rows;
    },
    async read() {
      const [payload, saved] = await Promise.all([shard<{ seeds: SeedRow[] }>(locals, params, 'view/filings_tab.json'), readWork()]);
      for (const r of saved.rows) rowVersion.set(r.rowId, r.version);
      for (const o of saved.overlays) overlayVersion.set(o.seedId, o.version);
      return { seeds: viewSeeds(payload.seeds, saved.overlays) as SeedViewLike[], rows: saved.rows, overlays: saved.overlays };
    },
    async addRow(fields, addId) {
      // the operation is the typed entry under the form's id: the order number is the register's, not the person's
      const { seq: _order, ...typed } = fields;
      await work(addId ? operationOf('filing-add', addId, typed) : crypto.randomUUID(), undefined).putRow(caseId, REGISTER_STORE, null, fields);
    },
    async putRow(rowId, fields) { const v = rowVersion.get(rowId); await work(operationOf('filing-save', rowId, v, fields), v).putRow(caseId, REGISTER_STORE, rowId, fields); },
    async putOverlay(seedId, baseSeedSha256, fields) {
      const v = overlayVersion.get(seedId);
      await work(operationOf('filing-overlay', seedId, v, fields), v).putSeedOverlay({ caseId, datasetKey: SEED_DATASET, seedId, baseSeedSha256, fields });
    },
    async deleteRow(rowId) { const v = rowVersion.get(rowId); await work(operationOf('filing-delete', rowId, v), v).deleteRow(caseId, REGISTER_STORE, rowId); },
    statusOf,
  };
};
