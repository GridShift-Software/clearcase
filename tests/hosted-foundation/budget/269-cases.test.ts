// GRS-269: `/cases` is the last hop of every sign-in. Over the real hostedServices composition (./266-world.ts), with
// every D1 call, KV get and R2 read held for one delay, `sequential` is the storage round trips on its critical path.
// Before GRS-269 (base ceb6d84d sources) the load ran them one after another: the session's KV revocation read, the
// storage gate's D1 then R2 identity reads, the case rows, then per case a grant read, a case-exists read and an awaited
// audit append (its binding read, insert and read-back): 24 with the five cases below (measured, 21 D1 calls).
import { expect, it } from 'vitest';
import { rcWorld, show, type RcWorld } from './266-world.ts';
import { load as casesLoad } from '../../../deploy/client/routes/cases/+page.server.ts';

const GRANT = `INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at,expires_at)
  VALUES (?,?,'case',?,?,'rc-editor','client',?,?,'active',1,?,'[]','seed','seed','2001-01-01T00:00:00.000Z',?)`;

/** case-a (published, editor) and case-b (viewer) are listed. case-c has only another client's grant, case-d an expired
 * one and case-e an operator grant, which reads nothing: none is listed. */
function firm(w: RcWorld) {
  const issuer = w.db.rows<{ issuer: string }>("SELECT issuer FROM tenant_case_grants WHERE grant_id = 'rc-grant'")[0]!.issuer;
  for (const c of ['case-b', 'case-c', 'case-d', 'case-e']) w.db.exec('INSERT INTO rs_case (case_id, case_label) VALUES (?, ?)', c, `Case ${c}`);
  w.db.exec(GRANT, 'g-b', 'client-a', 'case-b', issuer, 'viewer', 'content', 'seed-b', null);
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
    // The session's KV read, the storage gate, the case rows beside the grants, and one audit batch.
    expect(r.sequential).toBeLessThanOrEqual(4);
    expect(r.batches).toBeLessThanOrEqual(2);
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
    w.db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = '2001-01-01T00:00:00.000Z', revoked_operation_id = 'revoke-' || grant_id WHERE grant_id IN ('rc-grant', 'g-b')");
    const r = await list(w);
    expect(r.thrown).toBeUndefined();
    expect(r.value?.cases).toEqual([]);
    expect(events(w).filter(e => e.outcome === 'succeeded')).toEqual([]);
  } finally { await w.cleanup(); }
});
