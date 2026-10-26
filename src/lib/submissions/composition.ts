import type { IntakePorts } from './ports.ts';
import { createIntakeController, type IntakeController } from './controller.ts';

/**
 * The one point where the parent composition installs the intake ports (identity capability, GRS-115 original intake,
 * this module's D1 repository over the client's `DB`, the trusted budget). Until it does, every intake route answers 503
 * `intake-unavailable`: nothing here supplies a default, a double or a pass. The composition receives the request's
 * platform so it can read the Worker's bindings; it returns null when anything it needs is missing.
 */
export type IntakeComposition = (a: { request: Request; platform: unknown }) => IntakePorts | null | Promise<IntakePorts | null>;
let composition: IntakeComposition | null = null;

export function setIntakeComposition(c: IntakeComposition | null): void { composition = c; }

/** The controller for one request: composed ports, or the unconfigured controller that refuses with 503. */
export async function intakeControllerFor(a: { request: Request; platform: unknown }): Promise<IntakeController> {
  let ports: IntakePorts | null = null;
  if (composition) { try { ports = await composition(a); } catch { ports = null; } }
  return createIntakeController(ports);
}
