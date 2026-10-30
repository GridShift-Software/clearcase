// The entry the intake contract tests drive: the real hosted route modules under deploy/client/routes/client/intake,
// with the ports installed through the module's composition point exactly as the parent composition will install them.
// The ports themselves are unit doubles (doubles.ts); the RED commit pointed this file at the hosted fallback route.
import path from 'node:path';
import * as list from '../../../deploy/client/routes/client/intake/[caseId]/submissions/+server.ts';
import * as one from '../../../deploy/client/routes/client/intake/[caseId]/submissions/[operationId]/+server.ts';
import * as sets from '../../../deploy/client/routes/client/intake/[caseId]/sets/+server.ts';
import * as set from '../../../deploy/client/routes/client/intake/[caseId]/sets/[setId]/+server.ts';
import * as setFiles from '../../../deploy/client/routes/client/intake/[caseId]/sets/[setId]/files/+server.ts';
import * as setFile from '../../../deploy/client/routes/client/intake/[caseId]/sets/[setId]/files/[operationId]/+server.ts';
import * as seal from '../../../deploy/client/routes/client/intake/[caseId]/sets/[setId]/seal/+server.ts';
import { d1SubmissionRepository, setIntakeComposition, type IntakeD1, type IntakePorts } from '../../../src/lib/submissions/index.ts';

const migration = (file: string) => path.join(import.meta.dirname, '../../../src/lib/submissions/migrations', file);
/** The schema before file sets (0001 alone), and the schema every deployment now holds (0001 then 0002). */
export const MIGRATIONS_0001: readonly string[] = [migration('0001_submissions_intake.sql')];
export const MIGRATIONS: readonly string[] = [...MIGRATIONS_0001, migration('0002_submissions_file_sets.sql')];
export type Route = 'submissions' | 'submission' | 'sets' | 'set' | 'set-files' | 'set-file' | 'set-seal';
export interface RouteEvent { request: Request; url: URL; params: Record<string, string>; locals: { identity: unknown } }

export function compose(ports: unknown): void { setIntakeComposition(ports ? () => ports as IntakePorts : null); }
export function repositoryFor(db: unknown) { return d1SubmissionRepository(db as IntakeD1); }
const methodNotAllowed = async (): Promise<Response> => new Response(null, { status: 405 });
export async function dispatch(route: Route, method: 'GET' | 'POST' | 'PUT', event: RouteEvent): Promise<Response> {
  const table: Record<Route, Record<string, ((e: never) => Promise<Response>) | undefined>> = {
    submissions: { GET: list.GET, POST: list.POST }, submission: { GET: one.GET, PUT: one.PUT },
    sets: { POST: sets.POST }, set: { GET: set.GET }, 'set-files': { POST: setFiles.POST }, 'set-file': { PUT: setFile.PUT }, 'set-seal': { POST: seal.POST },
  };
  const handlers = table[route];
  const h = handlers[method] ?? methodNotAllowed;
  return h({ ...event, platform: undefined } as never);
}
