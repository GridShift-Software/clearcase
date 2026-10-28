import { createHash } from 'node:crypto';
import { shard, publishedVersion } from '$lib/views/hosted/payloads.server';
import { crossexamMerge, CX_SEED } from '$lib/views/litigation/crossexam';
import type { ViewShards } from '$lib/views/payloads/views';
import { refuse } from '$lib/server/runtime/hosted/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const scope = await publishedVersion(locals, params);
  const [payload, seeds, rows] = await Promise.all([
    shard<ViewShards['crossexam_tab']>(locals, params, 'view/crossexam_tab.json'),
    locals.userWork.seedViews({ caseId: scope.caseId, resultsVersion: scope.resultsVersion, datasetKey: CX_SEED }).catch(refuse),
    locals.userWork.listRows({ caseId: scope.caseId, store: 'crossexam' }).catch(refuse),
  ]);
  // Preserve the local read-only seed projection. Ticket 17b supplies write tokens with its actions.
  const projected = seeds.map((s) => ({ ...s,
    seedId: s.state === 'orphaned' ? s.overlay.seedId : s.seed.seedId,
    version: createHash('sha256').update(JSON.stringify(['seed', s.state === 'orphaned' ? null : s.seed.seedSha256,
      s.state === 'seed' ? null : [s.overlay.baseSeedSha256, s.overlay.fields]])).digest('hex').slice(0, 32),
  }));
  const data = crossexamMerge(payload, { seeds: projected, rows }, crypto.randomUUID());
  return { ...data, base: scope.base, empty: data.rows.length === 0 };
};
