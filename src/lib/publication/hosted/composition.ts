import type { NativePublicationPorts } from './ports.ts';
import { createNativePublication, type PublicationController } from './controller.ts';

/**
 * The one point where the parent composition installs the publication ports (GRS-114 publish authority, the candidate
 * reader, GRS-115's storage publisher, this module's D1 ledger over the client's `DB`, the request audit sink). Until it
 * does, every publication route answers 503 `publication-unavailable`: nothing here supplies a default, a double or an allow.
 * The composition returns null when anything it needs is missing; a throw is treated as null.
 */
export type PublicationComposition = (a: { request: Request; platform: unknown }) => NativePublicationPorts | null | Promise<NativePublicationPorts | null>;
let composition: PublicationComposition | null = null;

export function setPublicationComposition(c: PublicationComposition | null): void { composition = c; }

/** The controller for one request: composed ports, or the unconfigured controller that refuses with 503. */
export async function publicationControllerFor(a: { request: Request; platform: unknown }): Promise<PublicationController> {
  let ports: NativePublicationPorts | null = null;
  if (composition) { try { ports = await composition(a); } catch { ports = null; } }
  return createNativePublication(ports);
}
