import { createHash } from 'node:crypto';
import { viewSeeds, type SeedRow } from '$lib/case-package/user-work';
import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { crossexamMerge, CX_SEED } from '$lib/views/litigation/crossexam';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import { registerRows } from '../heads_tab/rows';
import type { RequestEvent } from '@sveltejs/kit';

export const load = async ({ locals, params }: Pick<RequestEvent, 'locals' | 'params'>) => {
  const scope = await publishedVersion(locals, params);
  const [payload, work] = await Promise.all([
    shard<ViewShards['crossexam_tab'] & { seeds: SeedRow[] }>(locals, params, 'view/crossexam_tab.json'),
    locals.userWork.readViewWork({ caseId: scope.caseId, store: 'crossexam', datasetKey: CX_SEED }).catch(refuse),
  ]);
  const seeds = viewSeeds(payload.seeds, work.overlays), rows = work.rows;
  // Preserve the local read-only seed projection. Ticket 17b supplies write tokens with its actions.
  const projected = seeds.map((s) => ({ ...s,
    seedId: s.state === 'orphaned' ? s.overlay.seedId : s.seed.seedId,
    version: createHash('sha256').update(JSON.stringify(['seed', s.state === 'orphaned' ? null : s.seed.seedSha256,
      s.state === 'seed' ? null : [s.overlay.baseSeedSha256, s.overlay.fields]])).digest('hex').slice(0, 32),
  }));
  const data = crossexamMerge(payload, { seeds: projected, rows: registerRows(rows) }, crypto.randomUUID());
  return { ...data, base: scope.base, empty: data.rows.length === 0 };
};
