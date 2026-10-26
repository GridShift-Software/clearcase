// NATIVE24 RED first: what the 0003 migration and the two D1 adapters enforce by themselves, on real SQLite semantics
// (triggers, partial unique indexes, one-transaction batches). node:sqlite is a durable-SQLite stand-in, not D1 proof.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import * as tenancy from '../../../src/lib/tenancy/index.ts';
import { MIGRATIONS } from '../provisioning/world.ts';
import { UPLOAD_MIGRATION, CASE_1, client, refusal, staff, world } from './world.ts';

const USER = client('user_a');
const INSERT = "INSERT INTO tenant_upload_grants (grant_id, client_id, case_id, issuer, subject, principal_kind, state, version, created_operation_id, request, created_at) VALUES (?, ?, ?, ?, ?, 'client', ?, 1, ?, '[]', '2026-10-25T08:00:00.000Z')";
const OPERATION = "INSERT INTO tenant_upload_grant_operations (client_id, operation_id, operation, actor_issuer, actor_subject, actor_kind, request, grant_id, event_json, event_digest, state, recorded_at) VALUES ('client-a', ?, 'issue', 'control-plane:client-a', 'run', 'control-plane', '[]', ?, '{}', ?, 'recorded', '2026-10-25T08:00:00.000Z')";
const DIGEST = '0'.repeat(64);
const throws = (db: DatabaseSync, sql: string, ...v: (string | number | null)[]) => { let e: unknown; try { db.prepare(sql).run(...v); } catch (x) { e = x; } return e; };

describe('the database pins its client', () => {
  it('an unbound database is a retryable fault for the runtime and for provisioning, and a request never binds it', async () => {
    const w = await world({ bound: 'none' });
    w.seedCase(USER, 'viewer', CASE_1);
    expect(await refusal(w.authorize(w.request(USER)))).toMatchObject({ code: 'identity-unavailable', retryable: true });
    expect(await refusal(w.issue(USER, CASE_1, 'op-1'))).toMatchObject({ code: 'storage-unavailable', retryable: true });
    expect(w.db.prepare('SELECT count(*) AS n FROM tenant_upload_binding').get()).toEqual({ n: 0 });
    expect(w.rows()).toHaveLength(0);
    expect(w.events).toHaveLength(0);
  });
  it('a database bound to another client refuses every query and write, and exposes nothing', async () => {
    const w = await world({ bound: 'client-c' });
    expect(await refusal(w.authorize(w.request(USER)))).toMatchObject({ code: 'identity-unavailable' });
    expect(await refusal(w.issue(USER, CASE_1, 'op-1'))).toMatchObject({ code: 'storage-unavailable' });
    expect(w.rows()).toHaveLength(0);
    expect(w.db.prepare('SELECT client_id FROM tenant_upload_binding').all()).toEqual([{ client_id: 'client-c' }]);
  });
  it('binding is explicit, idempotent for the same client and refused for another; the pin is immutable', async () => {
    const w = await world({ bound: 'client-c' });
    const { bindUploadDatabase } = await import('../../../src/lib/tenancy/upload-provisioning.ts');
    await expect(bindUploadDatabase(w.handle, w.deployment)).rejects.toBeTruthy();
    const same = await world();
    await expect(bindUploadDatabase(same.handle, same.deployment)).resolves.toBeUndefined();
    expect(same.db.prepare('SELECT count(*) AS n FROM tenant_upload_binding').get()).toEqual({ n: 1 });
    expect(throws(same.db, "UPDATE tenant_upload_binding SET client_id = 'client-c'")).toBeTruthy();
    expect(throws(same.db, 'DELETE FROM tenant_upload_binding')).toBeTruthy();
    expect(same.db.prepare('SELECT client_id FROM tenant_upload_binding').all()).toEqual([{ client_id: 'client-a' }]);
  });
  it('the table itself refuses a row on an unbound database or for another client', async () => {
    const bare = new DatabaseSync(':memory:');
    bare.exec([...MIGRATIONS, UPLOAD_MIGRATION].join('\n'));
    expect(throws(bare, INSERT, 'g1', 'client-a', CASE_1, USER.issuer, USER.subject, 'pending', 'op-1')).toBeTruthy();
    const w = await world();
    expect(throws(w.db, INSERT, 'g2', 'client-c', CASE_1, USER.issuer, USER.subject, 'pending', 'op-2')).toBeTruthy();
    expect(throws(w.db, INSERT, 'g3', 'client-a', CASE_1, USER.issuer, USER.subject, 'pending', 'op-3')).toBeUndefined();
  });
  it('applies twice without error (additive and idempotent) and leaves the 114 tables untouched', async () => {
    const w = await world();
    expect(() => w.db.exec(UPLOAD_MIGRATION)).not.toThrow();
    for (const f of ['0001_tenant_case_grants.sql', '0002_tenant_grant_operations.sql']) {
      const sql = readFileSync(new URL(`../../../src/lib/tenancy/migrations/${f}`, import.meta.url), 'utf8');
      expect(UPLOAD_MIGRATION).not.toContain(sql.split('\n').find((l) => l.startsWith('CREATE TABLE'))!);
    }
    expect(UPLOAD_MIGRATION).not.toMatch(/ALTER TABLE|DROP |tenant_case_grants|tenant_grant_operations/);
  });
});

