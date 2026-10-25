// UNIT-ONLY composition: the planner's emitted settings through the REAL hostedServices and Clerk provider factory over
// in-memory D1/R2 doubles (as native-runtime-config/services-composition.test.ts). Clerk is never contacted, so the
// identity is anonymous; this proves request-scoped issuance only, not sign-in, a deployment or a preview of real data.
import { afterAll, describe, expect, it } from 'vitest';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { installNativeCompositions } from '../../../src/lib/server/runtime/hosted/compositions.ts';
import { privatePreviewFor } from '../../../src/lib/server/runtime/hosted/private-preview.ts';
import { prepareHostedStaticInput } from '../../../scripts/hosted-static-input.ts';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { MemoryR2, SqliteD1 } from '../storage/doubles.ts';
import { exampleWithBrowserAllocation } from '../native-runtime-config/example-input.ts';
import { runtimeEnv } from '../native-runtime-config/harness.ts';

const input = prepareHostedStaticInput(process.cwd());
afterAll(() => input.dispose());
const plan = planNativeRuntimeConfig(exampleWithBrowserAllocation());

describe('hostedServices issues the private preview to its own request only', () => {
  it('binds a preview to the exact original Request, none to another request, and refuses an unverified identity', async () => {
    installNativeCompositions();
    const file = plan.clients.find((c) => c.clientId === 'client-a')!;
    const db = Object.assign(new SqliteD1(), { withSession: (_constraint: 'first-primary') => db });
    const env = runtimeEnv(file, { DB: db, BUCKET: new MemoryR2(), ASSETS: { fetch: async () => new Response('unused') } });
    const request = new Request('https://client-a.clearcase.test/operator/cases/case-a/preview/cand-x');
    const ready = await hostedServices(request, env);
    expect(ready.ready).toBe(true);
    const preview = privatePreviewFor({ request });
    expect(preview).not.toBeNull();
    expect(privatePreviewFor({ request: new Request(request.url) })).toBeNull();
    expect(privatePreviewFor({ request: request.clone() })).toBeNull();
    await expect(preview!.read({ caseId: 'case-a', candidateId: 'cand-x' })).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
