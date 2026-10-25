import type { OperatorDownloadPorts } from './ports.ts';
import { createOperatorDownloadController, type OperatorDownloadController } from './controller.ts';

/**
 * The one point where the parent composition installs the operator download ports (the `operate` capability, the intake's
 * D1 repository over the client's `DB`, the assets service, the audit sink). Until it does, every operator submission
 * route answers 503 `operator-download-unavailable`. The composition runs per request, so it can bind the request's own
 * services; it returns null when anything it needs is missing.
 */
export type OperatorDownloadComposition = (a: { request: Request; platform: unknown }) => OperatorDownloadPorts | null | Promise<OperatorDownloadPorts | null>;
let composition: OperatorDownloadComposition | null = null;

export function setOperatorDownloadComposition(c: OperatorDownloadComposition | null): void { composition = c; }

export async function operatorDownloadControllerFor(a: { request: Request; platform: unknown }): Promise<OperatorDownloadController> {
  let ports: OperatorDownloadPorts | null = null;
  if (composition) { try { ports = await composition(a); } catch { ports = null; } }
  return createOperatorDownloadController(ports);
}
