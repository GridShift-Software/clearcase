import type { AssetsAccess, CaseId, CaseReader, CaseRevision, ClientId, Identity, ResultsVersion, Scope } from '../../server/runtime/contracts.ts';
import type { CloudBindings } from '../../storage/cloud/bindings.ts';
import type { StorageBudgets } from '../../storage/cloud/budgets.ts';
import { createUnavailableServices } from '../../server/runtime/unavailable.ts';

/** One protected storage event, appended through the audit owner's sink (GRS-116) by the composing caller. */
export interface StorageEvent { action: string; object: { kind: string; id: string; caseId: CaseId | null }; version: ResultsVersion | null; outcome: 'succeeded' | 'denied' | 'failed' | 'refused' }
export interface CloudResultsOptions {
  bindings: CloudBindings | null;
  /** The deployment's client, from trusted configuration only. */
  clientId: ClientId | null;
  budgets: StorageBudgets | null;
  identity: Identity;
  record(e: StorageEvent): Promise<void>;
  /** The user-work revision of a case, owned by GRS-117. */
  stateRevision(a: Scope): Promise<CaseRevision>;
}
export function createCloudResults(o: CloudResultsOptions): { store: CaseReader; assets: AssetsAccess } {
  const u = createUnavailableServices({ clientId: o.identity.clientId, now: () => new Date() });
  return { store: u.store, assets: u.assets };
}
