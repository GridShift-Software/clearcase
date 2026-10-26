// Synthetic SQLite behind D1's shape, with real storage/grant/audit schemas and adapters. Not live D1 evidence.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished } from 'vitest';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisioningAuditPort } from '../../../src/lib/audit/provisioning.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import type { D1, D1Statement } from '../../../src/lib/server/runtime/hosted/bindings.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { createCaseProvisioning } from '../../../src/lib/tenancy/case-provisioning.ts';
import { createCaseGrantProvisioning, type CaseGrantProvisioningOptions } from '../../../src/lib/tenancy/case-grant-provisioning.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';

const read = (p: string) => readFileSync(new URL(`../../../src/lib/${p}`, import.meta.url), 'utf8');
const SCHEMA = ['storage/cloud/migrations/0001_rs_results_storage.sql', 'tenancy/migrations/0001_tenant_case_grants.sql', 'tenancy/migrations/0002_tenant_grant_operations.sql', 'audit/migrations/0001_native_audit.sql'].map(read).join('\n');
export const ISSUER_A = 'https://client-a.example.test', ISSUER_C = 'https://client-c.example.test', ISSUER_STAFF = 'https://staff.example.test';
const tuple = (n: 'a' | 'c') => ({ clientId: `client-${n}`, hostname: `${n}.clearcase.example.test`, worker: `clearcase-client-${n}`, d1DatabaseId: `00000000-0000-4000-8000-00000000000${n}`, d1DatabaseName: `clearcase-client-${n}`, r2Bucket: `clearcase-client-${n}` });
const manifest = validateClientManifest({ staffIssuer: ISSUER_STAFF, clients: [{ ...tuple('a'), clientIssuer: ISSUER_A }, { ...tuple('c'), clientIssuer: ISSUER_C }] });
export const CASE_1 = id('case', 'case-1'), CASE_2 = id('case', 'case-2');
export const ALICE = { issuer: ISSUER_A, subject: 'user_alice', kind: 'client' } as const;
export const STAFF = { issuer: ISSUER_STAFF, subject: 'user_staff', kind: 'staff' } as const;
export const INPUT = { operator: 'alpha-seed-1', operationId: 'case-grant-1', target: ALICE, caseId: CASE_1, role: 'viewer', expiresAt: null } as const;

type Hooks = { sql: string[]; failSql: RegExp | null; failGrantBatch: boolean; loseGrantBatchAck: boolean; loseAuditAppendAck: boolean; hideAuditAfterCommit: boolean; auditCommitted: boolean };
function binding(database: () => DatabaseSync, h: Hooks): D1 {
  const runs = new WeakMap<D1Statement, { run: () => unknown; sql: string }>();
  const check = (sql: string) => {
    h.sql.push(sql);
    if (h.failSql?.test(sql) || (h.hideAuditAfterCommit && h.auditCommitted && /SELECT .* FROM native_audit_events WHERE client_id = \? AND event_id = \?/.test(sql))) throw new Error('D1_ERROR: network unavailable');
  };
  const statement = (sql: string, values: (string | number | null)[] = []): D1Statement => {
    const run = () => {
      check(sql);
      const result = database().prepare(sql).run(...values);
      // The real audit adapter autocommits one INSERT with run(), not batch(). Lose that acknowledgement only.
      if (h.loseAuditAppendAck && /INSERT INTO native_audit_events/.test(sql)) { h.auditCommitted = true; throw new Error('D1_ERROR: lost acknowledgement'); }
      return result;
    };
    const s: D1Statement = {
      bind: (...next) => statement(sql, next),
      first: async <T>() => { check(sql); return (database().prepare(sql).get(...values) as T | undefined) ?? null; },
      all: async <T>() => { check(sql); return { results: database().prepare(sql).all(...values) as T[] }; },
      run: async () => run(),
    };
    runs.set(s, { run, sql });
    return s;
  };
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const all = statements.map((s) => { const run = runs.get(s); if (!run) throw new Error('unknown statement'); return run; });
      const grants = all.some((s) => /INSERT INTO tenant_case_grants/.test(s.sql));
      if (grants && h.failGrantBatch) throw new Error('D1_ERROR: network unavailable');
      // Synchronous SQL inside one transaction, no JavaScript await inside it. Competing batches cannot nest.
      const db = database();
      db.exec('BEGIN IMMEDIATE');
      let out: unknown[];
      try { out = all.map((s) => s.run()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (grants && h.loseGrantBatchAck) throw new Error('D1_ERROR: lost acknowledgement');
      return out;
    },
  };
}

export async function world(n: 'a' | 'c' = 'a') {
  const dir = mkdtempSync(join(tmpdir(), 'clearcase-case-grant-'));
  let sqlite = new DatabaseSync(join(dir, 'synthetic.sqlite'));
  onTestFinished(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }); });
  sqlite.exec(`PRAGMA foreign_keys = ON; ${SCHEMA}`);
  sqlite.prepare('INSERT INTO rs_storage_identity (singleton, client_id, layout) VALUES (1, ?, ?)').run(`client-${n}`, 'clearcase.rs/1');
  const hooks: Hooks = { sql: [], failSql: null, failGrantBatch: false, loseGrantBatchAck: false, loseAuditAppendAck: false, hideAuditAfterCommit: false, auditCommitted: false };
  const db = binding(() => sqlite, hooks), deployment = resolveExactDeployment(manifest, tuple(n));
  let clock = new Date('2026-10-25T10:00:00.000Z');
  const now = () => new Date(clock);
  const config = auditConfig({ clientId: deployment.clientId, trustedIssuers: [deployment.clientIssuer, deployment.staffIssuer], limits: { maxEventBytes: 2048, maxRows: 1000, maxReadRows: 1000, maxDenialRows: 100, maxDenialsPerActor: 8, maxPageRows: 50, maxPagesPerRequest: 5 } });
  await provisionAuditBinding({ db, config, now });
  const audit = provisioningAuditPort({ db, config, now });
  const cases = d1CaseDirectory({ db, deployment }), grants = d1GrantRepository(db);
  const caseProvisioning = createCaseProvisioning({ deployment, db, audit, now });
  for (const caseId of [CASE_1, CASE_2]) {
    const made = await caseProvisioning.provisionCase({ operator: 'fixture-case-setup', caseId, title: `Synthetic ${caseId}` });
    if (made.kind !== 'provisioned') throw new Error('synthetic case setup failed');
  }
  const options: CaseGrantProvisioningOptions = { deployment, grants, cases, audit, now };
  const make = (over: Partial<CaseGrantProvisioningOptions> = {}) => createCaseGrantProvisioning({ ...options, ...over });
  hooks.sql.length = 0;
  return {
    get sqlite() { return sqlite; }, db, hooks, deployment, grants, cases, audit, now, options, make,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    restart: () => { sqlite.close(); sqlite = new DatabaseSync(join(dir, 'synthetic.sqlite')); sqlite.exec('PRAGMA foreign_keys = ON'); return make({ audit: provisioningAuditPort({ db, config, now }) }); },
    grantRows: () => sqlite.prepare('SELECT * FROM tenant_case_grants').all(),
    operationRows: () => sqlite.prepare('SELECT * FROM tenant_grant_operations').all(),
    auditRows: () => sqlite.prepare("SELECT * FROM native_audit_events WHERE event_id LIKE 'grant-op:%'").all(),
    writes: () => hooks.sql.filter((sql) => /^(INSERT|UPDATE|DELETE)/i.test(sql.trim())),
  };
}
