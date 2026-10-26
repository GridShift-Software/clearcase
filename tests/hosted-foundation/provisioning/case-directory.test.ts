// Native case directory and trusted case provisioning. node:sqlite stand-ins behind the D1 shape over the real
// rs_* storage migration, the real tenancy grant migrations and (for one test) the real audit migration. Unit evidence only:
// not D1, workerd or provider evidence.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisioningAuditPort } from '../../../src/lib/audit/provisioning.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import type { AuditEvent, SystemAuditEvent } from '../../../src/lib/server/runtime/contracts.ts';
import type { D1, D1Statement } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { createCaseProvisioning } from '../../../src/lib/tenancy/case-provisioning.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';
import { CLIENT_A, ISSUER_A, ISSUER_STAFF, MANIFEST, MIGRATION as GRANTS, SESSION, client } from './world.ts';

const read = (p: string) => readFileSync(new URL(`../../../src/lib/${p}`, import.meta.url), 'utf8');
const STORAGE = read('storage/cloud/migrations/0001_rs_results_storage.sql'), AUDIT = read('audit/migrations/0001_native_audit.sql');
const tuple = (n: 'a' | 'c') => ({ clientId: `client-${n}`, hostname: `${n}.clearcase.example.test`, worker: `clearcase-client-${n}`, d1DatabaseId: `00000000-0000-4000-8000-00000000000${n}`, d1DatabaseName: `clearcase-client-${n}`, r2Bucket: `clearcase-client-${n}` });
const deployment = resolveExactDeployment(validateClientManifest(MANIFEST), tuple('a'));
const NOW = new Date('2026-10-25T07:00:00.000Z');

type Hooks = { statements: string[]; failSql: RegExp | null; beforeInsert: (() => void) | null };
function d1(db: DatabaseSync, h: Hooks): D1 {
  const statement = (sql: string, values: (string | number | null)[] = []): D1Statement => {
    const guard = () => {
      h.statements.push(sql.trim());
      if (h.failSql?.test(sql)) throw new Error('D1_ERROR: unavailable');
    };
    return {
      bind: (...next) => statement(sql, next),
      first: async <T>() => { guard(); return (db.prepare(sql).get(...values) as T | undefined) ?? null; },
      all: async <T>() => { guard(); return { results: db.prepare(sql).all(...values) as T[] }; },
      run: async () => { guard(); if (/^\s*INSERT INTO rs_case/i.test(sql)) { const f = h.beforeInsert; h.beforeInsert = null; f?.(); } return db.prepare(sql).run(...values); },
    };
  };
  return { prepare: (sql) => statement(sql), batch: async () => { throw new Error('unexpected batch'); } };
}

function world(o: { identity?: { client: string; layout?: string } | null } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(STORAGE);
  db.exec(GRANTS);
  const identity = o.identity === undefined ? { client: 'client-a' } : o.identity;
  if (identity) db.prepare('INSERT INTO rs_storage_identity (singleton, client_id, layout) VALUES (1, ?, ?)').run(identity.client, identity.layout ?? 'clearcase.rs/1');
  const hooks: Hooks = { statements: [], failSql: null, beforeInsert: null };
  const binding = d1(db, hooks);
  const events: (AuditEvent | SystemAuditEvent)[] = [];
  const audit = { fails: false, lostAck: false, findFails: false, appends: 0 };
  const err = () => Object.assign(new Error('audit-unavailable'), { code: 'audit-unavailable', retryable: true });
  const port = {
    async append(e: SystemAuditEvent) {
      audit.appends++;
      if (audit.fails) throw err();
      if (events.some((x) => x.eventId === e.eventId)) throw err();
      events.push(structuredClone(e));
      if (audit.lostAck) throw err();
      return { eventId: e.eventId };
    },
    async find(eventId: string) { if (audit.findFails) throw err(); const f = events.find((x) => x.eventId === eventId); return f ? structuredClone(f) : null; },
  };
  const provisioning = createCaseProvisioning({ deployment, db: binding, audit: port, now: () => NOW });
  const directory = d1CaseDirectory({ db: binding, deployment });
  const cases = () => db.prepare('SELECT case_id, case_label FROM rs_case ORDER BY case_id').all() as { case_id: string; case_label: string }[];
  return { db, binding, hooks, events, audit, port, provisioning, directory, cases };
}
const create = { operator: 'run-1', caseId: 'case-1', title: 'Synthetic empty case' };
const SYSTEM = { kind: 'system', component: 'provisioning', operator: 'run-1' };

