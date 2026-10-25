// The entry the operator download contract tests drive: the real hosted route modules under deploy/client/routes/operator,
// with the ports installed through the module's composition point exactly as the parent composition will install them.
import * as list from '../../../deploy/client/routes/operator/submissions/[caseId]/finalized/+server.ts';
import * as one from '../../../deploy/client/routes/operator/submissions/[caseId]/finalized/[operationId]/+server.ts';
import * as manifest from '../../../deploy/client/routes/operator/submissions/[caseId]/finalized/[operationId]/manifest/+server.ts';
import * as download from '../../../deploy/client/routes/operator/submissions/[caseId]/finalized/[operationId]/download/+server.ts';
import { setOperatorDownloadComposition, type OperatorDownloadPorts } from '../../../src/lib/submissions/download/index.ts';

export type Route = 'list' | 'view' | 'manifest' | 'download';
export interface RouteEvent { request: Request; url: URL; params: Record<string, string>; locals: { identity: unknown } }
export function compose(ports: unknown): void { setOperatorDownloadComposition(ports ? () => ports as OperatorDownloadPorts : null); }
export async function dispatch(route: Route, method: 'GET' | 'HEAD', event: RouteEvent): Promise<Response> {
  const mod = { list, view: one, manifest, download }[route] as Record<string, ((e: never) => Promise<Response>) | undefined>;
  const h = mod[method];
  if (!h) return new Response(null, { status: 405 });
  return h({ ...event, platform: undefined } as never);
}