describe('the table enforces "not active before the audit event is confirmed"', () => {
  it('refuses a row inserted active, a pending row activated before its ledger row is audited, and a revived revoked row', async () => {
    const w = await world();
    expect(throws(w.db, INSERT, 'g1', 'client-a', CASE_1, USER.issuer, USER.subject, 'active', 'op-1')).toBeTruthy();
    expect(throws(w.db, INSERT, 'g2', 'client-a', CASE_1, USER.issuer, USER.subject, 'pending', 'op-2')).toBeUndefined();
    w.db.prepare(OPERATION).run('op-2', 'g2', DIGEST);
    expect(throws(w.db, "UPDATE tenant_upload_grants SET state = 'active', version = 2 WHERE grant_id = 'g2'")).toBeTruthy();
    w.db.prepare("UPDATE tenant_upload_grant_operations SET state = 'audited' WHERE operation_id = 'op-2'").run();
    expect(throws(w.db, "UPDATE tenant_upload_grants SET state = 'active', version = 2 WHERE grant_id = 'g2'")).toBeUndefined();
    w.db.prepare("UPDATE tenant_upload_grants SET state = 'revoked', version = 3, revoked_operation_id = 'r', revoked_at = '2026-10-25T09:00:00.000Z' WHERE grant_id = 'g2'").run();
    expect(throws(w.db, "UPDATE tenant_upload_grants SET state = 'active', version = 4, revoked_operation_id = NULL, revoked_at = NULL WHERE grant_id = 'g2'")).toBeTruthy();
    expect(w.rows()).toMatchObject([{ grant_id: 'g2', state: 'revoked' }]);
  });
  it('freezes a grant tuple and its ledger row: nothing is retargeted, rewritten, deleted or un-audited', async () => {
    const w = await world();
    await w.issue(USER, CASE_1, 'op-1');
    const [g] = w.rows();
    for (const set of ["case_id = 'case-2'", "subject = 'someone-else'", "issuer = 'https://client-c.example.test'", "principal_kind = 'staff'", "client_id = 'client-c'", "created_operation_id = 'op-x'"]) {
      expect(throws(w.db, `UPDATE tenant_upload_grants SET ${set} WHERE grant_id = ?`, g.grant_id)).toBeTruthy();
    }
    for (const set of ["event_json = '{}'", "event_digest = '" + DIGEST + "'", "request = '[]'", "actor_kind = 'staff'", "actor_subject = 'x'", "grant_id = 'other'", "state = 'recorded'"]) {
      expect(throws(w.db, `UPDATE tenant_upload_grant_operations SET ${set} WHERE operation_id = 'op-1'`)).toBeTruthy();
    }
    expect(throws(w.db, "DELETE FROM tenant_upload_grant_operations WHERE operation_id = 'op-1'")).toBeTruthy();
    expect(throws(w.db, 'DELETE FROM tenant_upload_grants')).toBeTruthy();
    expect(w.rows()).toMatchObject([{ state: 'active', case_id: CASE_1, subject: USER.subject }]);
  });
  it('only a control-plane actor and the two operation kinds can be recorded', async () => {
    const w = await world();
    w.db.prepare(INSERT).run('g1', 'client-a', CASE_1, USER.issuer, USER.subject, 'pending', 'op-1');
    expect(throws(w.db, OPERATION.replace("'control-plane', '[]'", "'staff', '[]'"), 'op-1', 'g1', DIGEST)).toBeTruthy();
    expect(throws(w.db, OPERATION.replace("'issue'", "'bootstrap'"), 'op-1', 'g1', DIGEST)).toBeTruthy();
    expect(throws(w.db, OPERATION, 'op-1', 'g1', 'short')).toBeTruthy();
    expect(throws(w.db, OPERATION, 'op-1', 'g1', DIGEST)).toBeUndefined();
  });
});

