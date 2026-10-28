import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { localLoad } from '../../../scripts/publish/local-loader.ts';
import { service } from '../../../src/lib/local-case/test-support.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from './world.ts';

let b: BuiltCase, dep: Deployment, lc: ReturnType<typeof service>;
beforeAll(async () => {
  b = await builtCase(); dep = await published(b);
  lc = service(path.join(b.root, 'parity-store')); await lc.startup();
  await lc.importPackage(b.synth.caseDir, b.synth.pkgDir);
}, 120_000);
afterAll(async () => { await lc?.shutdown(); await b?.cleanup(); });
import { load as matter } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/matter/+page.server.ts';
import { load as timeline } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/timeline/+page.server.ts';
import { load as contradictions_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/contradictions_tab/+page.server.ts';
import { load as risk_matrix_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/risk_matrix_tab/+page.server.ts';
import { load as vdm_matrix_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/vdm_matrix_tab/+page.server.ts';
import { load as witness_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/witness_tab/+page.server.ts';
import { load as people } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/people/+page.server.ts';
import { load as entity_ledger_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/entity_ledger_tab/+page.server.ts';
import { load as conflict_tab } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/conflict_tab/+page.server.ts';
const routes = [
  ['analysis/matter', matter],
  ['analysis/timeline', timeline],
  ['analysis/contradictions_tab', contradictions_tab],
  ['analysis/risk_matrix_tab', risk_matrix_tab],
  ['analysis/vdm_matrix_tab', vdm_matrix_tab],
  ['analysis/witness_tab', witness_tab],
  ['evidence/people', people],
  ['evidence/entity_ledger_tab', entity_ledger_tab],
  ['litigation/conflict_tab', conflict_tab],] as const;
test.each(routes)('%s shard props equal the unchanged local loader', async (route, load) => {
  const local = await localLoad({ store: lc.store, resultsVersion: b.synth.resultsVersion }, route);
  const hosted = await load({ locals: locals(dep), params: { caseId: CASE_ID, version: b.synth.resultsVersion } as never });
  const { base, empty, ...props } = hosted;
  expect(base).toBe(`/cases/${CASE_ID}/v`);
  expect(typeof empty).toBe('boolean');
  expect(props).toEqual(JSON.parse(JSON.stringify(local)));
});
