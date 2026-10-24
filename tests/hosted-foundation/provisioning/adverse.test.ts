// GRS-114 adverse outcomes, written first against the only case authority that exists at the accepted base: the
// unavailable identity. A refusal must name its reason (wrong-client, forbidden), and an explicit viewer grant must
// read; "identity-unavailable" for everything is not isolation.
import { describe, expect, it } from 'vitest';
import type { CaseOperation, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { createUnavailableServices } from '../../../src/lib/server/runtime/unavailable.ts';

const CLIENT_A = id('client', 'client-a'), CASE_1 = id('case', 'case-1');
const ISSUER_A = 'https://client-a.example.test', ISSUER_C = 'https://client-c.example.test';
const viewer: Principal = { issuer: ISSUER_A, subject: 'user_viewer', kind: 'client' };
const admin: Principal = { issuer: ISSUER_A, subject: 'user_admin', kind: 'client' };
const revoked: Principal = { issuer: ISSUER_A, subject: 'user_revoked', kind: 'client' };
const foreign: Principal = { issuer: ISSUER_C, subject: 'user_viewer', kind: 'client' };
const session = id('session', 'session-1') as SessionId;

type AuthorizeCase = (a: { principal: Principal; sessionId: SessionId; caseId: typeof CASE_1; operation: CaseOperation }) => Promise<void>;
/** The world: client A, case-1, viewer granted; admin holds only grant management; revoked lost its viewer grant. */
async function world(): Promise<AuthorizeCase> {
  const identity = createUnavailableServices({ clientId: CLIENT_A, now: () => new Date('2026-10-24T00:00:00Z') }).identity;
  return (a) => identity.authorize({ caseId: a.caseId, operation: a.operation });
}

describe('GRS-114 case authorization outcomes', () => {
  it('lets an explicit viewer read its case', async () => {
    const authorizeCase = await world();
    await expect(authorizeCase({ principal: viewer, sessionId: session, caseId: CASE_1, operation: 'read' })).resolves.toBeUndefined();
  });
  it('refuses a principal of another client issuer as wrong-client, even with the same subject', async () => {
    const authorizeCase = await world();
    await expect(authorizeCase({ principal: foreign, sessionId: session, caseId: CASE_1, operation: 'read' })).rejects.toMatchObject({ code: 'wrong-client' });
  });
  it('refuses a grant manager without a case grant as forbidden', async () => {
    const authorizeCase = await world();
    await expect(authorizeCase({ principal: admin, sessionId: session, caseId: CASE_1, operation: 'read' })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('refuses a revoked grant as forbidden', async () => {
    const authorizeCase = await world();
    await expect(authorizeCase({ principal: revoked, sessionId: session, caseId: CASE_1, operation: 'read' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
