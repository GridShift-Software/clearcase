// Cloudflare D1 refuses to prepare a statement whose LIKE or GLOB pattern is over 50 bytes, so an operate condition that
// carries one fails every statement it guards: the private preview's final fence (503 identity-unavailable) and the
// workbench candidate list's release fence (503 storage-unavailable). The D1 double holds D1's limit.
import { afterEach, describe, expect, it } from 'vitest';
import { createPrivatePreview } from '../../../src/lib/server/runtime/hosted/private-preview.ts';
import { ids } from '../storage/fixture.ts';
import { caseId, now, previewWorld, type PreviewWorld } from './fixture.ts';

const worlds: PreviewWorld[] = [];
afterEach(() => { for (const p of worlds.splice(0)) p.w.db.sqlite.close(); });

describe('operate condition under D1 statement limits', () => {
  it('the D1 double refuses a pattern over 50 bytes, as Cloudflare D1 does', async () => {
    const p = await previewWorld(); worlds.push(p);
    expect(p.w.db.sqlite.prepare(`SELECT 'x' GLOB '${'x'.repeat(50)}' AS ok`).get()).toEqual({ ok: 0 });
    expect(() => p.w.db.sqlite.prepare(`SELECT 'x' GLOB '${'x'.repeat(51)}' AS ok`).get()).toThrow(/pattern too complex/);
  });

  // Live grants all carry an expiry (renewed to 2026-11-12); the condition's expiry check runs only on a non-null one.
  const expiring = async () => {
    const p = await previewWorld(); worlds.push(p);
    p.w.db.exec("UPDATE tenant_case_grants SET expires_at = '2099-11-12T00:00:00.000Z'");
    return p;
  };

  it('an operator whose grants expire later reads the private preview', async () => {
    const p = await expiring(), authority = p.authorityOf(p.operator);
    const preview = createPrivatePreview({ clientId: ids.clientA, identity: p.operator.identity, db: p.w.db, audit: p.operator.audit, now,
      authorizeOperate: (a) => authority.authorizeOperate({ ...a, capability: 'operate' }), operateCondition: (a) => authority.operate.condition(a) })!;
    await expect(preview.read({ caseId, candidateId: p.candidate.candidateId })).resolves.toMatchObject({ candidateId: p.candidate.candidateId });
  });

  it('an operator whose grants expire later lists the case candidates on the workbench', async () => {
    const p = await expiring();
    const admitted = await p.service.admit({ identity: p.operator.identity, caseId, access: 'read' });
    await expect(p.service.listCandidates(admitted)).resolves.toMatchObject([{ candidateId: p.candidate.candidateId }]);
  });
});
