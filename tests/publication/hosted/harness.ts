// Drives the real hosted route modules under deploy/client/routes/operator/publication with ports installed through the
// module's composition point, exactly as the parent composition will install them. The ports are unit doubles.
import * as signoffs from '../../../deploy/client/routes/operator/publication/[caseId]/signoffs/+server.ts';
import * as publish from '../../../deploy/client/routes/operator/publication/[caseId]/publish/+server.ts';
import * as withdraw from '../../../deploy/client/routes/operator/publication/[caseId]/withdraw/+server.ts';
import { d1PublicationLedger, setPublicationComposition, type NativePublicationPorts, type PublicationD1 } from '../../../src/lib/publication/hosted/index.ts';

export type Route = 'signoffs' | 'publish' | 'withdraw';
export const ROUTES: Record<Route, Record<string, unknown>> = { signoffs, publish, withdraw };
export function compose(ports: NativePublicationPorts | null): void { setPublicationComposition(ports ? () => ports : null); }
export const ledgerFor = (db: unknown) => d1PublicationLedger(db as PublicationD1);
export async function dispatch(route: Route, event: { request: Request; url: URL; params: Record<string, string>; locals: { identity: unknown } }): Promise<Response> {
  const h = ROUTES[route][event.request.method] as ((e: never) => Promise<Response>) | undefined;
  if (typeof h !== 'function') return new Response(null, { status: 405 });
  return h({ ...event, platform: undefined } as never);
}
