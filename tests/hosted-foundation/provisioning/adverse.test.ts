// GRS-114 adverse outcomes, written first against the only case authority that exists at the accepted base: the
// unavailable identity (RED at b6e4ef39). The world below now supplies the GRS-114 authorizer; assertions are unchanged.
// A refusal must name its reason (wrong-client, forbidden), and an explicit viewer grant must read; "identity-unavailable"
// for everything is not isolation.
import { describe, expect, it } from 'vitest';
import type { CaseOperation, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { world as grantsWorld, ISSUER_A, ISSUER_C } from './world.ts';

const CASE_1 = id('case', 'case-1');
const viewer: Principal = { issuer: ISSUER_A, subject: 'user_viewer', kind: 'client' };
const admin: Principal = { issuer: ISSUER_A, subject: 'user_admin', kind: 'client' };
const revoked: Principal = { issuer: ISSUER_A, subject: 'user_revoked', kind: 'client' };
const foreign: Principal = { issuer: ISSUER_C, subject: 'user_viewer', kind: 'client' };
const session = id('session', 'session-1') as SessionId;

type AuthorizeCase = (a: { principal: Principal; sessionId: SessionId; caseId: typeof CASE_1; operation: CaseOperation }) => Promise<void>;
/** The world: client A, case-1, viewer granted; admin holds only grant management; revoked lost its viewer grant. */
async function world(): Promise<AuthorizeCase> {
  const w = grantsWorld();
  w.seed(viewer, 'viewer', CASE_1);
  w.seed(admin, 'grant-admin', null);
  w.seed(revoked, 'viewer', CASE_1, { state: 'revoked' });
  return w.authorizeCase;
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