describe('forged and legacy rows', () => {
  const unguarded = async () => {
    const w = await world();
    for (const t of w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) w.db.exec(`DROP TRIGGER ${t.name}`);
    w.seedCase(USER, 'viewer', CASE_1);
    return w;
  };
  it('a writer that bypassed every trigger still cannot mint a grant: an active row without an audited issue ledger row is nothing', async () => {
    const w = await unguarded();
    w.db.prepare(INSERT).run('forged', 'client-a', CASE_1, USER.issuer, USER.subject, 'active', 'forged-op');
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
    w.db.prepare(OPERATION).run('forged-op', 'forged', DIGEST); // recorded, not audited
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
  it('a ledger row of the wrong kind or for another grant does not vouch for a grant', async () => {
    const w = await unguarded();
    w.db.prepare(INSERT).run('forged', 'client-a', CASE_1, USER.issuer, USER.subject, 'active', 'op-r');
    w.db.prepare(OPERATION.replace("'issue'", "'revoke'").replace("'recorded'", "'audited'")).run('op-r', 'forged', DIGEST);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
    w.db.prepare(INSERT).run('other', 'client-a', 'case-2', client('someone').issuer, 'someone', 'pending', 'op-o');
    w.db.prepare("DELETE FROM tenant_upload_grant_operations").run();
    w.db.prepare(OPERATION.replace("'recorded'", "'audited'")).run('op-r', 'other', DIGEST);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
  it('rows of another client in the table never answer, and never read as this client', async () => {
    const w = await unguarded();
    w.db.prepare(INSERT).run('foreign', 'client-c', CASE_1, USER.issuer, USER.subject, 'active', 'op-c');
    w.db.prepare(OPERATION.replace("'client-a'", "'client-c'").replace("'recorded'", "'audited'")).run('op-c', 'foreign', DIGEST);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
  it('a row with an unparsable expiry, or one naming another case, is void', async () => {
    const w = await unguarded();
    w.db.prepare(INSERT).run('bad', 'client-a', CASE_1, USER.issuer, USER.subject, 'active', 'op-b');
    w.db.prepare(OPERATION.replace("'recorded'", "'audited'")).run('op-b', 'bad', DIGEST);
    w.db.exec("UPDATE tenant_upload_grants SET expires_at = 'not-a-date'");
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden'); // an unparsable expiry is void, as for every 114 grant
    w.db.exec("UPDATE tenant_upload_grants SET expires_at = NULL, case_id = 'a b'");
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
  });
  it('the legacy case-grant table cannot carry an upload role, and every legacy role for the tuple stays forbidden', async () => {
    const w = await world();
    for (const role of ['uploader', 'upload-originals', 'case.upload-originals', 'upload']) {
      expect(throws(w.db, `INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at) VALUES ('l-${role}', 'client-a', 'case', ?, ?, ?, 'client', ?, 'content', 'active', 1, 'l-op', '[]', 's', 's', '2026-10-24T00:00:00.000Z')`, CASE_1, USER.issuer, USER.subject, role)).toBeTruthy();
    }
    for (const role of ['viewer', 'operator', 'publisher'] as const) w.seedCase(USER, role, CASE_1);
    w.seedCase(USER, 'grant-admin', null);
    w.seedCase(staff('s'), 'editor', CASE_1);
    expect((await refusal(w.authorize(w.request(USER)))).code).toBe('forbidden');
    expect((await refusal(w.authorize(w.request(staff('s'))))).code).toBe('forbidden');
  });
});

describe('boundaries', () => {
  const read = (p: string) => readFileSync(new URL(`../../../src/lib/tenancy/${p}`, import.meta.url), 'utf8');
  it('the tenancy index exports the runtime authorizer and reader only, never the provisioning entry or the binder', () => {
    const names = Object.keys(tenancy);
    expect(names).toEqual(expect.arrayContaining(['createUploadAuthorizer', 'd1UploadGrantReader', 'UPLOAD_GRANT_MIGRATIONS']));
    expect(names.filter((n) => /provision|bind|UploadGrantStore|createUploadProvisioning/i.test(n))).toEqual([]);
    expect(read('index.ts')).not.toMatch(/upload-provisioning/);
    expect((tenancy as Record<string, unknown>).UPLOAD_GRANT_MIGRATIONS).toEqual(['0003_tenant_upload_grants.sql']);
    expect(tenancy.TENANCY_MIGRATIONS).toEqual(['0001_tenant_case_grants.sql', '0002_tenant_grant_operations.sql']);
  });
  it('the request-side module neither writes, imports provisioning, nor imports dynamically', () => {
    const src = read('upload-capability.ts');
    expect(src).not.toMatch(/upload-provisioning|audit\/provisioning|\bimport\s*\(/);
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
    expect(src).not.toMatch(/\.batch\(|\.run\(/);
  });
  it('the provisioning module is not reachable from the other tenancy modules', () => {
    for (const f of ['index.ts', 'authorizer.ts', 'management.ts', 'grants.ts', 'd1-grants.ts', 'upload-capability.ts']) expect(read(f)).not.toMatch(/upload-provisioning/);
  });
});
