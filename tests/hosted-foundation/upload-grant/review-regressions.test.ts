// Written before the fix for source-review M1/M2. Real tenancy and audit adapters over synthetic SQLite, not provider proof.
import { describe, expect, it } from 'vitest';
import type { CaseId } from '../../../src/lib/server/runtime/contracts.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisioningAuditPort } from '../../../src/lib/audit/provisioning.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { createUploadAuthorizer, d1UploadGrantReader } from '../../../src/lib/tenancy/upload-capability.ts';
import { createUploadProvisioning } from '../../../src/lib/tenancy/upload-provisioning.ts';
import { world as auditWorld } from '../audit/world.ts';
import { CASE_1, ISSUER_A, ISSUER_STAFF, OPERATOR, TUPLE, client, refusal, world } from './world.ts';

const USER = client('review_user');
const now = () => new Date('2026-10-25T08:00:00.000Z');

async function realAudit(caseId: string = CASE_1) {
  const w = await world({ cases: [caseId] });
  const aw = auditWorld();
  await aw.ready;
  const audit = provisioningAuditPort({ db: aw.d1, config: auditConfig({ ...aw.config, trustedIssuers: [ISSUER_A, ISSUER_STAFF] }), now });
  const provisioning = createUploadProvisioning({ deployment: w.deployment, db: w.handle, cases: { exists: async () => true }, audit, now });
  const request = (operationId: string) => ({ operator: OPERATOR, operationId, target: TUPLE(USER), caseId: caseId as CaseId, expiresAt: null });
  return { w, aw, provisioning, request, audit };
}

