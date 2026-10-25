import { createNativeImportController, type NativeImportController } from './controller.ts';
import { createNativeResultsImport } from './service.ts';
import type { NativeImportPorts } from './ports.ts';

/**
 * The one point where the parent composition installs the import ports (identity operate capability, the injected real
 * validator/stager, the D1 repository over the client's `DB`, the trusted budget, audit). Until it does, and whenever any
 * required port is missing, every route answers 503 `import-unavailable`: nothing here supplies a default, a double or a
 * pass. It returns null when anything it needs is missing.
 */
export type NativeImportComposition = (a: { request: Request; platform: unknown }) => NativeImportPorts | null | Promise<NativeImportPorts | null>;
let composition: NativeImportComposition | null = null;

export function setNativeImportComposition(c: NativeImportComposition | null): void { composition = c; }

/** The controller for one request: composed ports, or the unconfigured controller that refuses with 503. */
export async function nativeImportControllerFor(a: { request: Request; platform: unknown }): Promise<NativeImportController> {
  let ports: NativeImportPorts | null = null;
  if (composition) { try { ports = await composition(a); } catch { ports = null; } }
  return createNativeImportController(createNativeResultsImport(ports));
}
