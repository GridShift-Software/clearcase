// Synthetic actual migrations/adapters; SQLite and R2 transport doubles, never provider evidence.
import { afterEach, expect, it } from 'vitest';
import { exportNativeCase } from '../../../src/lib/recovery/hosted/export.ts';
import { world, CASE, CLIENT, type World } from '../recovery-native-adapters/world.ts';
import { submit, submissionOp } from '../storage/fixture.ts';
import { pdf } from '../../results-review/native/fixtures.ts';
import { revisionIdOf } from '../../../src/lib/submissions/repository.ts';
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
const req = { caseId: CASE, exportId: 'native-e1', includeUserWork: false };
it('exports finalized native submission lineage as checked /2 instead of the /1 unavailable hold', async () => {
  const w = await world(); worlds.push(w);
  const p = await w.stage(); w.publish(p.identity.resultsVersion);
  await submit(w, CASE, [{ path: 'folder/source.pdf', bytes: pdf('native recovery'), ref: 'native-source' }]);
  Object.assign(w.options, { nativeEvidence: { maxLineageRows: 1000, maxLineageBytes: 1 << 20 } });
  const result = await exportNativeCase(await w.deps(), req);
  expect(result.manifest.format).toBe('clearcase.recovery-export/2');
  expect(JSON.stringify(result.manifest)).toContain(revisionIdOf(submissionOp(CASE, 'native-source')));
  expect(result.manifest.clientId).toBe(CLIENT);
});