describe('case directory', () => {
  it('answers true only for a provisioned case of the bound client', async () => {
    const w = world();
    await w.provisioning.provisionCase(create);
    expect(await w.directory.exists({ clientId: CLIENT_A, caseId: id('case', 'case-1') })).toBe(true);
    expect(await w.directory.exists({ clientId: CLIENT_A, caseId: id('case', 'case-2') })).toBe(false);
    for (const bad of ['', 'x'.repeat(129), "case-1' OR '1'='1", '../case-1', 'Case-1', 7, null]) {
      expect(await w.directory.exists({ clientId: CLIENT_A, caseId: bad as never })).toBe(false);
    }
  });
  it('gives another client no answer and reads nothing for it', async () => {
    const w = world();
    await w.provisioning.provisionCase(create);
    w.hooks.statements.length = 0;
    expect(await w.directory.exists({ clientId: id('client', 'client-c'), caseId: id('case', 'case-1') })).toBe(false);
    expect(w.hooks.statements).toEqual([]);
  });
  it.each([
    ['an unbound database', null],
    ['a database bound to another client', { client: 'client-c' }],
    ['a database in another layout', { client: 'client-a', layout: 'clearcase.rs/2' }],
  ])('gives no authority from %s, even when it holds the case row', async (_, identity) => {
    const w = world({ identity });
    w.db.prepare("INSERT INTO rs_case (case_id, case_label) VALUES ('case-1', 'planted')").run();
    expect(await w.directory.exists({ clientId: CLIENT_A, caseId: id('case', 'case-1') })).toBe(false);
  });
  it('checks the deployment identity, case lookup and nothing more, and a read never writes', async () => {
    const w = world();
    await w.provisioning.provisionCase(create);
    const before = (w.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    w.hooks.statements.length = 0;
    for (const caseId of ['case-1', 'case-9']) await w.directory.exists({ clientId: CLIENT_A, caseId: id('case', caseId) });
    expect(w.hooks.statements).toHaveLength(2);
    expect(w.hooks.statements.every((s) => /^SELECT /.test(s) && s.includes('rs_storage_identity'))).toBe(true);
    expect((w.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(before);
    expect(w.cases()).toHaveLength(1);
  });
  it('turns a storage fault into a retryable storage-unavailable, never an answer', async () => {
    const w = world();
    w.hooks.failSql = /rs_storage_identity/;
    await expect(w.directory.exists({ clientId: CLIENT_A, caseId: id('case', 'case-1') })).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
  });
  it('is the directory the real authorizer asks: a grant reaches a provisioned case only, and a foreign principal reaches nothing', async () => {
    const w = world();
    await w.provisioning.provisionCase(create);
    const grant = (caseId: string, subject: string) => w.db.prepare(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
      VALUES (?, 'client-a', 'case', ?, ?, ?, 'client', 'viewer', 'content', 'active', 1, ?, '[]', 'seed', 'seed', '2026-10-25T00:00:00.000Z')`).run(`g-${caseId}-${subject}`, caseId, ISSUER_A, subject, `op-${caseId}-${subject}`);
    grant('case-1', 'user_a'); grant('case-ghost', 'user_a');
    const sink: AuditEvent[] = [];
    const { authorizeCase } = createCaseAuthorizer({ deployment, grants: d1GrantRepository(w.binding), cases: w.directory, audit: { append: async (e) => { sink.push(e); return { eventId: e.eventId }; } }, now: () => NOW });
    const ask = (caseId: string, principal = client('user_a')) => authorizeCase({ principal, sessionId: SESSION, caseId: id('case', caseId), operation: 'read' });
    await expect(ask('case-1')).resolves.toBeUndefined();
    await expect(ask('case-ghost')).rejects.toMatchObject({ code: 'forbidden' }); // granted, but no such case
    await expect(ask('case-1', client('user_a', 'https://client-c.example.test'))).rejects.toMatchObject({ code: 'wrong-client' });
    await expect(ask('case-1', client('user_b'))).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('case provisioning', () => {
  it('creates the rows the storage adapter needs and records a system actor, never a verified person', async () => {
    const w = world();
    expect(await w.provisioning.provisionCase(create)).toEqual({ kind: 'provisioned', caseId: 'case-1', title: 'Synthetic empty case', repeated: false });
    expect(w.cases()).toEqual([{ case_id: 'case-1', case_label: 'Synthetic empty case' }]);
    // The storage adapter's own rows reference rs_case by foreign key: an upload declaration can now be written.
    w.db.prepare("INSERT INTO rs_original_upload (case_id, operation_id, asset_id, sha256, size, filename, media_type, state, declared_at) VALUES ('case-1', 'op-1', 'a-1', ?, 3, 'a.pdf', 'application/pdf', 'declared', '2026-10-25T07:00:00.000Z')").run('a'.repeat(64));
    expect(w.db.prepare('SELECT count(*) AS n FROM rs_publication').get()).toEqual({ n: 0 });
    expect(w.events).toEqual([{ eventId: 'case-provision:case-1', actor: SYSTEM, action: 'case.provision', object: { kind: 'case', id: 'case-1', caseId: 'case-1' }, version: null, outcome: 'succeeded', at: NOW.toISOString() }]);
    expect(Object.keys(w.events[0]!.actor).sort()).toEqual(['component', 'kind', 'operator']);
  });
  it('is idempotent: a replay changes nothing and appends nothing', async () => {
    const w = world();
    await w.provisioning.provisionCase(create);
    expect(await w.provisioning.provisionCase(create)).toMatchObject({ kind: 'provisioned', repeated: true });
    expect(w.cases()).toHaveLength(1);
    expect(w.events).toHaveLength(1);
  });
  it('keeps the case id and title immutable: another title conflicts and nothing changes', async () => {
    const w = world();
    await w.provisioning.provisionCase(create);
    const appends = w.audit.appends;
    expect(await w.provisioning.provisionCase({ ...create, title: 'Renamed' })).toEqual({ kind: 'conflict', reason: 'title-differs' });
    expect(w.cases()).toEqual([{ case_id: 'case-1', case_label: 'Synthetic empty case' }]);
    expect(w.audit.appends).toBe(appends);
  });
  it.each([
    [{ caseId: '' }], [{ caseId: 'a:b' }], [{ caseId: '../x' }], [{ caseId: 'x'.repeat(97) }], [{ caseId: "a'; DROP TABLE rs_case;--" }], [{ caseId: 12 }],
    [{ title: '' }], [{ title: ' padded ' }], [{ title: 'bell\u0007' }], [{ title: 'rtl\u202eevil' }], [{ title: 'x'.repeat(201) }], [{ title: 'lone\ud800' }], [{ title: 5 }],
    [{ operator: '' }], [{ operator: 'staff user' }], [{ operator: 'x'.repeat(129) }],
  ])('refuses invalid input %j before reading or writing anything', async (over) => {
    const w = world();
    const result = await w.provisioning.provisionCase({ ...create, ...over } as never);
    expect(result).toMatchObject({ kind: 'invalid' });
    expect(w.hooks.statements).toEqual([]);
    expect(w.audit.appends).toBe(0);
  });
  it.each([
    ['an unbound database', null],
    ['a database bound to another client', { client: 'client-c' }],
    ['a database in another layout', { client: 'client-a', layout: 'other/1' }],
  ])('writes nothing and audits nothing into %s', async (_, identity) => {
    const w = world({ identity });
    expect(await w.provisioning.provisionCase(create)).toEqual({ kind: 'refused', reason: 'storage-identity' });
    expect(w.cases()).toEqual([]);
    expect(w.audit.appends).toBe(0);
  });
  it('cannot be given an actor: the audit actor is always the system, whatever the input names', async () => {
    const w = world();
    await w.provisioning.provisionCase({ ...create, actor: { kind: 'verified', principal: client('user_a'), sessionId: SESSION }, principal: client('user_a'), sessionId: SESSION } as never);
    expect(w.events[0]!.actor).toEqual(SYSTEM);
    expect(JSON.stringify(w.events)).not.toMatch(/verified|principal|sessionId|user_a/);
  });
  it('refuses to construct without an audit port that can find, so a lost acknowledgement is provable', () => {
    const w = world();
    expect(() => createCaseProvisioning({ deployment, db: w.binding, audit: { append: w.port.append } as never, now: () => NOW })).toThrow(TypeError);
  });
  it('leaves the row and reports audit-pending when the audit log is down, and a replay completes it once', async () => {
    const w = world();
    w.audit.fails = true;
    expect(await w.provisioning.provisionCase(create)).toEqual({ kind: 'audit-pending', caseId: 'case-1', retryable: true });
    expect(w.cases()).toHaveLength(1);
    expect(w.events).toEqual([]);
    w.audit.fails = false;
    expect(await w.provisioning.provisionCase({ ...create, operator: 'run-2' })).toMatchObject({ kind: 'provisioned', repeated: true });
    expect(w.events).toHaveLength(1);
    expect(w.events[0]!.actor).toEqual({ ...SYSTEM, operator: 'run-2' });
    expect(await w.provisioning.provisionCase(create)).toMatchObject({ kind: 'provisioned' });
    expect(w.events).toHaveLength(1);
  });
  it('treats a lost acknowledgement as success only when the event reads back, and unreadable as pending', async () => {
    const lost = world();
    lost.audit.lostAck = true;
    expect(await lost.provisioning.provisionCase(create)).toMatchObject({ kind: 'provisioned' });
    expect(lost.events).toHaveLength(1);
    const blind = world();
    blind.audit.lostAck = true; blind.audit.findFails = true;
    expect(await blind.provisioning.provisionCase(create)).toMatchObject({ kind: 'audit-pending' });
  });
  it('refuses a different event already stored under the case event id', async () => {
    const w = world();
    w.events.push({ eventId: 'case-provision:case-1', actor: SYSTEM, action: 'case.withdraw', object: { kind: 'case', id: 'case-1', caseId: 'case-1' as never }, version: null, outcome: 'succeeded', at: NOW.toISOString() } as SystemAuditEvent);
    expect(await w.provisioning.provisionCase(create)).toEqual({ kind: 'conflict', reason: 'audit-mismatch' });
    w.events.length = 0;
    w.events.push({ eventId: 'case-provision:case-1', actor: { kind: 'verified', principal: client('user_a'), sessionId: SESSION }, action: 'case.provision', object: { kind: 'case', id: 'case-1', caseId: 'case-1' as never }, version: null, outcome: 'succeeded', at: NOW.toISOString() } as never);
    expect(await w.provisioning.provisionCase({ ...create, caseId: 'case-1' })).toEqual({ kind: 'conflict', reason: 'audit-mismatch' });
  });
  it('is safe when concurrent identical calls race: one row, one event, both succeed', async () => {
    const w = world();
    const results = await Promise.all([w.provisioning.provisionCase(create), w.provisioning.provisionCase({ ...create, operator: 'run-2' })]);
    expect(results.map((r) => r.kind)).toEqual(['provisioned', 'provisioned']);
    expect(w.cases()).toHaveLength(1);
    expect(w.events).toHaveLength(1);
  });
  it('resolves a lost insert race by what is stored: the same title replays, another title conflicts', async () => {
    const rival = (title: string) => { const w = world(); w.hooks.beforeInsert = () => { w.db.prepare("INSERT INTO rs_case (case_id, case_label) VALUES ('case-1', ?)").run(title); }; return w; };
    const same = rival(create.title);
    expect(await same.provisioning.provisionCase(create)).toMatchObject({ kind: 'provisioned' });
    expect(same.cases()).toHaveLength(1);
    const other = rival('Someone else');
    expect(await other.provisioning.provisionCase(create)).toEqual({ kind: 'conflict', reason: 'title-differs' });
    expect(other.cases()).toEqual([{ case_id: 'case-1', case_label: 'Someone else' }]);
    expect(other.audit.appends).toBe(0);
  });
  it('surfaces a storage fault as storage-unavailable and writes nothing', async () => {
    const w = world();
    w.hooks.failSql = /^\s*INSERT INTO rs_case/;
    await expect(w.provisioning.provisionCase(create)).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
    expect(w.cases()).toEqual([]);
    expect(w.audit.appends).toBe(0);
  });
  it('writes an event the real provisioning audit log accepts, canonically, and finds it again', async () => {
    const w = world();
    const adb = new DatabaseSync(':memory:');
    adb.exec(AUDIT);
    const store = d1(adb, { statements: [], failSql: null, beforeInsert: null });
    const config = auditConfig({ clientId: 'client-a', trustedIssuers: [ISSUER_A, ISSUER_STAFF], limits: { maxEventBytes: 2048, maxRows: 1000, maxReadRows: 1000, maxDenialRows: 100, maxDenialsPerActor: 8, maxPageRows: 50, maxPagesPerRequest: 5 } });
    // The real log's inserts are batches; give it a transactional batch over the same stand-in.
    const batching: D1 = { ...store, batch: async (all) => { adb.exec('BEGIN'); try { const out = []; for (const s of all) out.push(await s.run()); adb.exec('COMMIT'); return out; } catch (e) { adb.exec('ROLLBACK'); throw e; } } };
    await provisionAuditBinding({ db: batching, config, now: () => NOW });
    const real = provisioningAuditPort({ db: batching, config, now: () => NOW });
    const p = createCaseProvisioning({ deployment, db: w.binding, audit: real, now: () => NOW });
    expect(await p.provisionCase(create)).toMatchObject({ kind: 'provisioned', repeated: false });
    expect(await p.provisionCase(create)).toMatchObject({ kind: 'provisioned', repeated: true });
    expect((adb.prepare('SELECT count(*) AS n FROM native_audit_events').get() as { n: number }).n).toBe(1);
    expect(await real.find('case-provision:case-1')).toMatchObject({ actor: SYSTEM, action: 'case.provision' });
  });
  it('is not part of the tenancy index, so the hosted graph cannot reach it by that door', () => {
    const index = readFileSync(new URL('../../../src/lib/tenancy/index.ts', import.meta.url), 'utf8');
    expect(index).not.toMatch(/case-provisioning/);
    expect(read('tenancy/case-directory.ts')).not.toMatch(/INSERT|UPDATE|DELETE|batch/i);
  });
});
