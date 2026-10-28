// GRS-269: `/cases` is the last hop of every sign-in. Over the real hostedServices composition (./266-world.ts), with
// every D1 call, KV get and R2 read held for one delay, `sequential` is the storage round trips on its critical path.
// Before GRS-269 (base ceb6d84d sources) the load ran them one after another: the session's KV revocation read, the
// storage gate's D1 then R2 identity reads, the case rows, then per case a grant read, a case-exists read and an awaited
// audit append (its binding read, insert and read-back): 24 with the five cases below (measured, 21 D1 calls).
import { expect, it } from 'vitest';
import { rcWorld, show, type RcWorld } from './266-world.ts';
import { load as casesLoad } from '../../../deploy/client/routes/cases/+page.server.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { principalCaseGrants } from '../../../src/lib/tenancy/request-case.ts';
import { resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { exampleInput } from '../native-runtime-config/example-input.ts';
import { nativeConfigOf } from '../native-runtime-config/harness.ts';
import { codeOf } from '../../../src/lib/server/runtime/errors.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { AuditEvent, CaseId, CaseOperation, Principal } from '../../../src/lib/server/runtime/contracts.ts';

const GRANT = `INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at,expires_at)
  VALUES (?,?,'case',?,?,'rc-editor','client',?,?,'active',1,?,'[]','seed','seed','2001-01-01T00:00:00.000Z',?)`;

/** `listed` cases are listed: case-a (published, editor), then case-b, case-b01, ... (viewer). case-c has only another
 * client's grant, case-d an expired one and case-e an operator grant, which reads nothing: none of the three is listed. */
function firm(w: RcWorld, listed = 2) {
  const issuer = w.db.rows<{ issuer: string }>("SELECT issuer FROM tenant_case_grants WHERE grant_id = 'rc-grant'")[0]!.issuer;
  const viewed = Array.from({ length: listed - 1 }, (_, i) => i === 0 ? 'case-b' : `case-b${String(i).padStart(2, '0')}`);
  for (const c of [...viewed, 'case-c', 'case-d', 'case-e']) w.db.exec('INSERT INTO rs_case (case_id, case_label) VALUES (?, ?)', c, `Case ${c}`);
  for (const c of viewed) w.db.exec(GRANT, `g-${c}`, 'client-a', c, issuer, 'viewer', 'content', `seed-${c}`, null);
  w.db.exec(GRANT, 'g-c', 'client-c', 'case-c', issuer, 'viewer', 'content', 'seed-c', null);
  w.db.exec(GRANT, 'g-d', 'client-a', 'case-d', issuer, 'viewer', 'content', 'seed-d', '2000-01-01T00:00:00.000Z');
  w.db.exec(GRANT, 'g-e', 'client-a', 'case-e', issuer, 'operator', 'operator', 'seed-e', null);
}
const list = (w: RcWorld) => w.timed(`${w.origin}/cases`, { method: 'GET' }, (locals, _r, url) => casesLoad({ locals, url } as never));
const events = (w: RcWorld) => w.db.rows<{ action: string; object_id: string; case_id: string | null; outcome: string }>(
  "SELECT action, object_id, case_id, outcome FROM native_audit_events WHERE action = 'case.read' ORDER BY object_id");

it('269 /cases lists every granted case in a fixed number of storage round trips, whatever the number of cases', async () => {
  const w = await rcWorld({ slowReads: true });
  try {
    firm(w);
    const r = await list(w);
    expect(r.thrown).toBeUndefined(); show('/cases (5 cases, 2 listed)', r);
    expect(r.value?.cases.map(c => [c.caseId, c.published])).toEqual([['case-a', true], ['case-b', false]]);
    // The session's KV read, the storage gate, the case rows beside the grants, and one audit batch: 4, with one of slack.
    expect(r.sequential).toBeLessThanOrEqual(5);
    expect(r.counts).toMatchObject({ d1: 5, r2: 1, clerk: 0, otherFetch: 0 }); expect(r.batches).toBe(2);
    // Every listed case is recorded as read before the page renders; each refusal keeps its own denied event, scoped to
    // the case only where the principal holds an effective grant on it (case-e's operator grant).
    expect(events(w)).toEqual([
      { action: 'case.read', object_id: 'case-a', case_id: 'case-a', outcome: 'succeeded' },
      { action: 'case.read', object_id: 'case-b', case_id: 'case-b', outcome: 'succeeded' },
      { action: 'case.read', object_id: 'case-c', case_id: null, outcome: 'denied' },
      { action: 'case.read', object_id: 'case-d', case_id: null, outcome: 'denied' },
      { action: 'case.read', object_id: 'case-e', case_id: 'case-e', outcome: 'denied' },
    ]);
  } finally { await w.cleanup(); }
});

// The calls are counted, not timed, so a case count that adds one fails here whatever the runner's load.
it.each([1, 5, 50])('269 /cases with %i listed cases and 3 refused makes 5 D1 calls, 2 of them batches, and 1 R2 read', async listed => {
  const w = await rcWorld({ slowReads: true });
  try {
    firm(w, listed);
    const r = await list(w);
    expect(r.thrown).toBeUndefined(); show(`/cases (${listed + 3} cases, ${listed} listed)`, r);
    expect(r.value?.cases).toHaveLength(listed);
    expect(r.counts).toMatchObject({ d1: 5, r2: 1, clerk: 0, otherFetch: 0 }); expect(r.batches).toBe(2);
    expect(r.sequential).toBeLessThanOrEqual(5);
    const recorded = events(w);
    expect(recorded.filter(e => e.outcome === 'succeeded').map(e => e.object_id)).toEqual(r.value!.cases.map(c => c.caseId));
    expect(recorded.filter(e => e.outcome === 'denied').map(e => e.object_id)).toEqual(['case-c', 'case-d', 'case-e']);
  } finally { await w.cleanup(); }
});

it('269 /cases renders nothing when the audit of any listed case fails to append', async () => {
  const w = await rcWorld();
  try {
    firm(w);
    w.db.exec("CREATE TRIGGER refuse_case_b BEFORE INSERT ON native_audit_events WHEN NEW.object_id = 'case-b' AND NEW.outcome = 'succeeded' BEGIN SELECT RAISE(ABORT, 'synthetic audit fault'); END");
    const r = await list(w);
    expect(r.thrown).toMatchObject({ status: 503, body: { code: 'audit-unavailable' } });
    expect(r.value).toBeUndefined();
  } finally { await w.cleanup(); }
});

it('269 /cases lists nothing and records nothing as read once the grant is revoked', async () => {
  const w = await rcWorld();
  try {
    firm(w);
    w.db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = '2001-01-01T00:00:00.000Z', revoked_operation_id = 'revoke-' || grant_id WHERE grant_id IN ('rc-grant', 'g-case-b')");
    const r = await list(w);
    expect(r.thrown).toBeUndefined();
    expect(r.value?.cases).toEqual([]);
    expect(events(w).filter(e => e.outcome === 'succeeded')).toEqual([]);
  } finally { await w.cleanup(); }
});

it('269 the list decides and records every case as one authorizeCase per case would', async () => {
  const w = await rcWorld();
  try {
    firm(w);
    const native = nativeConfigOf(planNativeRuntimeConfig(exampleInput()).clients.find(c => c.clientId === 'client-a')!) as { manifest: unknown; deployment: Parameters<typeof resolveExactDeployment>[1] };
    const deployment = resolveExactDeployment(validateClientManifest(native.manifest), native.deployment);
    const issuer = deployment.clientIssuer;
    // case-z has a live grant but no case row; the staff principal shares the subject but not the kind; a pending grant reads nothing.
    w.db.exec(GRANT, 'g-z', 'client-a', 'case-z', issuer, 'viewer', 'content', 'seed-z', null);
    w.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at)
      VALUES ('g-p','client-a','case','case-c',?,'rc-editor','client','editor','content','pending',1,'seed-p','[]','seed','seed','2001-01-01T00:00:00.000Z')`, issuer);
    const caseIds = ['case-a', 'case-b', 'case-c', 'case-d', 'case-e', 'case-z', 'bad id'].map(c => c as CaseId);
    const principals: Principal[] = [{ issuer, subject: 'rc-editor', kind: 'client' }, { issuer, subject: 'rc-editor', kind: 'staff' }, { issuer, subject: 'nobody', kind: 'client' },
      { issuer: deployment.staffIssuer, subject: 'rc-editor', kind: 'staff' }];
    const authorizer = (events: AuditEvent[], list: boolean) => createCaseAuthorizer({ deployment, grants: d1GrantRepository(w.db), cases: d1CaseDirectory({ db: w.db, deployment }),
      audit: { append: async e => { events.push(e); return { eventId: e.eventId }; } }, now: () => new Date('2001-06-01T00:00:00Z'), ...(list ? { caseGrants: principalCaseGrants(w.db, deployment) } : {}) });
    const sessionId = id('session', 'synthetic-parity');
    const strip = (events: AuditEvent[]) => events.map(({ eventId: _, at: __, ...e }) => JSON.stringify(e)).sort();
    const compare = async (label: string) => {
      for (const principal of principals) for (const operation of ['read', 'write-user-work'] as CaseOperation[]) {
        const one: AuditEvent[] = [], all: AuditEvent[] = [], each = authorizer(one, false);
        // The loop the reader ran before GRS-269: a forbidden case is left out, any other refusal refuses the list.
        let allowed: CaseId[] | string = [];
        for (const caseId of caseIds) {
          try { await each.authorizeCase({ principal, sessionId, caseId, operation }); allowed.push(caseId); }
          catch (e) { if (codeOf(e) !== 'forbidden') { allowed = codeOf(e)!; break; } }
        }
        const listed = await authorizer(all, true).authorizeCases({ principal, sessionId, operation, caseIds: Promise.resolve(caseIds) }).then(l => [...l], e => codeOf(e)!);
        expect(listed, `${label} ${principal.kind}/${principal.subject} ${operation}`).toEqual(allowed);
        expect(strip(all), `${label} ${principal.kind}/${principal.subject} ${operation} events`).toEqual(strip(one));
      }
    };
    await compare('bound');
    w.db.exec("UPDATE rs_storage_identity SET client_id = 'client-c'");
    try { await compare('foreign database'); } finally { w.db.exec("UPDATE rs_storage_identity SET client_id = 'client-a'"); }
  } finally { await w.cleanup(); }
});