describe('M1: identifiers must fit the real provisioning audit contract before reservation', () => {
  it('real audit port accepts an ordinary upload issue and durable replay', async () => {
    const r = await realAudit();
    expect(await r.provisioning.grant(r.request('ordinary-op'))).toMatchObject({ kind: 'applied' });
    expect(await r.provisioning.grant(r.request('ordinary-op'))).toMatchObject({ kind: 'applied', repeated: true });
    expect(r.aw.rows()).toHaveLength(1);
  });

  it('every accepted operation id must be representable in the real audit event', async () => {
    const r = await realAudit();
    // Same long prefix, different last character: truncation must not alias these operations.
    const ids = ['a'.repeat(128), 'a'.repeat(127) + 'b'];
    for (const operationId of ids) {
      const first = await r.provisioning.grant(r.request(operationId));
      expect(first).toMatchObject({ kind: 'applied' });
      if (first.kind !== 'applied') throw new Error('issue must persist and activate');
      expect(await r.provisioning.grant(r.request(operationId))).toMatchObject({ kind: 'applied', repeated: true });
      expect(await r.provisioning.grant({ ...r.request(operationId), operator: 'another-operator' })).toMatchObject({ kind: 'conflict', reason: 'operation-reused' });
      expect(await r.provisioning.revoke({ operator: OPERATOR, operationId: `r${operationId.slice(1)}`, grantId: first.grant.grantId, expectedVersion: first.grant.version })).toMatchObject({ kind: 'applied' });
    }
    const events = r.aw.rows();
    expect(events).toHaveLength(4);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(4);
    expect(events.every((e) => e.event_id.length <= 128)).toBe(true);
    expect(r.w.rows().every((g) => g.state === 'revoked')).toBe(true);
    expect(r.w.ledger().every((o) => (o as { state: string }).state === 'audited')).toBe(true);
  });

  it('keeps literal event ids at the exact boundary and hashes only ids past it', async () => {
    const limit = 128 - 'upload-grant-op:'.length;
    for (const length of [limit, limit + 1]) {
      const r = await realAudit(), operationId = 'o'.repeat(length);
      expect(await r.provisioning.grant(r.request(operationId))).toMatchObject({ kind: 'applied' });
      const eventId = r.aw.rows()[0].event_id;
      if (length === limit) expect(eventId).toBe(`upload-grant-op:${operationId}`);
      else expect(eventId).toMatch(/^upload-grant-hash:[0-9a-f]{64}$/);
      expect(eventId.length).toBeLessThanOrEqual(128);
    }
  });

  it('recovers a long-id issue after the real audit persisted but its acknowledgement was lost', async () => {
    const r = await realAudit();
    let appends = 0;
    const audit = { find: r.audit.find, append: async (event: Parameters<typeof r.audit.append>[0]) => {
      appends++;
      await r.audit.append(event);
      throw new Error('lost acknowledgement');
    } };
    const p = createUploadProvisioning({ deployment: r.w.deployment, db: r.w.handle, cases: { exists: async () => true }, audit, now });
    const request = r.request('l'.repeat(128));
    expect(await p.grant(request)).toMatchObject({ kind: 'applied' });
    // A new factory must use the durable recorded event, not rebuild its id, actor or time.
    expect(await r.provisioning.grant(request)).toMatchObject({ kind: 'applied', repeated: true });
    expect(appends).toBe(1);
    expect(r.aw.rows()).toHaveLength(1);
  });

  it('rejects a colon-bearing case id before reservation, without silently changing case identity', async () => {
    const r = await realAudit('case:one');
    for (let i = 0; i < 2; i++) {
      expect(await r.provisioning.grant(r.request('colon-op'))).toMatchObject({ kind: 'invalid' });
      expect(r.w.rows()).toHaveLength(0);
      expect(r.w.ledger()).toHaveLength(0);
      expect(r.aw.rows()).toHaveLength(0);
    }
    // The invalid request did not consume even its operation id: a different, valid case can use it.
    expect(await r.provisioning.grant({ ...r.request('colon-op'), caseId: CASE_1 })).toMatchObject({ kind: 'applied', grant: { caseId: CASE_1 } });
  });

  it('preserves an accepted 128-character case id exactly in the grant and the real audit event', async () => {
    const caseId = 'c'.repeat(128), r = await realAudit(caseId);
    expect(await r.provisioning.grant(r.request('case-boundary'))).toMatchObject({ kind: 'applied', grant: { caseId } });
    expect(r.aw.rows()[0].case_id).toBe(caseId);
    expect(await r.provisioning.grant(r.request('case-boundary'))).toMatchObject({ kind: 'applied', repeated: true });
  });

  it('rejects an unrepresentable generated grant id before creating an audit-pending slot', async () => {
    const r = await realAudit();
    const invalid = createUploadProvisioning({ deployment: r.w.deployment, db: r.w.handle, cases: { exists: async () => true }, audit: r.audit, now, newGrantId: () => 'g'.repeat(129) });
    expect(await invalid.grant(r.request('bad-generated-id'))).toMatchObject({ kind: 'invalid' });
    expect(r.w.rows()).toHaveLength(0);
    expect(r.w.ledger()).toHaveLength(0);
    expect(await r.provisioning.grant(r.request('bad-generated-id'))).toMatchObject({ kind: 'applied' });
  });
});

