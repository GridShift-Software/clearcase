// The entry the intake contract tests drive: the real hosted route modules under deploy/client/routes/client/intake,
// with the ports installed through the module's composition point exactly as the parent composition will install them.
// The ports themselves are unit doubles (doubles.ts); the RED commit pointed this file at the hosted fallback route.
import path from 'node:path';
import * as list from '../../../deploy/client/routes/client/intake/[caseId]/submissions/+server.ts';
import * as one from '../../../deploy/client/routes/client/intake/[caseId]/submissions/[operationId]/+server.ts';
import { d1SubmissionRepository, setIntakeComposition, type IntakeD1, type IntakePorts } from '../../../src/lib/submissions/index.ts';

export const MIGRATIONS: readonly string[] = [path.join(import.meta.dirname, '../../../src/lib/submissions/migrations/0001_submissions_intake.sql')];
export type Route = 'submissions' | 'submission';
export interface RouteEvent { request: Request; url: URL; params: Record<string, string>; locals: { identity: unknown } }

export function compose(ports: unknown): void { setIntakeComposition(ports ? () => ports as IntakePorts : null); }
export function repositoryFor(db: unknown) { return d1SubmissionRepository(db as IntakeD1); }
const methodNotAllowed = async (): Promise<Response> => new Response(null, { status: 405 });
export async function dispatch(route: Route, method: 'GET' | 'POST' | 'PUT', event: RouteEvent): Promise<Response> {
  const handlers: Record<string, ((e: never) => Promise<Response>) | undefined> = route === 'submissions' ? { GET: list.GET, POST: list.POST } : { GET: one.GET, PUT: one.PUT };
  const h = handlers[method] ?? methodNotAllowed;
  return h({ ...event, platform: undefined } as never);
}
