// The entry the native-import contract tests drive: the real hosted route modules under deploy/client/routes/operator/results,
// with the ports installed through the module's composition point exactly as the parent composition will install them.
// The ports themselves are unit doubles (doubles.ts); the RED commit pointed `dispatch` at the hosted fallback route.
import path from 'node:path';
import * as imports from '../../../deploy/client/routes/operator/results/[caseId]/imports/+server.ts';
import * as candidates from '../../../deploy/client/routes/operator/results/[caseId]/candidates/+server.ts';
import * as candidate from '../../../deploy/client/routes/operator/results/[caseId]/candidates/[candidateId]/+server.ts';
import * as corrections from '../../../deploy/client/routes/operator/results/[caseId]/candidates/[candidateId]/corrections/+server.ts';
import { d1NativeCandidateRepository, setNativeImportComposition, submissionSnapshotReader, type NativeD1, type NativeImportPorts } from '../../../src/lib/results-review/native/index.ts';
import { AuditRecorder, CASE_A, CLIENT, NOW, SqliteD1, StoredPackages, ValidatingStager, operateAuthority, type OperateCall } from './doubles.ts';
import type { CaseId } from '../../../src/lib/server/runtime/contracts.ts';

const root = path.join(import.meta.dirname, '../../..');
const migration = (p: string) => path.join(root, p);
export const MIGRATIONS: readonly string[] = [
  migration('src/lib/submissions/migrations/0001_submissions_intake.sql'),
  migration('src/lib/submissions/migrations/0002_submissions_file_sets.sql'),
  migration('src/lib/results-review/native/migrations/0001_native_candidate_import.sql'),
];

export type Route = 'imports' | 'candidates' | 'candidate' | 'corrections';
export interface RouteEvent { request: Request; url: URL; params: Record<string, string>; locals: { identity: unknown } }
export interface World {
  db: SqliteD1; audit: AuditRecorder; stager: ValidatingStager; packages: StoredPackages; operateCalls: OperateCall[];
  ports: Record<string, unknown>;
}
export const BUDGET = { maxRequestBytes: 1 << 20, maxFiles: 16, maxFileBytes: 512 << 10, maxPackageBytes: 1 << 20 };

export function world(o: { operate?: readonly CaseId[]; null?: string | null; budget?: typeof BUDGET | null; configured?: boolean; submissions?: unknown } = {}): World {
  const db = new SqliteD1(MIGRATIONS), audit = new AuditRecorder(), stager = new ValidatingStager(), packages = new StoredPackages(stager), operateCalls: OperateCall[] = [];
  const ports: Record<string, unknown> = {
    clientId: CLIENT, budget: o.budget === undefined ? BUDGET : o.budget, authorizeOperate: operateAuthority(o.operate ?? [CASE_A], operateCalls),
    stager, packages, audit, now: () => new Date(NOW),
    submissions: o.submissions ?? submissionSnapshotReader(db),
    repository: d1NativeCandidateRepository(db as unknown as NativeD1),
  };
  if (o.null) ports[o.null] = null;
  compose(o.configured === false ? null : ports);
  return { db, audit, stager, packages, operateCalls, ports };
}

export function compose(ports: Record<string, unknown> | null): void { setNativeImportComposition(ports ? () => ports as unknown as NativeImportPorts : null); }
export async function dispatch(route: Route, method: string, event: RouteEvent): Promise<Response> {
  const modules = { imports, candidates, candidate, corrections } as unknown as Record<Route, Record<string, ((e: never) => Promise<Response>) | undefined>>;
  const h = modules[route][method];
  if (!h) return new Response(null, { status: 405 });
  return h({ ...event, platform: undefined } as never);
}
