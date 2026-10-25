import type { Identity } from '../../server/runtime/contracts.ts';
import type { NativePublicationPorts } from './ports.ts';

// RED skeleton: a naive controller that answers success for every request once ports exist. The adverse tests describe
// why this is wrong; the implementation replaces it.
export interface PublicationRequest { request: Request; url: URL; params: Partial<Record<'caseId', string>>; identity: Identity }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createNativePublication(ports: NativePublicationPorts | null) {
  const ok = (status: number) => async (_r: PublicationRequest) => (ports ? json(status, { ok: true }) : json(503, { code: 'publication-unavailable' }));
  return { signOff: ok(201), publish: ok(200), withdraw: ok(200) };
}
export type PublicationController = ReturnType<typeof createNativePublication>;
