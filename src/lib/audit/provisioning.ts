// GRS-114 provisioning-only audit entry point. Import it ONLY from trusted, non-request provisioning (the grant-admin
// bootstrap job), never from a route, a feature module, UI code or the hosted service composer. It is the only way to
// record a system actor (kind 'system'): every request port (requestAuditSink, the grant port, the public reader and the
// full log) refuses one, and the hosted import guard (scripts/ci/hosted-imports.ts) fails any hosted-graph edge to this
// file, whoever the importer is and however it is re-exported or dynamically imported.
import type { SystemAuditEvent } from '../server/runtime/contracts.ts';
import type { D1 } from '../server/runtime/hosted/bindings.ts';
import type { AuditConfig } from './config.ts';
import { provisioningCore, type ProvisioningLog } from './d1-log.ts';

/** What the bootstrap may hold: append a system event (canonical bytes, duplicate-conflict and lost-ack rules as for any event) and find one. */
export type ProvisioningAuditPort = Readonly<ProvisioningLog>;
export type { SystemAuditEvent };

export function provisioningAuditPort(a: { db: D1; config: AuditConfig; now: () => Date }): ProvisioningAuditPort {
  return provisioningCore(a);
}