describe('M2: read and upload authority must coexist', () => {
  it('read and upload authority must coexist, not be combined across disjoint snapshots', async () => {
    const w = await world(), readId = w.seedCase(USER, 'viewer', CASE_1);
    const reads = d1GrantRepository(w.handle), uploads = d1UploadGrantReader(w.handle, w.deployment);
    let before = true, after = true;
    const authorize = createUploadAuthorizer({ deployment: w.deployment, grants: reads, cases: { exists: async () => true },
      uploads: { heldBy: async (a) => {
        before = (await uploads.heldBy(a)).length > 0;
        w.db.prepare("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = '2026-10-25T08:00:00.000Z' WHERE grant_id = ?").run(readId);
        expect(await w.issue(USER, CASE_1, 'snapshot-issue')).toMatchObject({ kind: 'applied' });
        after = (await reads.grantsOf({ clientId: a.clientId, principal: a.principal, scope: { kind: 'case', caseId: a.caseId } })).some((g) => g.state === 'active');
        return uploads.heldBy(a);
      } }, session: w.session, audit: w.requestAudit, now })!;
    expect((await refusal(authorize(w.request(USER)))).code).toBe('forbidden');
    expect(before).toBe(false);
    expect(after).toBe(false);
    expect(w.events.filter((e) => e.action === 'case.upload-originals' && e.outcome === 'succeeded')).toHaveLength(0);
    expect(w.events.filter((e) => e.outcome === 'denied').every((e) => e.object.caseId === null)).toBe(true);
  });

  it('cannot substitute a newly issued read grant for the original across the upload lookup', async () => {
    const w = await world(), original = w.seedCase(USER, 'viewer', CASE_1);
    const reads = d1GrantRepository(w.handle), uploads = d1UploadGrantReader(w.handle, w.deployment);
    const authorize = createUploadAuthorizer({ deployment: w.deployment, grants: reads, cases: { exists: async () => true },
      uploads: { heldBy: async (a) => {
        w.db.prepare("UPDATE tenant_case_grants SET state = 'revoked', version = version + 1, revoked_at = '2026-10-25T08:00:00.000Z' WHERE grant_id = ?").run(original);
        expect(await w.issue(USER, CASE_1, 'upload-between-reads')).toMatchObject({ kind: 'applied' });
        const captured = await uploads.heldBy(a);
        const issued = (await w.issue(USER, CASE_1, 'upload-between-reads'));
        if (issued.kind !== 'applied') throw new Error('setup');
        await w.provisioning.revoke({ operator: OPERATOR, operationId: 'upload-revoked-before-new-read', grantId: issued.grant.grantId, expectedVersion: issued.grant.version });
        w.seedCase(USER, 'viewer', CASE_1);
        return captured;
      } }, session: w.session, audit: w.requestAudit, now })!;
    expect((await refusal(authorize(w.request(USER)))).code).toBe('forbidden');
    expect(w.events.filter((e) => e.action === 'case.upload-originals' && e.outcome === 'succeeded')).toHaveLength(0);
  });

  it('requires the same read grant version, not merely the same id on both sides of the upload query', async () => {
    const w = await world(), readId = w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'read-version');
    const reads = d1GrantRepository(w.handle), uploads = d1UploadGrantReader(w.handle, w.deployment);
    const authorize = createUploadAuthorizer({ deployment: w.deployment, grants: reads, cases: { exists: async () => true },
      uploads: { heldBy: async (a) => {
        const captured = await uploads.heldBy(a);
        w.db.prepare('UPDATE tenant_case_grants SET version = version + 1 WHERE grant_id = ?').run(readId);
        return captured;
      } }, session: w.session, audit: w.requestAudit, now })!;
    expect((await refusal(authorize(w.request(USER)))).code).toBe('forbidden');
  });

  it('fails closed if the confirming read query is unavailable', async () => {
    const w = await world();
    w.seedCase(USER, 'viewer', CASE_1);
    await w.issue(USER, CASE_1, 'confirming-read');
    const reads = d1GrantRepository(w.handle), uploads = d1UploadGrantReader(w.handle, w.deployment);
    let queries = 0;
    const authorize = createUploadAuthorizer({ deployment: w.deployment,
      grants: { grantsOf: (a) => ++queries === 1 ? reads.grantsOf(a) : Promise.reject(new Error('confirm unavailable')) },
      uploads, cases: { exists: async () => true }, session: w.session, audit: w.requestAudit, now })!;
    expect(await refusal(authorize(w.request(USER)))).toMatchObject({ code: 'identity-unavailable', retryable: true });
    expect(w.events.filter((e) => e.action === 'case.upload-originals' && e.outcome === 'succeeded')).toHaveLength(0);
  });
});
