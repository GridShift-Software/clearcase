// The entry the native-import contract tests drive. The RED commit pointed `dispatch` at the existing hosted fallback route
// (`deploy/client/routes/[...path]`, 503 for everything), so every test failed on an assertion; this file is the only
// thing that changes between RED and the implementation. The ports themselves are unit doubles (doubles.ts).
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as fallback from '../../../deploy/client/routes/[...path]/+server.ts';
import { AuditRecorder, CASE_A, CLIENT, NOW, SqliteD1, StoredPackages, ValidatingStager, operateAuthority, type OperateCall } from './doubles.ts';
import type { CaseId } from '../../../src/lib/server/runtime/contracts.ts';

const root = path.join(import.meta.dirname, '../../..');
const migration = (p: string) => path.join(root, p);
export const MIGRATIONS: readonly string[] = [
  migration('src/lib/submissions/migrations/0001_submissions_intake.sql'),
  migration('src/lib/results-review/native/migrations/0001_native_candidate_import.sql'),
].filter((m) => existsSync(m));

export type Route = 'imports' | 'candidates' | 'candidate' | 'corrections';
export interface RouteEvent { request: Request; url: URL; params: Record<string, string>; locals: { identity: unknown } }
export interface World {
  db: SqliteD1; audit: AuditRecorder; stager: ValidatingStager; packages: StoredPackages; operateCalls: OperateCall[];
  ports: Record<string, unknown>;
}
export const BUDGET = { maxRequestBytes: 1 << 20, maxFiles: 16, maxFileBytes: 512 << 10, maxPackageBytes: 1 << 20 };

export function world(o: { operate?: readonly CaseId[]; null?: string | null; budget?: typeof BUDGET | null; configured?: boolean; submissions?: unknown } = {}): World {
  const db = new SqliteD1(MIGRATIONS);
  redSchema(db);
  const audit = new AuditRecorder(), stager = new ValidatingStager(), packages = new StoredPackages(stager), operateCalls: OperateCall[] = [];
  const ports: Record<string, unknown> = {
    clientId: CLIENT, budget: o.budget === undefined ? BUDGET : o.budget, authorizeOperate: operateAuthority(o.operate ?? [CASE_A], operateCalls),
    stager, packages, audit, now: () => new Date(NOW),
  };
  if (o.submissions) ports.submissions = o.submissions;
  if (o.null) ports[o.null] = null;
  compose(db, o.configured === false ? null : ports);
  return { db, audit, stager, packages, operateCalls, ports };
}

/** RED only: empty, trigger-free tables so the row assertions run; the implementation commit deletes this and ships the real migration. */
function redSchema(db: SqliteD1) {
  for (const t of ['native_import_attempt', 'native_candidate', 'native_import_link', 'native_candidate_supersession', 'native_correction_change']) db.sqlite.exec(`CREATE TABLE IF NOT EXISTS ${t} (x TEXT)`);
}

/** RED: nothing is composed; the fallback answers 503. */
export function compose(_db: SqliteD1, _ports: Record<string, unknown> | null): void {}
export async function dispatch(_route: Route, method: string, event: RouteEvent): Promise<Response> {
  const h = (fallback as unknown as Record<string, (e: never) => Promise<Response>>)[method];
  return h({ ...event, platform: undefined } as never);
}
